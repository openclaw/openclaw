import { createSignal, Show } from "solid-js";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { isReadyPreparation } from "./cloud-worker-environment-model.ts";
import {
  buildCloudWorkerPreparedPoolPatch,
  readCloudWorkerPreparedPool,
} from "./cloud-worker-repositories-config.ts";
import { useCloudWorkerConfig } from "./use-cloud-worker-config.ts";
export function CloudWorkerMachinePool(props: { inventory: EnvironmentsListResult | null }) {
  const [draft, setDraft] = createSignal<string | null>(null, { ownedWrite: true });
  const editor = useCloudWorkerConfig(() => setDraft(null));
  const ready = () => props.inventory?.environments.filter(isReadyPreparation).length ?? 0;
  async function savePool() {
    const value = draft() ?? readCloudWorkerPreparedPool(editor.config());
    await editor.save({
      build: () => buildCloudWorkerPreparedPoolPatch(value),
      note: "cloud environments: update pool cap",
      failed: () => t("cloudWorkersPage.errors.saveFailed"),
      success: () => {
        setDraft(null);
        return t("cloudWorkersPage.settingsSaved");
      },
    });
  }
  return (
    <>
      <SettingsRow
        title={t("cloudWorkersPage.environments.pool", { count: String(ready()) })}
        control={
          <>
            <input
              class="settings-input"
              type="number"
              min="0"
              step="1"
              aria-label={t("cloudWorkersPage.environments.poolCap")}
              title={t("cloudWorkersPage.preparedPoolHelp")}
              value={draft() ?? readCloudWorkerPreparedPool(editor.config())}
              placeholder={String(props.inventory?.preparedPool?.maxTotal ?? 4)}
              disabled={!editor.editable()}
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
            <button
              class="btn btn--sm"
              type="button"
              disabled={!editor.editable()}
              onClick={() => void savePool()}
            >
              {t("cloudWorkersPage.savePool")}
            </button>
          </>
        }
      />
      <Show when={editor.state().error}>
        <div class="callout warning" role="alert">
          {editor.state().error}
        </div>
      </Show>
    </>
  );
}
