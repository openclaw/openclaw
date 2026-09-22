import { consume } from "@lit/context";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import {
  renderLearnMoreLink,
  renderSettingsDefaultDescription,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderSettingsSelectRow } from "../config/settings-select-row.ts";
import {
  labFeatureMergePatch,
  labFeatureResetPatch,
  LAB_FEATURES,
  resolveLabFeatureState,
  type LabFeature,
} from "./labs-registry.ts";

class LabsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private busyFeatureId: string | null = null;
  @state() private pendingValues: Readonly<Record<string, boolean | string>> = {};
  @state() private saveError: string | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.busyFeatureId = null;
      this.pendingValues = {};
      this.saveError = null;
    },
  });
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.runtimeConfig,
    (runtimeConfig) => {
      void runtimeConfig.ensureLoaded();
      return runtimeConfig.subscribe(() => this.requestUpdate());
    },
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private editableConfig(): Record<string, unknown> | null {
    const snapshot = this.context?.runtimeConfig.state.configSnapshot;
    return resolveEditableSnapshotConfig(snapshot);
  }

  private featureEnabled(feature: LabFeature): boolean {
    const pending = this.pendingValues[feature.id];
    if (typeof pending === "boolean") {
      return pending;
    }
    return resolveLabFeatureState(this.editableConfig(), feature).enabled;
  }

  private canToggle(): boolean {
    const configState = this.context?.runtimeConfig.state;
    return Boolean(
      configState?.connected &&
      configState.configSnapshot?.hash &&
      !configState.configLoading &&
      this.busyFeatureId === null,
    );
  }

  private clearPendingValue(featureId: string) {
    const next = { ...this.pendingValues };
    delete next[featureId];
    this.pendingValues = next;
  }

  private async updateSetting(
    featureId: string,
    value: boolean | string,
    raw: Record<string, unknown>,
  ) {
    const scope = this.gateway.capture();
    const runtimeConfig = this.context.runtimeConfig;
    if (!scope || !this.canToggle()) {
      return;
    }
    const isCurrent = () =>
      this.gateway.isCurrent(scope) && this.context.runtimeConfig === runtimeConfig;
    this.busyFeatureId = featureId;
    this.pendingValues = { ...this.pendingValues, [featureId]: value };
    this.saveError = null;
    try {
      const patched = await runtimeConfig.patch({
        raw,
        note: `labs: update ${featureId}`,
      });
      if (isCurrent() && !patched) {
        this.saveError = runtimeConfig.state.lastError ?? t("labsPage.saveFailed");
      }
    } catch (error) {
      if (isCurrent()) {
        this.saveError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.clearPendingValue(featureId);
        if (this.busyFeatureId === featureId) {
          this.busyFeatureId = null;
        }
      }
    }
  }

  private setFeatureEnabled(feature: LabFeature, enabled: boolean) {
    const config = this.editableConfig();
    const featureState = resolveLabFeatureState(config, feature);
    const resetPatch =
      enabled === featureState.defaultEnabled ? labFeatureResetPatch(config, feature) : null;
    void this.updateSetting(
      feature.id,
      enabled,
      resetPatch ?? labFeatureMergePatch(feature, enabled),
    );
  }

  private codeModeConfig(): unknown {
    const tools = this.editableConfig()?.tools;
    return isRecord(tools) ? tools.codeMode : undefined;
  }

  private setCodeModeExecutor(executor: string) {
    if (executor !== "node" && executor !== "quickjs") {
      return;
    }
    const config = this.codeModeConfig();
    void this.updateSetting("codeModeExecutor", executor, {
      tools: {
        codeMode: {
          ...(typeof config === "boolean" || config === "auto" ? { enabled: config } : {}),
          executor: executor === "node" ? null : executor,
        },
      },
    });
  }

  private renderCodeModeExecutor() {
    const config = this.codeModeConfig();
    const pending = this.pendingValues.codeModeExecutor;
    const executor =
      typeof pending === "string" ? pending : isRecord(config) ? config.executor : null;
    return renderSettingsSelectRow({
      title: t("labsPage.codeMode.executor"),
      description: t("labsPage.codeMode.executorDescription"),
      value: executor === "quickjs" ? "quickjs" : "node",
      options: [
        { value: "node", label: t("labsPage.codeMode.executorNode") },
        { value: "quickjs", label: t("labsPage.codeMode.executorQuickjs") },
      ],
      disabled: !this.canToggle(),
      onChange: (value) => this.setCodeModeExecutor(value),
    });
  }

  private renderFeature(feature: LabFeature) {
    const title = feature.title();
    const featureState = resolveLabFeatureState(this.editableConfig(), feature);
    const canToggle = this.canToggle();
    const defaultDescription = renderSettingsDefaultDescription(
      featureState.defaultEnabled ? t("common.enabled") : t("common.disabled"),
      featureState.overridden,
    );
    const description = html`
      ${feature.description()}
      <a href=${feature.docsUrl} target=${EXTERNAL_LINK_TARGET} rel=${buildExternalLinkRel()}
        >${t("labsPage.documentation")}</a
      >
      ${defaultDescription ? html`<br />${defaultDescription}` : nothing}
    `;
    return html`
      ${renderSettingsToggleRow({
        title,
        description,
        checked: this.featureEnabled(feature),
        disabled: !canToggle,
        onChange: (enabled) => this.setFeatureEnabled(feature, enabled),
      })}
      ${feature.id === "codeMode" ? this.renderCodeModeExecutor() : nothing}
    `;
  }

  override render() {
    const rows = [
      ...LAB_FEATURES.map((feature) => this.renderFeature(feature)),
      this.saveError
        ? renderSettingsRow({
            title: t("labsPage.saveErrorTitle"),
            description: html`<span role="alert">${this.saveError}</span>`,
          })
        : nothing,
    ];
    const body = renderSettingsPage(
      renderSettingsSection(
        {
          title: t("labsPage.sectionTitle"),
          description: t("labsPage.sectionDescription"),
        },
        rows,
      ),
    );
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("labs"),
        subtitle: html`${t("labsPage.intro")}
        ${renderLearnMoreLink("https://docs.openclaw.ai/concepts/experimental-features")}`,
      })}
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-labs-page")) {
  customElements.define("openclaw-labs-page", LabsPage);
}
