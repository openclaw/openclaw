import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { For, createEffect, createSignal } from "solid-js";
import { pathForPluginSettings } from "../../app-route-paths.ts";
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
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { pluginDetailLocation } from "../plugins/detail-tabs.ts";
import {
  labFeatureMergePatch,
  labFeatureResetPatch,
  LAB_FEATURES,
  resolveLabFeatureState,
  type LabFeature,
} from "./labs-registry.ts";

export function LabsPage() {
  const context = useApplication();
  const config = projectRuntimeConfig(context.runtimeConfig);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  let pending: { featureId: string; value: boolean | string } | null = null;
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
  const page = useGatewayPage({
    getGateway: () => context.gateway,
    invalidateRequests: () => {
      pending = null;
      saveError = null;
      publish();
    },
  });
  // Config replacements retire pending saves before reloading and resubscribing.
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
    value: boolean | string,
    raw: Record<string, unknown>,
  ) {
    const scope = page.capture();
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
      page.isCurrent(scope) &&
      context.gateway === gateway &&
      context.runtimeConfig === runtimeConfig;
    pending = { featureId, value };
    saveError = null;
    publish();
    try {
      const patched = await runtimeConfig.patch({ raw, note: `labs: update ${featureId}` });
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
  function predictionModel() {
    const gateway = editableConfig()?.gateway;
    const controlUi = isRecord(gateway) ? gateway.controlUi : undefined;
    const experimental = isRecord(controlUi) ? controlUi.experimental : undefined;
    const prediction = isRecord(experimental) ? experimental.composerPredictions : undefined;
    const current = currentPending();
    const value =
      current?.featureId === "predictionModel"
        ? current.value
        : isRecord(prediction)
          ? prediction.model
          : undefined;
    return value === "conversation" || value === "default" ? value : "utility";
  }
  function setPredictionModel(model: string) {
    if (model !== "utility" && model !== "conversation" && model !== "default") {
      return;
    }
    void updateSetting("predictionModel", model, {
      gateway: { controlUi: { experimental: { composerPredictions: { model } } } },
    });
  }
  function PluginSettingsLink(props: { pluginId: string; featureTitle: string }) {
    const location = () =>
      pluginDetailLocation(
        { pathname: pathForPluginSettings(props.pluginId, context.basePath), search: "" },
        true,
      );
    return (
      <a
        class="btn btn--sm oc-action oc-action-ghost"
        href={`${location().pathname}${location().search}`}
        aria-label={t("labsPage.configureFeature", { name: props.featureTitle })}
        onClick={(event: MouseEvent) => {
          if (shouldHandleNavigationClick(event)) {
            event.preventDefault();
            context.navigate("plugin-settings", location());
          }
        }}
      >
        {t("labsPage.configure")}
      </a>
    );
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
            actions={
              props.feature.settingsPluginId ? (
                <PluginSettingsLink
                  pluginId={props.feature.settingsPluginId}
                  featureTitle={props.feature.title()}
                />
              ) : undefined
            }
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
        {props.feature.id === "composerPredictions" ? (
          <SettingsRow
            nested
            title={t("labsPage.composerPredictions.model")}
            description={t("labsPage.composerPredictions.modelDescription")}
            control={
              <select
                class="settings-select"
                aria-label={t("labsPage.composerPredictions.model")}
                value={predictionModel()}
                disabled={!canToggle()}
                onChange={(event) => setPredictionModel(event.currentTarget.value)}
              >
                <option value="utility" selected={predictionModel() === "utility"}>
                  {t("labsPage.composerPredictions.utility")}
                </option>
                <option value="conversation" selected={predictionModel() === "conversation"}>
                  {t("labsPage.composerPredictions.conversation")}
                </option>
                <option value="default" selected={predictionModel() === "default"}>
                  {t("labsPage.composerPredictions.default")}
                </option>
              </select>
            }
          />
        ) : null}
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
      </>
    );
  }
  return (
    <openclaw-labs-page>
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
    </openclaw-labs-page>
  );
}
