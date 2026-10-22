import { onSettled, Show } from "solid-js";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { modelAuthEventInvalidates } from "../../lib/model-auth-request-state.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import { ModelAccountsSection } from "./model-accounts-section.tsx";
import { ModelAccountsState, type ModelAccountsProps } from "./model-accounts-state.ts";

registerEnglishCatalog(registerModelAccountsEnglish);

export function ModelAccounts(props: ModelAccountsProps) {
  const context = useApplication();
  const state = new ModelAccountsState(context, props, () => view.publish());
  const view = projectMutableSource(state, (source) => source);
  const readState = view.read;
  // Snapshot identity/profile at request admission; target changes retire account reads and auth polls.
  onSettled(() => {
    const target = props.target;
    const sync = () => {
      state.applySnapshot(target.read());
      state.publish();
    };
    // The profile owner admits both connection authority and its canonical profile.
    const stopTarget = target.subscribe(sync);
    const stopEvents = context.gateway.subscribeEvents((event) => {
      if (modelAuthEventInvalidates(event)) {
        void state.loadAccounts();
      }
    });
    sync();
    return () => {
      stopEvents();
      stopTarget();
      state.dispose();
    };
  });
  return (
    <openclaw-model-accounts>
      <Show when={readState().target || readState().context.gateway.snapshot.phase === "connected"}>
        <ModelAccountsSection readState={readState} />
      </Show>
    </openclaw-model-accounts>
  );
}
