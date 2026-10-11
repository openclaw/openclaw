import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, For } from "solid-js";
import { parseDurationMs } from "../../../../src/cli/parse-duration.js";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { CloudWorkerConfigSave } from "./cloud-worker-config-save.ts";

registerEnglishCatalog(registerSettingsEnglish);

type PolicyDraft = { refreshAfter: string; retainUnused: string; keepPrevious: "0" | "1" };

export const CloudWorkerSnapshotPolicy = defineSolidBridge(
  "openclaw-cloud-worker-snapshot-policy",
  (_props, host) => {
    host.style.display = "contents";
    const context = useApplication();
    const [draft, setDraft] = createSignal<PolicyDraft | null>(null, { ownedWrite: true });
    const [saveRevision, setSaveRevision] = createSignal(0, { ownedWrite: true });
    const configSave = new CloudWorkerConfigSave(() => setSaveRevision((revision) => revision + 1));
    const runtime = projectRuntimeConfig(context.runtimeConfig);
    const gateway = useGatewayPage({
      getGateway: () => context.gateway,
      invalidateRequests: () => {
        setDraft(null);
        configSave.update({ busy: false, error: null, notice: null });
      },
    });
    void context.runtimeConfig.ensureLoaded();
    const saveState = () => {
      saveRevision();
      return configSave.state;
    };
    const policy = createMemo<PolicyDraft>(() => {
      let value: unknown = resolveEditableSnapshotConfig(runtime.read().state.configSnapshot);
      for (const key of ["plugins", "entries", "crabbox", "config", "warmImages"]) {
        value = isRecord(value) ? value[key] : undefined;
      }
      const configured = isRecord(value) ? value : {};
      return {
        refreshAfter: typeof configured.refreshAfter === "string" ? configured.refreshAfter : "24h",
        retainUnused: typeof configured.retainUnused === "string" ? configured.retainUnused : "14d",
        keepPrevious: configured.keepPrevious === 1 ? "1" : "0",
      };
    });
    const values = () => draft() ?? policy();
    const canSave = () => {
      const config = runtime.read().state;
      return Boolean(
        canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin") &&
        config.configSnapshot?.hash &&
        !config.configLoading &&
        !config.configSaving &&
        !saveState().busy,
      );
    };
    function edit(patch: Partial<PolicyDraft>) {
      setDraft((current) => ({ ...(current ?? policy()), ...patch }));
      configSave.update({ error: null, notice: null });
    }
    async function save() {
      const scope = gateway.capture();
      const runtimeConfig = context.runtimeConfig;
      if (!scope || !canSave()) {
        return;
      }
      const current = values();
      for (const [key, minimum] of [
        ["refreshAfter", 3_600_000],
        ["retainUnused", 86_400_000],
      ] as const) {
        if (
          !/^[1-9][0-9]{0,7}(m|h|d)(?![\s\S])/.test(current[key]) ||
          parseDurationMs(current[key]) < minimum
        ) {
          configSave.update({ error: t(`cloudWorkersPage.snapshots.${key}Invalid`) });
          return;
        }
      }
      const isCurrent = () => gateway.isCurrent(scope) && context.runtimeConfig === runtimeConfig;
      await configSave.save(runtimeConfig, isCurrent, {
        build: () => ({
          patch: {
            plugins: {
              entries: {
                crabbox: {
                  config: {
                    warmImages: {
                      refreshAfter: current.refreshAfter,
                      retainUnused: current.retainUnused,
                      keepPrevious: Number(current.keepPrevious),
                    },
                  },
                },
              },
            },
          },
        }),
        note: "cloud workers: update snapshot retention policy",
        canDispatch: () =>
          isCurrent() && canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin"),
        failed: () => t("cloudWorkersPage.snapshots.policySaveFailed"),
        success: () => {
          setDraft(null);
          return t("cloudWorkersPage.snapshots.policySaved");
        },
      });
    }
    return (
      <SettingsSection
        title={t("cloudWorkersPage.snapshots.retentionPolicy")}
        description={t("cloudWorkersPage.snapshots.retentionHelp")}
      >
        <For each={["refreshAfter", "retainUnused"] as const}>
          {(key) => (
            <SettingsRow
              title={t(`cloudWorkersPage.snapshots.${key}`)}
              description={t(`cloudWorkersPage.snapshots.${key}Help`)}
              control={
                <input
                  class="settings-input"
                  aria-label={t(`cloudWorkersPage.snapshots.${key}`)}
                  value={values()[key]}
                  disabled={!canSave()}
                  onInput={(event) => edit({ [key]: event.currentTarget.value })}
                />
              }
            />
          )}
        </For>
        <SettingsRow
          title={t("cloudWorkersPage.snapshots.keepPrevious")}
          control={
            <select
              class="settings-select"
              aria-label={t("cloudWorkersPage.snapshots.keepPrevious")}
              value={values().keepPrevious}
              disabled={!canSave()}
              onChange={(event) =>
                edit({ keepPrevious: event.currentTarget.value === "1" ? "1" : "0" })
              }
            >
              <option value="0" selected={values().keepPrevious === "0"}>
                {t("cloudWorkersPage.snapshots.keepNone")}
              </option>
              <option value="1" selected={values().keepPrevious === "1"}>
                {t("cloudWorkersPage.snapshots.keepOne")}
              </option>
            </select>
          }
        />
        <SettingsRow
          title={t("cloudWorkersPage.snapshots.policyApplies")}
          control={
            <button
              class="btn btn--sm"
              type="button"
              disabled={!canSave()}
              onClick={() => void save()}
            >
              {t("cloudWorkersPage.snapshots.savePolicy")}
            </button>
          }
        />
        {saveState().error ? (
          <div class="callout warning" role="alert">
            {saveState().error}
          </div>
        ) : null}
        {saveState().notice ? (
          <div class="callout" role="status">
            {saveState().notice}
          </div>
        ) : null}
      </SettingsSection>
    );
  },
  { properties: {} },
);
