import {
  createDeferred,
  createMemo,
  Errored,
  isPending,
  latest,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { modelAuthEventInvalidates } from "../../lib/model-auth-request-state.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import { createModelAccountsActions } from "./model-accounts-actions.ts";
import { ModelAccountInventory, ModelAccountsSection } from "./model-accounts-section.tsx";
import { ModelAccountsState, type ModelAccountsProps } from "./model-accounts-state.ts";

registerEnglishCatalog(registerModelAccountsEnglish);

export function ModelAccounts(props: ModelAccountsProps) {
  const context = useApplication();
  const state = new ModelAccountsState(context, props, () => view.publish());
  const view = projectMutableSource(state, (source) => source);
  const readState = view.read;
  const actions = createModelAccountsActions(readState);
  const inventoryScope = createMemo(() => readState().target);
  const inventoryReceipt = createMemo(() => readState().inventoryReceipt);
  const inventoryRead = createDeferred(() =>
    inventoryReceipt().result.then((error) => {
      if (error) {
        throw new Error(error);
      }
    }),
  );
  const readInventory = () => {
    // Retain inventory rows without holding connection controls or sign-in drafts.
    inventoryRead();
    return null;
  };
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
    <openclaw-model-accounts aria-busy={actions.saving() ? "true" : "false"}>
      <Show when={readState().target || readState().context.gateway.snapshot.phase === "connected"}>
        <ModelAccountsSection
          readState={readState}
          actions={actions}
          inventory={
            <Errored
              fallback={() => (
                <ModelAccountInventory readState={readState} actions={actions} pending={false} />
              )}
            >
              <Loading
                on={latest(inventoryScope)}
                fallback={<ModelAccountInventory readState={readState} actions={actions} pending />}
              >
                {readInventory()}
                <ModelAccountInventory
                  readState={readState}
                  actions={actions}
                  pending={isPending(inventoryRead)}
                />
              </Loading>
            </Errored>
          }
        />
      </Show>
    </openclaw-model-accounts>
  );
}
