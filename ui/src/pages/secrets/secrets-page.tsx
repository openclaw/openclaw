import { action, createMemo, createOptimistic, onSettled } from "solid-js";
import { SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import { SecretsPageState } from "./state.ts";
import { SecretsStore } from "./view.tsx";

export function SecretsPage() {
  const context = useApplication();
  // This mount owns one secrets request state; Gateway replacement is bound below.
  const model = new SecretsPageState(context, () => state.publish());
  const state = projectMutableSource(model, (owner) => owner);
  onSettled(() => {
    const release = model.bindGateway(context.gateway);
    const pathname = context.router.getState().location.pathname;
    // Route intent releases the action before Solid can park the page's cleanup.
    const releaseRoute = context.router.subscribe(() => {
      if (context.router.getState().location.pathname !== pathname) {
        model.retirePresentation();
      }
    });
    return () => {
      releaseRoute();
      release();
      model.dispose();
    };
  });
  const scope = createMemo(() => state.read().store);
  const receipt = createMemo(() => state.read().readReceipt);
  const entries = createMemo(() => state.read().store.entries);
  const read = createMemo(() => {
    const store = scope();
    const admitted = receipt();
    entries();
    return admitted?.store === store
      ? admitted.result.then(() => store.entries)
      : Promise.resolve(store.entries);
  });
  const presentation = createMemo(() => {
    const store = scope();
    const [saving, setSaving] = createOptimistic(false);
    return { store, saving, setSaving };
  });
  const presentMutation = action(function* (
    view: ReturnType<typeof presentation>,
    pending: Promise<void>,
    retired: Promise<void>,
  ) {
    try {
      if (model.store === view.store) {
        view.setSaving(true);
      }
      // Retiring the page releases presentation without cancelling an admitted write.
      yield Promise.race([pending, retired]);
    } catch (error) {
      if (model.store === view.store) {
        model.store.error = formatUiError(error);
        model.notify();
      }
    }
  });
  async function mutate(operation: () => Promise<void> | undefined) {
    const view = presentation();
    const retired = model.presentationLifetime.promise;
    const pending = operation();
    model.notify();
    if (pending) {
      // Publish the owner's synchronous admission before joining the action.
      await Promise.resolve();
      await presentMutation(view, pending, retired);
    }
  }
  const parsed = createMemo(() => state.read().bulkParsed);
  return (
    <openclaw-secrets-page>
      <SettingsPageHeader title={t("tabs.secrets")} subtitle={t("secretsStore.hint")} />
      <SettingsWorkspace>
        <SecretsStore
          state={state.read()}
          scope={scope()}
          read={read}
          busy={presentation().saving() || state.read().store.busy}
          onSubmit={(bulk) => void mutate(() => (bulk ? model.submitBulk() : model.submitDraft()))}
          onRemove={(entry) => void mutate(() => model.removeEntry(entry))}
          bulkSecretCount={parsed().entries.filter((entry) => entry.kind === "secret").length}
          bulkEntryCount={parsed().entries.length}
          bulkInvalidNames={parsed().invalidNames}
        />
      </SettingsWorkspace>
    </openclaw-secrets-page>
  );
}
