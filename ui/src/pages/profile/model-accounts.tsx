import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { modelAuthEventInvalidates } from "../../lib/model-auth-request-state.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { ModelAccountsSection } from "./model-accounts-section.tsx";
import { ModelAccountsState, type ModelAccountsProps } from "./model-accounts-state.ts";

registerEnglishCatalog(registerModelAccountsEnglish);

function ModelAccountsContent(props: ModelAccountsProps) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const state = new ModelAccountsState(context, props, () => setRevision((value) => value + 1));
  const sync = () => {
    untrack(() => state.applySnapshot(context.gateway.snapshot));
    state.publish();
  };
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
    <Show
      when={
        readState().context.gateway.snapshot.phase === "connected" &&
        readState().context.gateway.snapshot.client
      }
    >
      <ModelAccountsSection readState={readState} />
    </Show>
  );
}

export const ModelAccounts = defineSolidBridge("openclaw-model-accounts", ModelAccountsContent, {
  properties: {
    identityId: { default: null, attribute: false },
    profileId: { default: null, attribute: false },
    personLabel: { default: null, attribute: false },
  },
});
