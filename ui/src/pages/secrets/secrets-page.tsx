import { createMemo, createSignal, onSettled } from "solid-js";
import { SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { SecretsPageState } from "./state.ts";
import { SecretsStore } from "./view.tsx";

export function SecretsPage() {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  // This mount owns one secrets request state; Gateway replacement is bound below.
  const model = new SecretsPageState(context, () => setRevision((value) => value + 1));
  onSettled(() => {
    const release = model.bindGateway(context.gateway);
    return () => {
      release();
      model.dispose();
    };
  });
  const state = createMemo(
    () => {
      revision();
      return model;
    },
    { equals: false },
  );
  const parsed = createMemo(() => {
    revision();
    return model.bulkParsed;
  });
  return (
    <openclaw-secrets-page>
      <SettingsPageHeader title={t("tabs.secrets")} subtitle={t("secretsStore.hint")} />
      <SettingsWorkspace>
        <SecretsStore
          state={state()}
          bulkSecretCount={parsed().entries.filter((entry) => entry.kind === "secret").length}
          bulkEntryCount={parsed().entries.length}
          bulkInvalidNames={parsed().invalidNames}
        />
      </SettingsWorkspace>
    </openclaw-secrets-page>
  );
}
