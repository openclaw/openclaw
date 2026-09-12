import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
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

registerPluginManagementEnglish();

const INSTALL_RECONNECT_TIMEOUT_MS = 30_000;

type InstallWizardControllerHost = {
  getState: () => PluginInstallWizardState | null;
  setState: (state: PluginInstallWizardState | null) => void;
  getCatalog: () => PluginListResult | null;
  getRuntimeConfig: () => ApplicationContext["runtimeConfig"];
  getConsentController: () => PluginsConsentController;
  getOwner: () => object;
  isConnected: () => boolean;
  canMutate: () => boolean;
  canEditConfig: () => boolean;
  refreshCatalog: () => Promise<void>;
  onManage: (pluginId: string) => void;
};

export class InstallWizardController {
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private attempt = 0;
  private owner: object | null = null;

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
      this.retireAttempt();
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
    if (!installRequestForDiscoveryDetail(result)) {
      return;
    }
    this.prepareOpen()?.open(result);
  }

  prepareOpen() {
    if (this.busy) {
      return null;
    }
    // Detail loading belongs to the same attempt as review and installation.
    this.close();
    this.owner = this.host.getOwner();
    const attempt = this.attempt;
    const isCurrent = () => attempt === this.attempt && this.ownerIsCurrent();
    return {
      isCurrent,
      open: (result: PluginDiscoveryDetailResult) => {
        const request = installRequestForDiscoveryDetail(result);
        if (!isCurrent() || !request) {
          return;
        }
        this.host.setState({
          catalogId: result.plugin.id,
          detail: result,
          request,
          stage: "review",
        });
        // Prepare configuration while the operator reviews the package.
        void this.host.getRuntimeConfig().ensureLoaded();
        void this.host.getRuntimeConfig().ensureSchemaLoaded();
      },
    };
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
          policyWarning: undefined,
          error: undefined,
        });
        await this.resume();
      },
      onFailure: (error, pluginId) => {
        const current = this.host.getState();
        if (pluginId && current && this.isCurrent(attempt, state.catalogId)) {
          this.host.setState({ ...current, pluginId, savedInstall: true });
        }
        this.fail(attempt, state.catalogId, error);
      },
      onInstallPolicyWarning: (_request, policyWarning) => {
        const current = this.host.getState();
        if (current && this.isCurrent(attempt, state.catalogId)) {
          this.host.setState({ ...current, stage: "policy-warning", policyWarning });
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
    this.host.setState({ ...state, pluginId: plugin.id, savedInstall: undefined, stage });
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
    if (!state || (state.savedInstall && !this.host.canMutate())) {
      return;
    }
    if (!this.ownerIsCurrent()) {
      this.attempt += 1;
      this.owner = this.host.getOwner();
      this.host.setState({
        ...state,
        pluginId: undefined,
        configDraft: undefined,
        savedInstall: undefined,
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
      if (state.savedInstall) {
        const attempt = this.attempt;
        void this.host.getConsentController().mutateInstalledPlugin(
          state.pluginId,
          "reload",
          pluginRowKey(state.pluginId),
          {},
          {
            onReloaded: () => this.resume(),
            onFailure: (error) => this.fail(attempt, state.catalogId, error),
          },
        );
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
    void this.host.getConsentController().mutateInstalledPlugin(
      pluginId,
      "enable",
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
            stage: "success",
          });
          this.clearReconnectTimeout();
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
  }
}
