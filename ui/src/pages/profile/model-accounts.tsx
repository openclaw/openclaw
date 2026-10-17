import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { modelAuthEventInvalidates } from "../../lib/model-auth-request-state.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { ModelAccountsSection } from "./model-accounts-section.tsx";
import { ModelAccountsState, type ModelAccountsProps } from "./model-accounts-state.ts";

registerEnglishCatalog(registerModelAccountsEnglish);

export function ModelAccounts(props: ModelAccountsProps) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const state = new ModelAccountsState(context, props, () => setRevision((value) => value + 1));
  // Snapshot identity/profile at request admission; target changes retire account reads and auth polls.
  const sync = () => {
    untrack(() => state.applySnapshot(context.gateway.snapshot));
    state.publish();
  };
  // Retire account reads and auth polls synchronously with connection authority.
  const stopGateway = context.gateway.subscribe(sync);
  const stopEvents = context.gateway.subscribeEvents((event) => {
    if (modelAuthEventInvalidates(event)) {
      void state.loadAccounts();
    }
  });
  createEffect(() => [props.identityId, props.profileId], sync);
  sync();
  const readState = () => {
    revision();
    return state;
  };
  onCleanup(() => {
    stopEvents();
    stopGateway();
    state.dispose();
  });
  return (
    <openclaw-model-accounts>
      <Show when={readState().target || readState().context.gateway.snapshot.phase === "connected"}>
        <ModelAccountsSection readState={readState} />
      </Show>
    </openclaw-model-accounts>
  );
}
