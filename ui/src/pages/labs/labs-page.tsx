import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { For, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import {
  LearnMoreLink,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import {
  currentConfigObject,
  resolveEditableSnapshotConfig,
} from "../../lib/config/config-state-model.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import {
  loadModelCatalog,
  readAgentModelCatalog,
  subscribeModelCatalogCache,
  subscribeModelCatalogChanges,
} from "../../lib/model-catalog-store.ts";
import { projectAgentSelection, projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { PageLayout } from "../page-layout.tsx";
import {
  labFeatureMergePatch,
  labFeatureResetPatch,
  LAB_FEATURES,
  resolveLabFeatureState,
  type LabFeature,
} from "./labs-registry.ts";

function LabsPageContent() {
  const context = useApplication();
  const config = projectRuntimeConfig(untrack(() => context.runtimeConfig));
  const lifecycle = createGatewayConnectionLifecycle(untrack(() => context.gateway.snapshot));
  const gatewayView = projectGateway(untrack(() => context.gateway));
  const agentSelection = projectAgentSelection(untrack(() => context.settingsAgentSelection));
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  let pending: { featureId: string; value: boolean | string | number } | null = null;
  let saveError: string | null = null;
  const publish = () => setRevision((value) => value + 1);
  const currentPending = () => {
    revision();
    return pending;
  };
  const currentError = () => {
    revision();
    return saveError;
  };

  createEffect(
    () => context.runtimeConfig,
    (runtimeConfig) => {
      config.replaceSource(runtimeConfig);
      pending = null;
      saveError = null;
      publish();
      void runtimeConfig.ensureLoaded();
    },
  );
  createEffect(
    () => context.gateway,
    (gateway) => {
      gatewayView.replaceSource(gateway);
      lifecycle.transition(gateway.snapshot);
      const unsubscribe = gateway.subscribe((snapshot) => {
        if (context.gateway !== gateway) {
          return;
        }
        // A same-tick reconnect must retire a save before Solid's next flush.
        if (lifecycle.transition(snapshot)) {
          pending = null;
          saveError = null;
          publish();
        }
      });
      return () => {
        unsubscribe();
        lifecycle.invalidate();
        pending = null;
        saveError = null;
        publish();
      };
    },
  );
  onCleanup(() => lifecycle.dispose());
  createEffect(
    () => context.settingsAgentSelection,
    (selection) => agentSelection.replaceSource(selection),
  );
  createEffect(
    () => ({
      snapshot: gatewayView.read().snapshot,
      agentId: agentSelection.read().state.selectedId,
      enabled: progressReviewPlugin()?.enabled === true,
    }),
    ({ snapshot, agentId, enabled }) => {
      if (!enabled || snapshot.phase !== "connected" || !snapshot.client || !agentId) {
        return undefined;
      }
      const client = snapshot.client;
      const controller = new AbortController();
      const load = () => {
        void loadModelCatalog(client, { agentId, signal: controller.signal }).catch(
          (error: unknown) => {
            if (!controller.signal.aborted) {
              saveError = formatUiError(error);
              publish();
            }
          },
        );
      };
      const stopCache = subscribeModelCatalogCache(client, publish);
      const stopChanges = subscribeModelCatalogChanges(context.gateway, load, { agentId });
      load();
      return () => {
        controller.abort();
        stopCache();
        stopChanges();
      };
    },
  );
  const reviewerModels = createMemo(() => {
    revision();
    const snapshot = gatewayView.read().snapshot;
    return readAgentModelCatalog(
      snapshot.phase === "connected" ? snapshot.client : null,
      agentSelection.read().state.selectedId,
    ).models.map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: model.name || `${model.provider}/${model.id}`,
      provider: model.provider,
      disabled: model.available === false || model.manualSelectionAllowed === false,
    }));
  });

  function editableConfig(): Record<string, unknown> | null {
    return resolveEditableSnapshotConfig(config.read().state.configSnapshot);
  }
  function decisionPreferenceKnown(): boolean {
    const state = config.read().state;
    return (
      state.connected &&
      !state.configLoading &&
      !state.lastError &&
      state.configSnapshot?.valid !== false &&
      currentConfigObject(state) !== null &&
      editableConfig() !== null
    );
  }
  function canToggle(): boolean {
    const state = config.read().state;
    return Boolean(
      state.connected &&
      state.configSnapshot?.hash &&
      !state.configLoading &&
      currentPending() === null,
    );
  }
  async function updateSetting(
    featureId: string,
    value: boolean | string | number,
    raw: Record<string, unknown>,
    replacePaths?: string[],
  ) {
    const scope = lifecycle.capture();
    const gateway = context.gateway;
    const runtimeConfig = context.runtimeConfig;
    if (
      !scope ||
      !canToggle() ||
      (featureId === "decisionAssistance" && !decisionPreferenceKnown())
    ) {
      return;
    }
    const isCurrent = () =>
      lifecycle.isCurrent(scope) &&
      context.gateway === gateway &&
      context.runtimeConfig === runtimeConfig;
    pending = { featureId, value };
    saveError = null;
    publish();
    try {
      const patched = await runtimeConfig.patch({
        raw,
        note: `labs: update ${featureId}`,
        ...(replacePaths ? { replacePaths } : {}),
      });
      if (isCurrent() && !patched) {
        saveError = runtimeConfig.state.lastError ?? t("labsPage.saveFailed");
      }
    } catch (error) {
      if (isCurrent()) {
        saveError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        pending = null;
        publish();
      }
    }
  }
  function setFeatureEnabled(feature: LabFeature, enabled: boolean) {
    const value = editableConfig();
    const featureState = resolveLabFeatureState(value, feature);
    const resetPatch =
      enabled === featureState.defaultEnabled ? labFeatureResetPatch(value, feature) : null;
    void updateSetting(feature.id, enabled, resetPatch ?? labFeatureMergePatch(feature, enabled));
  }
  function codeModeConfig(): unknown {
    const tools = editableConfig()?.tools;
    return isRecord(tools) ? tools.codeMode : undefined;
  }
  function setCodeModeExecutor(executor: string) {
    if (executor !== "node" && executor !== "quickjs") {
      return;
    }
    const value = codeModeConfig();
    void updateSetting("codeModeExecutor", executor, {
      tools: {
        codeMode: {
          ...(value === undefined
            ? { enabled: "auto" }
            : typeof value === "boolean" || value === "auto"
              ? { enabled: value }
              : {}),
          executor: executor === "node" ? null : executor,
        },
      },
    });
  }
  function executorValue() {
    const value = codeModeConfig();
    const current = currentPending();
    const executor =
      current?.featureId === "codeModeExecutor"
        ? current.value
        : isRecord(value)
          ? value.executor
          : null;
    return executor === "quickjs" ? "quickjs" : "node";
  }
  function progressReviewPlugin() {
    const plugins = editableConfig()?.plugins;
    const entries = isRecord(plugins) ? plugins.entries : undefined;
    const plugin = isRecord(entries) ? entries["progress-review"] : undefined;
    return isRecord(plugin) ? plugin : undefined;
  }
  function progressReviewModel() {
    const current = currentPending();
    if (current?.featureId === "progressReviewModel" && typeof current.value === "string") {
      return current.value;
    }
    const settings = progressReviewPlugin()?.config;
    return isRecord(settings) && typeof settings.model === "string" ? settings.model : "";
  }
  function setProgressReviewModel(model: string) {
    const subagent = progressReviewPlugin()?.subagent;
    // The Gateway refuses to shrink an existing array unless the patch names it.
    const replacePaths =
      isRecord(subagent) && Array.isArray(subagent.allowedModels)
        ? ["plugins.entries.progress-review.subagent.allowedModels"]
        : undefined;
    void updateSetting(
      "progressReviewModel",
      model,
      {
        plugins: {
          entries: {
            "progress-review": {
              config: { model: model || null },
              subagent: model ? { allowModelOverride: true, allowedModels: [model] } : null,
            },
          },
        },
      },
      replacePaths,
    );
  }
  function progressReviewValue(key: "everyTurns" | "everyMinutes", defaultValue: number) {
    const current = currentPending();
    if (current?.featureId === key && typeof current.value === "number") {
      return current.value;
    }
    const settings = progressReviewPlugin()?.config;
    return isRecord(settings) && typeof settings[key] === "number" ? settings[key] : defaultValue;
  }
  function setProgressReviewInterval(key: "everyTurns" | "everyMinutes", raw: string, max: number) {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(value) || value < 0 || value > max) {
      saveError = t("labsPage.progressReview.invalidValue", {
        label: t(`labsPage.progressReview.${key}`),
        max: String(max),
      });
      publish();
      return;
    }
    void updateSetting(key, value, {
      plugins: { entries: { "progress-review": { config: { [key]: value } } } },
    });
  }
  function FeatureRow(props: { feature: LabFeature }) {
    const featureState = () => resolveLabFeatureState(editableConfig(), props.feature);
    const checked = () => {
      const current = currentPending();
      return current?.featureId === props.feature.id && typeof current.value === "boolean"
        ? current.value
        : featureState().enabled;
    };
    return (
      <>
        {props.feature.id === "decisionAssistance" && !decisionPreferenceKnown() ? (
          <SettingsRow
            title={props.feature.title()}
            description={
              <>
                {props.feature.description()}
                <br />
                <span role="status">
                  {t(
                    config.read().state.configLoading
                      ? "labsPage.decisionAssistance.loading"
                      : "labsPage.decisionAssistance.unavailable",
                  )}
                </span>
                <button
                  class="btn btn--sm"
                  disabled={!config.read().state.connected || config.read().state.configLoading}
                  onClick={() => void context.runtimeConfig.refresh()}
                >
                  {t("labsPage.decisionAssistance.refresh")}
                </button>
              </>
            }
          />
        ) : (
          <SettingsToggleRow
            title={props.feature.title()}
            checked={checked()}
            disabled={!canToggle()}
            onChange={(enabled) => setFeatureEnabled(props.feature, enabled)}
            description={
              <>
                {props.feature.description()}
                {props.feature.id === "decisionAssistance" && featureState().enabled ? (
                  <>
                    <br />
                    {t("labsPage.decisionAssistance.optedIn")}
                  </>
                ) : null}{" "}
                <a
                  href={props.feature.docsUrl}
                  target={EXTERNAL_LINK_TARGET}
                  rel={buildExternalLinkRel()}
                >
                  {t("labsPage.documentation")}
                </a>
                {featureState().overridden ? (
                  <>
                    <br />
                    {t("configForm.defaultValue", {
                      value: featureState().defaultEnabled
                        ? t("common.enabled")
                        : t("common.disabled"),
                    })}
                  </>
                ) : null}
              </>
            }
          />
        )}
        {props.feature.id === "codeMode" ? (
          <SettingsRow
            nested
            title={t("labsPage.codeMode.executor")}
            description={t("labsPage.codeMode.executorDescription")}
            control={
              <select
                class="settings-select"
                aria-label={t("labsPage.codeMode.executor")}
                value={executorValue()}
                disabled={!canToggle()}
                onChange={(event) => setCodeModeExecutor(event.currentTarget.value)}
              >
                <option value="node" selected={executorValue() === "node"}>
                  {t("labsPage.codeMode.executorNode")}
                </option>
                <option value="quickjs" selected={executorValue() === "quickjs"}>
                  {t("labsPage.codeMode.executorQuickjs")}
                </option>
              </select>
            }
          />
        ) : null}
        {props.feature.id === "progressReview" && checked() ? (
          <>
            <SettingsRow
              nested
              title={t("labsPage.progressReview.model")}
              description={t("labsPage.progressReview.modelDescription")}
              control={
                <ModelPicker
                  label={t("labsPage.progressReview.model")}
                  preserveOrder
                  value={progressReviewModel()}
                  options={[
                    { value: "", label: t("labsPage.progressReview.agentModel") },
                    ...reviewerModels(),
                  ]}
                  custom={{
                    label: t("labsPage.progressReview.customModel"),
                    placeholder: t("labsPage.progressReview.customModelPlaceholder"),
                    commit: "change",
                  }}
                  disabled={!canToggle()}
                  onChange={setProgressReviewModel}
                />
              }
            />
            <For
              each={
                [
                  { key: "everyTurns", defaultValue: 10, max: 1000 },
                  { key: "everyMinutes", defaultValue: 20, max: 1440 },
                ] as const
              }
            >
              {(setting) => (
                <SettingsRow
                  nested
                  title={t(`labsPage.progressReview.${setting.key}`)}
                  description={t("labsPage.progressReview.triggerHelp")}
                  control={
                    <input
                      class="settings-input"
                      type="number"
                      min="0"
                      max={setting.max}
                      step="1"
                      aria-label={t(`labsPage.progressReview.${setting.key}`)}
                      value={progressReviewValue(setting.key, setting.defaultValue)}
                      disabled={!canToggle()}
                      onChange={(event) =>
                        setProgressReviewInterval(
                          setting.key,
                          event.currentTarget.value,
                          setting.max,
                        )
                      }
                    />
                  }
                />
              )}
            </For>
          </>
        ) : null}
      </>
    );
  }
  return (
    <>
      <SettingsPageHeader
        title={t("tabs.labs")}
        subtitle={
          <>
            {t("labsPage.intro")}{" "}
            <LearnMoreLink url="https://docs.openclaw.ai/concepts/experimental-features" />
          </>
        }
      />
      <SettingsWorkspace>
        <SettingsPage>
          <SettingsSection
            title={t("labsPage.sectionTitle")}
            description={t("labsPage.sectionDescription")}
          >
            <For each={LAB_FEATURES}>{(feature) => <FeatureRow feature={feature} />}</For>
            {currentError() ? (
              <SettingsRow
                title={t("labsPage.saveErrorTitle")}
                description={<span role="alert">{currentError()}</span>}
              />
            ) : null}
          </SettingsSection>
        </SettingsPage>
      </SettingsWorkspace>
    </>
  );
}

export const LabsPage = defineSolidBridge(
  "openclaw-labs-page",
  (_props, host) => (
    <PageLayout host={host}>
      <LabsPageContent />
    </PageLayout>
  ),
  { properties: {} },
);
