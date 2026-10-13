import { createSignal, Show } from "solid-js";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { CloudWorkerConfigSave } from "./cloud-worker-config-save.ts";
import { isReadyPreparation } from "./cloud-worker-environment-model.ts";
import {
  buildCloudWorkerPreparedPoolPatch,
  readCloudWorkerPreparedPool,
} from "./cloud-worker-repositories-config.ts";
export function CloudWorkerMachinePool(props: { inventory: EnvironmentsListResult | null }) {
  const context = useApplication();
  const runtime = projectRuntimeConfig(context.runtimeConfig);
  const [draft, setDraft] = createSignal<string | null>(null, { ownedWrite: true });
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const save = new CloudWorkerConfigSave(() => setRevision((value) => value + 1));
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    invalidateRequests: () => {
      setDraft(null);
      save.update({ busy: false, error: null, notice: null });
    },
  });
  const state = () => {
    revision();
    return save.state;
  };
  const editable = () =>
    canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin") &&
    Boolean(runtime.read().state.configSnapshot?.hash) &&
    !runtime.read().state.configSaving &&
    !state().busy;
  const ready = () => props.inventory?.environments.filter(isReadyPreparation).length ?? 0;
  async function savePool() {
    const scope = gateway.capture();
    const runtimeConfig = context.runtimeConfig;
    if (!scope || !editable()) {
      return;
    }
    const value =
      draft() ??
      readCloudWorkerPreparedPool(
        resolveEditableSnapshotConfig(runtime.read().state.configSnapshot),
      );
    const isCurrent = () => gateway.isCurrent(scope) && context.runtimeConfig === runtimeConfig;
    await save.save(runtimeConfig, isCurrent, {
      build: () => buildCloudWorkerPreparedPoolPatch(value),
      note: "cloud environments: update pool cap",
      canDispatch: () =>
        isCurrent() && canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin"),
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
              value={
                draft() ??
                readCloudWorkerPreparedPool(
                  resolveEditableSnapshotConfig(runtime.read().state.configSnapshot),
                )
              }
              placeholder={String(props.inventory?.preparedPool?.maxTotal ?? 4)}
              disabled={!editable()}
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
            <button
              class="btn btn--sm"
              type="button"
              disabled={!editable()}
              onClick={() => void savePool()}
            >
              {t("cloudWorkersPage.savePool")}
            </button>
          </>
        }
      />
      <Show when={state().error}>
        <div class="callout warning" role="alert">
          {state().error}
        </div>
      </Show>
    </>
  );
}
