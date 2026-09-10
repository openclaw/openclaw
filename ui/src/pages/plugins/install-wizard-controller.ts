import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { serializeConfigForm } from "../../lib/config-form-utils.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import type { PluginDiscoveryDetailResult, PluginListResult } from "../../lib/plugins/index.ts";
import {
  buildPluginConfigurationSet,
  createPluginConfigurationDraft,
  hasPluginConfigurationChanges,
  installedPluginForWizard,
  installedPluginWizardStage,
  installRequestForDiscoveryDetail,
  patchPluginConfigurationDraft,
  removePluginConfigurationDraftValue,
  type PluginInstallWizardState,
} from "./install-wizard-model.ts";
import { pluginRowKey } from "./plugin-row-message.ts";
import type { PluginsConsentController } from "./plugins-consent-controller.ts";

const INSTALL_RECONNECT_TIMEOUT_MS = 30_000;

type InstallWizardControllerHost = {
  getState: () => PluginInstallWizardState | null;
  setState: (state: PluginInstallWizardState | null) => void;
  getCatalog: () => PluginListResult | null;
  getRuntimeConfig: () => ApplicationContext["runtimeConfig"];
  getConsentController: () => PluginsConsentController;
  getOwner: () => object;
  getBootId: () => string | undefined;
  isConnected: () => boolean;
  canMutate: () => boolean;
  canEditConfig: () => boolean;
  refreshCatalog: () => Promise<void>;
  requestRestart: (reason: string) => Promise<void>;
  onManage: (pluginId: string) => void;
};

export class InstallWizardController {
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private attempt = 0;
  private owner: object | null = null;
  private restartRequirement: { bootId: string } | null = null;

  constructor(private readonly host: InstallWizardControllerHost) {}

  get busy(): boolean {
    const state = this.host.getState();
    return Boolean(state && ["installing", "reconnecting", "enabling"].includes(state.stage));
  }

  disconnect(): void {
    this.clearReconnectTimeout();
    this.retireAttempt();
  }

  invalidate(): void {
    const state = this.host.getState();
    if (!state) {
      return;
    }
    if (!this.ownerIsCurrent()) {
      this.retireAttempt();
      this.host.setState({
        ...state,
        stage: "error",
        error: t("pluginsPage.installWizard.destinationChanged"),
      });
      return;
    }
    if (this.busy) {
      this.host.setState({ ...state, stage: "reconnecting", error: undefined });
      this.armReconnectTimeout(this.attempt, state.catalogId);
    }
  }

  open(result: PluginDiscoveryDetailResult): void {
    const request = installRequestForDiscoveryDetail(result);
    if (!request) {
      return;
    }
    this.clearReconnectTimeout();
    this.attempt += 1;
    this.owner = this.host.getOwner();
    this.restartRequirement = null;
    this.host.setState({
      catalogId: result.plugin.id,
      detail: result,
      request,
      stage: "review",
    });
    // Prepare the canonical form before the intentional restart so setup can resume immediately.
    void this.host.getRuntimeConfig().ensureLoaded();
    void this.host.getRuntimeConfig().ensureSchemaLoaded();
  }

  close(): void {
    this.clearReconnectTimeout();
    const key = this.key();
    if (key) {
      this.host.getConsentController().cancelMutationObserver(key);
    }
    this.retireAttempt();
    this.host.setState(null);
  }

  cancelConsent(): void {
    this.host.getConsentController().close();
    const state = this.host.getState();
    if (!state) {
      return;
    }
    this.clearReconnectTimeout();
    this.host.setState({
      ...state,
      stage: "error",
      error: t("pluginsPage.installWizard.consentCancelled"),
    });
  }

  begin(): void {
    const state = this.host.getState();
    const key = this.key(state);
    const attempt = this.attempt;
    if (!state || !key || !this.host.canMutate() || !this.isCurrent(attempt, state.catalogId)) {
      return;
    }
    this.host.setState({ ...state, stage: "installing", error: undefined });
    void this.host.getConsentController().install(state.request, key, {
      reviewConfirmed: true,
      onCommitted: async (result) => {
        const current = this.host.getState();
        if (!current || !this.isCurrent(attempt, state.catalogId)) {
          return;
        }
        this.host.setState({
          ...current,
          pluginId: result.plugin.id,
          stage: "reconnecting",
          policyReason: undefined,
          error: undefined,
        });
        if (result.restartRequired) {
          await this.restart(attempt, state.catalogId);
        } else {
          void this.resume();
        }
      },
      onFailure: (error) => this.fail(attempt, state.catalogId, error),
      onInstallPolicyWarning: (_request, reason) => {
        const current = this.host.getState();
        if (current && this.isCurrent(attempt, state.catalogId)) {
          this.host.setState({ ...current, stage: "policy-warning", policyReason: reason });
        }
      },
    });
  }

  continuePolicyWarning(): void {
    const state = this.host.getState();
    const key = this.key(state);
    if (!state || !key || !this.isCurrent(this.attempt, state.catalogId)) {
      return;
    }
    this.host.setState({ ...state, stage: "installing", error: undefined });
    void this.host
      .getConsentController()
      .install({ ...state.request, acknowledgeInstallPolicyWarning: true }, key);
  }

  async resume(): Promise<void> {
    const state = this.host.getState();
    const attempt = this.attempt;
    if (
      !state ||
      state.stage !== "reconnecting" ||
      !this.host.isConnected() ||
      !this.isCurrent(attempt, state.catalogId)
    ) {
      return;
    }
    if (!this.consumeCompletedRestart()) {
      return;
    }
    this.clearReconnectTimeout();
    const plugin = installedPluginForWizard(this.host.getCatalog(), state);
    if (!plugin) {
      this.fail(attempt, state.catalogId, t("pluginsPage.installWizard.installedStateMissing"));
      return;
    }
    if (plugin.state === "error") {
      this.fail(
        attempt,
        state.catalogId,
        plugin.error ?? t("pluginsPage.installWizard.pluginUnhealthy"),
      );
      return;
    }
    const stage = installedPluginWizardStage(plugin);
    this.host.setState({ ...state, pluginId: plugin.id, stage });
    if (stage === "configuring") {
      const runtimeConfig = this.host.getRuntimeConfig();
      if (runtimeConfig.state.connected) {
        await Promise.all([runtimeConfig.ensureLoaded(), runtimeConfig.ensureSchemaLoaded()]);
      }
      if (!this.isCurrent(attempt, state.catalogId)) {
        return;
      }
      const current = this.host.getState();
      if (!current || !this.isCurrent(attempt, state.catalogId)) {
        return;
      }
      this.host.setState({
        ...current,
        configDraft: createPluginConfigurationDraft(runtimeConfig.state.configForm, plugin.id),
      });
    } else if (stage === "enabling") {
      this.enable(plugin.id);
    }
  }

  async saveConfiguration(): Promise<void> {
    const state = this.host.getState();
    if (
      !state?.pluginId ||
      !state.configDraft ||
      state.stage !== "configuring" ||
      !this.host.canEditConfig()
    ) {
      return;
    }
    const attempt = this.attempt;
    if (!this.isCurrent(attempt, state.catalogId)) {
      return;
    }
    const runtimeConfig = this.host.getRuntimeConfig();
    const { pluginId, configDraft } = state;
    const mutation = hasPluginConfigurationChanges(configDraft)
      ? await runtimeConfig.runExternalMutation(
          (client) => {
            const snapshot = runtimeConfig.state.configSnapshot;
            const config = resolveEditableSnapshotConfig(snapshot);
            if (!config || !snapshot?.hash) {
              throw new Error(t("pluginsPage.installWizard.configSaveFailed"));
            }
            return client.request("config.set", {
              raw: serializeConfigForm(buildPluginConfigurationSet(config, configDraft)),
              baseHash: snapshot.hash,
            });
          },
          { canDispatch: () => this.isCurrent(attempt, state.catalogId) },
        )
      : null;
    const saved = mutation === null || mutation.ok;
    if (!saved) {
      this.fail(
        attempt,
        state.catalogId,
        mutation?.error ?? t("pluginsPage.installWizard.configSaveFailed"),
      );
      return;
    }
    if (!this.isCurrent(attempt, state.catalogId)) {
      return;
    }
    await this.host.refreshCatalog();
    if (!this.isCurrent(attempt, state.catalogId)) {
      return;
    }
    this.enable(pluginId);
  }

  patchConfiguration(path: Array<string | number>, value: unknown): void {
    const state = this.host.getState();
    if (state?.configDraft && this.isCurrent(this.attempt, state.catalogId)) {
      this.host.setState({
        ...state,
        configDraft: patchPluginConfigurationDraft(state.configDraft, path, value),
      });
    }
  }

  removeConfiguration(path: Array<string | number>): void {
    const state = this.host.getState();
    if (state?.configDraft && this.isCurrent(this.attempt, state.catalogId)) {
      this.host.setState({
        ...state,
        configDraft: removePluginConfigurationDraftValue(state.configDraft, path),
      });
    }
  }

  retry(): void {
    const state = this.host.getState();
    if (!state) {
      return;
    }
    if (!this.ownerIsCurrent()) {
      this.attempt += 1;
      this.owner = this.host.getOwner();
      this.host.setState({
        ...state,
        pluginId: undefined,
        configDraft: undefined,
        stage: "review",
        error: undefined,
      });
      return;
    }
    if (state.pluginId && state.configDraft) {
      this.host.setState({ ...state, stage: "configuring", error: undefined });
      return;
    }
    if (state.pluginId) {
      this.host.setState({ ...state, stage: "reconnecting", error: undefined });
      if (this.restartRequirement && !this.consumeCompletedRestart()) {
        void this.restart(this.attempt, state.catalogId);
        return;
      }
      this.armReconnectTimeout(this.attempt, state.catalogId);
      void this.host.refreshCatalog().then(() => this.resume());
      return;
    }
    this.host.setState({ ...state, stage: "review", error: undefined });
  }

  manage(): void {
    const pluginId = this.host.getState()?.pluginId;
    if (!pluginId) {
      return;
    }
    this.close();
    this.host.onManage(pluginId);
  }

  private key(state = this.host.getState()): string | null {
    return state ? `install:${state.catalogId}` : null;
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private armReconnectTimeout(attempt: number, catalogId: string): void {
    this.clearReconnectTimeout();
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      const state = this.host.getState();
      if (
        state?.catalogId === catalogId &&
        state.stage === "reconnecting" &&
        this.isCurrent(attempt, catalogId)
      ) {
        this.fail(attempt, catalogId, t("pluginsPage.installWizard.reconnectTimedOut"));
      }
    }, INSTALL_RECONNECT_TIMEOUT_MS);
  }

  private fail(attempt: number, catalogId: string, error: string): void {
    const state = this.host.getState();
    if (state?.catalogId === catalogId && this.isCurrent(attempt, catalogId)) {
      this.clearReconnectTimeout();
      this.host.setState({ ...state, stage: "error", error });
    }
  }

  private enable(pluginId: string): void {
    const state = this.host.getState();
    const attempt = this.attempt;
    if (!state || !this.isCurrent(attempt, state.catalogId)) {
      return;
    }
    const key = pluginRowKey(pluginId);
    this.host.setState({
      ...state,
      pluginId,
      configDraft: undefined,
      stage: "enabling",
      error: undefined,
    });
    void this.host.getConsentController().updateEnabled(
      pluginId,
      true,
      key,
      {},
      {
        onCommitted: (result) => {
          const current = this.host.getState();
          if (!current || !this.isCurrent(attempt, state.catalogId)) {
            return;
          }
          if (result.plugin.state === "error") {
            this.fail(
              attempt,
              state.catalogId,
              result.plugin.error ?? t("pluginsPage.installWizard.pluginUnhealthy"),
            );
            return;
          }
          this.host.setState({
            ...current,
            pluginId: result.plugin.id,
            stage: result.restartRequired ? "reconnecting" : "success",
          });
          if (result.restartRequired) {
            void this.restart(attempt, state.catalogId);
          } else {
            this.clearReconnectTimeout();
          }
        },
        onFailure: (error) => this.fail(attempt, state.catalogId, error),
      },
    );
  }

  private ownerIsCurrent(): boolean {
    return this.owner !== null && this.owner === this.host.getOwner();
  }

  private isCurrent(attempt: number, catalogId: string): boolean {
    return (
      attempt === this.attempt &&
      this.ownerIsCurrent() &&
      this.host.getState()?.catalogId === catalogId
    );
  }

  private retireAttempt(): void {
    this.attempt += 1;
    this.owner = null;
    this.restartRequirement = null;
  }

  private async restart(attempt: number, catalogId: string): Promise<void> {
    if (!this.isCurrent(attempt, catalogId)) {
      return;
    }
    if (!this.restartRequirement) {
      const bootId = this.host.getBootId()?.trim();
      if (!bootId) {
        this.fail(attempt, catalogId, t("pluginsPage.installWizard.restartFailed"));
        return;
      }
      // Restart scheduling is only acceptance. The next hello must prove that a
      // different Gateway process loaded the new plugin inventory.
      this.restartRequirement = { bootId };
    }
    try {
      await this.host.requestRestart(t("pluginsPage.installWizard.restartReason"));
    } catch (error) {
      this.fail(
        attempt,
        catalogId,
        error instanceof Error ? error.message : t("pluginsPage.installWizard.restartFailed"),
      );
      return;
    }
    if (this.isCurrent(attempt, catalogId)) {
      this.armReconnectTimeout(attempt, catalogId);
    }
  }

  private consumeCompletedRestart(): boolean {
    if (!this.restartRequirement) {
      return true;
    }
    const bootId = this.host.getBootId()?.trim();
    if (!bootId || bootId === this.restartRequirement.bootId) {
      return false;
    }
    this.restartRequirement = null;
    return true;
  }
}
