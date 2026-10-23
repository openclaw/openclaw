import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  For,
  latest,
  Loading,
  onSettled,
} from "solid-js";
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
import { registerLabsEnglish } from "../../i18n/locales/en-labs.ts";
import {
  currentConfigObject,
  resolveEditableSnapshotConfig,
} from "../../lib/config/config-state-model.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { SettingsSelectRow } from "../config/settings-select-row.tsx";
import { pluginDetailLocation } from "../plugins/detail-tabs.ts";
import {
  labFeatureMergePatch,
  labFeatureResetPatch,
  LAB_FEATURES,
  resolveLabFeatureState,
  type LabFeature,
} from "./labs-registry.ts";

registerEnglishCatalog(registerLabsEnglish);

export function LabsPage() {
  const context = useApplication();
  const config = projectRuntimeConfig(context.runtimeConfig);
  type ExpectedSetting = { featureId: string; value: boolean | string };
  let admitted = false;
  let lifetime = Promise.withResolvers<void>();
  const [receipt, setReceipt] = createSignal({ completion: Promise.resolve() });
  const page = useGatewayPage({
    getGateway: () => latest(() => context.gateway),
    invalidateRequests: () => {
      admitted = false;
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
      setReceipt({ completion: Promise.resolve() });
    },
  });
  const presentation = createMemo(() => {
    const epoch = page.epoch;
    const gateway = context.gateway;
    const runtimeConfig = context.runtimeConfig;
    const [expected, setExpected] = createOptimistic<ExpectedSetting | null>(null);
    const [saving, setSaving] = createOptimistic(false);
    return { epoch, gateway, runtimeConfig, expected, setExpected, saving, setSaving };
  });
  const currentPending = () => presentation().expected();
  onSettled(() => {
    void context.runtimeConfig.ensureLoaded();
    const stopRoute = context.router.subscribe(() => {
      const route = context.router.getState();
      if ((route.pendingMatches[0] ?? route.matches[0])?.routeId !== "labs") {
        lifetime.resolve();
        lifetime = Promise.withResolvers<void>();
      }
    });
    return () => {
      stopRoute();
      lifetime.resolve();
    };
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
      state.connected && state.configSnapshot?.hash && !state.configLoading && !admitted,
    );
  }
  const presentSave = action(function* (
    view: ReturnType<typeof presentation>,
    expected: ExpectedSetting,
    work: Promise<void>,
    retired: Promise<void>,
    isCurrent: () => boolean,
  ) {
    if (isCurrent()) {
      view.setExpected(expected);
      view.setSaving(true);
    }
    // The configuration owner finishes admitted writes even after this page retires.
    yield Promise.race([work, retired]);
  });
  function updateSetting(featureId: string, value: boolean | string, raw: Record<string, unknown>) {
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
    const view = presentation();
    const isCurrent = () =>
      page.isCurrent(scope) &&
      context.gateway === gateway &&
      context.runtimeConfig === runtimeConfig;
    admitted = true;
    const retired = lifetime.promise;
    const work = (async () => {
      try {
        const patched = await runtimeConfig.patch({ raw, note: `labs: update ${featureId}` });
        if (isCurrent() && !patched) {
          throw new Error(runtimeConfig.state.lastError ?? t("labsPage.saveFailed"));
        }
      } finally {
        if (isCurrent()) {
          admitted = false;
        }
      }
    })();
    // Publish the owner's synchronous changes before entering its presentation action.
    const completion = Promise.resolve().then(() =>
      presentSave(
        view,
        { featureId, value },
        work,
        retired,
        () =>
          isCurrent() &&
          view.epoch === page.readEpoch() &&
          view.gateway === gateway &&
          view.runtimeConfig === runtimeConfig,
      ),
    );
    setReceipt({ completion });
    // SaveOutcome consumes this failure through the inline error boundary.
    void completion.catch(() => {});
  }
  function setFeatureEnabled(feature: LabFeature, enabled: boolean) {
    const value = editableConfig();
    const featureState = resolveLabFeatureState(value, feature);
    const resetPatch =
      enabled === featureState.defaultEnabled ? labFeatureResetPatch(value, feature) : null;
    updateSetting(feature.id, enabled, resetPatch ?? labFeatureMergePatch(feature, enabled));
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
    updateSetting("codeModeExecutor", executor, {
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
    updateSetting("predictionModel", model, {
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
        onClick={(event: MouseEvent) =>
          handleNavigationClick(event, () => context.navigate("plugin-settings", location()))
        }
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
            disabled={presentation().saving() || !canToggle()}
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
          <SettingsSelectRow
            nested
            title={t("labsPage.composerPredictions.model")}
            description={t("labsPage.composerPredictions.modelDescription")}
            value={predictionModel()}
            disabled={presentation().saving() || !canToggle()}
            onChange={setPredictionModel}
            options={[
              { value: "utility", label: t("labsPage.composerPredictions.utility") },
              { value: "conversation", label: t("labsPage.composerPredictions.conversation") },
              { value: "default", label: t("labsPage.composerPredictions.default") },
            ]}
          />
        ) : null}
        {props.feature.id === "codeMode" ? (
          <SettingsSelectRow
            nested
            title={t("labsPage.codeMode.executor")}
            description={t("labsPage.codeMode.executorDescription")}
            value={executorValue()}
            disabled={presentation().saving() || !canToggle()}
            onChange={setCodeModeExecutor}
            options={[
              { value: "node", label: t("labsPage.codeMode.executorNode") },
              { value: "quickjs", label: t("labsPage.codeMode.executorQuickjs") },
            ]}
          />
        ) : null}
      </>
    );
  }
  function SaveOutcome() {
    const complete = createMemo(() => receipt().completion.then(() => true));
    return <>{complete() && null}</>;
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
            <Loading on={receipt()}>
              <Errored
                fallback={(error) => (
                  <SettingsRow
                    title={t("labsPage.saveErrorTitle")}
                    description={<span role="alert">{formatUiError(error())}</span>}
                  />
                )}
              >
                <SaveOutcome />
              </Errored>
            </Loading>
          </SettingsSection>
        </SettingsPage>
      </SettingsWorkspace>
    </openclaw-labs-page>
  );
}
