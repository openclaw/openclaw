import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { CapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type {
  PluginsReloadParams,
  PluginsReloadResult,
} from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  inspectPlugin,
  readPluginCapabilityConsentError,
} from "../../lib/plugins/capability-consent-error.ts";
import {
  installPlugin,
  runPluginConfigMutation,
  setPluginEnabled,
  type PluginInstallRequest,
  type PluginListResult,
  type PluginMutationResult,
  type PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import type { PluginConsentIntent, PluginConsentState } from "./consent-dialog.ts";
import {
  readPluginInstallPolicyWarning,
  type PluginInstallPolicyWarningDetails,
} from "./install-policy-warning.ts";
import { confirmPluginInstall } from "./plugin-lifecycle-confirmation.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.ts";

type PluginMutationSuccess<Result> = (
  result: Result,
  refreshError: string | null,
  client: GatewayBrowserClient,
  isCurrent: () => boolean,
  isLatest: () => boolean,
) => Promise<void>;

type PluginMutationOptions = {
  canDispatch?: () => boolean;
  confirm?: () => Promise<boolean>;
  preserveMessageWhilePending?: boolean;
};

export type PluginMutationObserver = {
  reviewConfirmed?: boolean;
  onCommitted?: (result: PluginMutationResult, refreshError: string | null) => void | Promise<void>;
  onReloaded?: () => void | Promise<void>;
  onFailure?: (error: string, savedPluginId?: string) => void;
  onInstallPolicyWarning?: (
    request: PluginInstallRequest,
    details: PluginInstallPolicyWarningDetails,
  ) => void;
};

type PluginsConsentControllerHost = {
  gateway: GatewayPageController;
  getContext: () => ApplicationContext;
  getResult: () => PluginListResult | null;
  canMutate: () => boolean;
  canReload: () => boolean;
  isBusy: (rowKey: string) => boolean;
  setBusy: (rowKey: string, busy: boolean) => void;
  setMessage: (rowKey: string, message: PluginRowMessage | null) => void;
  getMessages: () => Readonly<Record<string, PluginRowMessage>>;
  clearPageNotice: () => void;
  closeDetails: () => void;
  applyMutationResult: (result: PluginMutationResult) => void;
  refreshCatalogAfterMutation: (client: GatewayBrowserClient) => Promise<void>;
  requestUpdate: () => void;
};

export function committedMutationMessage(
  action: "installed" | "enabled" | "disabled" | "removed" | "reloaded",
  name: string,
  result: Pick<PluginMutationResult, "warnings" | "runtime">,
  refreshError: string | null,
): PluginRowMessage {
  return {
    kind: "success",
    text: [
      t(`pluginsPage.${action}Success`, {
        name,
        ...(result.runtime ? { generation: String(result.runtime.generation) } : {}),
      }),
      ...(result.warnings ?? []).map((warning) => formatUiExternalText(warning)),
      refreshError ? t("pluginsPage.configRefreshFailed", { error: refreshError }) : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export class PluginsConsentController {
  consent: PluginConsentState | null = null;
  inspection: PluginsInspectResult | null = null;
  inspectionLoading = false;
  inspectionError: string | null = null;

  private mutationToken = 0;
  private readonly mutationTokens = new Map<string, number>();
  private readonly mutationObservers = new Map<string, PluginMutationObserver>();
  // Server reviews continue one confirmed install only while its Gateway epoch survives.
  // Reconnect reset drops the scope before a surviving row warning can be acknowledged.
  private readonly confirmedInstallScopes = new Map<string, GatewayConnectionScope>();

  constructor(private readonly host: PluginsConsentControllerHost) {}

  reset(): void {
    this.close();
    this.mutationTokens.clear();
    this.mutationObservers.clear();
    this.confirmedInstallScopes.clear();
  }

  reconcileInstallMessages(result: PluginListResult | null): Record<string, PluginRowMessage> {
    const messages = { ...this.host.getMessages() };
    const previous = this.host.getResult();
    for (const [key, message] of Object.entries(messages)) {
      const id = message.savedInstall;
      if (!id) {
        continue;
      }
      const installed = result?.plugins.some((plugin) => plugin.id === id && plugin.installed);
      // Once inventory knows the saved install, its canonical row owns the error.
      // An observed later removal also retires the receipt, allowing a fresh install.
      if (
        (installed && key !== pluginRowKey(id)) ||
        (result &&
          !installed &&
          previous?.plugins.some((plugin) => plugin.id === id && plugin.installed))
      ) {
        delete messages[key];
      }
    }
    return messages;
  }

  async runMutation<Result>(
    rowKey: string,
    mutate: (client: GatewayBrowserClient) => Promise<Result>,
    onSuccess: PluginMutationSuccess<Result>,
    options: PluginMutationOptions = {},
    onError: (
      error: unknown,
      scope: GatewayConnectionScope,
      isCurrent: () => boolean,
    ) => void | Promise<void> = (error) => {
      this.host.setMessage(rowKey, { kind: "error", text: formatUiError(error) });
    },
  ): Promise<void> {
    const scope = this.host.gateway.capture();
    const canDispatch = options.canDispatch ?? this.host.canMutate;
    if (!scope || !canDispatch() || this.host.isBusy(rowKey)) {
      return;
    }
    if (
      options.confirm &&
      (!(await options.confirm()) ||
        !this.host.gateway.isCurrent(scope) ||
        !canDispatch() ||
        this.host.isBusy(rowKey))
    ) {
      return;
    }
    // Confirmation, config queue, and request share the captured Gateway epoch and client.
    this.host.clearPageNotice();
    const mutationToken = ++this.mutationToken;
    this.mutationTokens.set(rowKey, mutationToken);
    const isCurrent = () =>
      this.host.gateway.isCurrent(scope) && this.mutationTokens.get(rowKey) === mutationToken;
    const isLatest = () => isCurrent() && this.mutationToken === mutationToken;
    this.host.setBusy(rowKey, true);
    if (!options.preserveMessageWhilePending) {
      this.host.setMessage(rowKey, null);
    }
    try {
      const mutation = await runPluginConfigMutation(
        this.host.getContext().runtimeConfig,
        scope.client,
        mutate,
        { canDispatch: () => isCurrent() && canDispatch() },
      );
      if (isCurrent()) {
        await onSuccess(mutation.value, mutation.refreshError, scope.client, isCurrent, isLatest);
      }
    } catch (error) {
      if (isCurrent()) {
        await onError(error, scope, isCurrent);
      }
    } finally {
      if (this.mutationTokens.get(rowKey) === mutationToken) {
        this.mutationTokens.delete(rowKey);
        this.host.setBusy(rowKey, false);
      }
    }
  }

  private open(
    intent: PluginConsentIntent,
    pluginId: string,
    details?: CapabilityConsentErrorDetails,
  ): void {
    if (!this.host.canMutate()) {
      return;
    }
    const plugin = this.host.getResult()?.plugins.find((entry) => entry.id === pluginId);
    this.host.closeDetails();
    this.inspection = null;
    this.inspectionError = null;
    this.inspectionLoading = true;
    this.consent = {
      intent,
      pluginId,
      fallback: {
        name: plugin?.name ?? pluginId,
        ...(plugin?.version ? { version: plugin.version } : {}),
        ...(plugin?.origin === "official" ? { official: true } : {}),
      },
      ...(details ? { details } : {}),
    };
    this.host.requestUpdate();
    void this.inspect();
  }

  close(): void {
    this.consent = null;
    this.inspection = null;
    this.inspectionLoading = false;
    this.inspectionError = null;
    this.host.requestUpdate();
  }

  cancelMutationObserver(key: string): void {
    this.mutationObservers.delete(key);
    this.confirmedInstallScopes.delete(key);
  }

  async inspect(): Promise<void> {
    const consent = this.consent;
    const scope = this.host.gateway.capture();
    if (!consent?.pluginId || !scope) {
      return;
    }
    this.inspectionLoading = true;
    this.inspectionError = null;
    this.host.requestUpdate();
    try {
      const inspection = await inspectPlugin(scope.client, consent.pluginId);
      if (this.host.gateway.isCurrent(scope) && this.consent === consent) {
        this.inspection = inspection;
      }
    } catch (error) {
      if (this.host.gateway.isCurrent(scope) && this.consent === consent) {
        this.inspectionError = formatUiError(error);
      }
    } finally {
      if (this.host.gateway.isCurrent(scope) && this.consent === consent) {
        this.inspectionLoading = false;
        this.host.requestUpdate();
      }
    }
  }

  confirm(): void {
    const intent = this.consent?.intent;
    const reviewToken = this.inspection?.reviewToken;
    if (!intent || this.inspectionLoading || this.inspectionError || !reviewToken) {
      return;
    }
    this.close();
    if (intent.kind === "install") {
      void this.install(
        {
          ...intent.request,
          acknowledgeCapabilities: { reviewToken },
        },
        intent.installIdentity,
      );
    } else {
      void this.mutateInstalledPlugin(intent.pluginId, intent.kind, intent.rowKey, {
        acknowledgeCapabilities: { reviewToken },
      });
    }
  }

  async install(
    request: PluginInstallRequest,
    installIdentity: string,
    observer?: PluginMutationObserver,
  ): Promise<void> {
    const installed = this.host
      .getResult()
      ?.plugins.find(
        (plugin) =>
          plugin.installed &&
          (request.source === "official" || request.source === "bundled"
            ? plugin.id === request.pluginId
            : request.source === "clawhub"
              ? plugin.packageName === request.packageName
              : "expectedPluginId" in request && plugin.id === request.expectedPluginId),
      );
    const messages = this.host.getMessages();
    const saved =
      messages[installIdentity] ?? (installed ? messages[pluginRowKey(installed.id)] : undefined);
    if (saved?.savedInstall) {
      observer?.onFailure?.(saved.text, saved.savedInstall);
      return;
    }
    if (observer) {
      this.mutationObservers.set(installIdentity, observer);
    }
    const installObserver = this.mutationObservers.get(installIdentity);
    const confirmedScope = this.confirmedInstallScopes.get(installIdentity);
    this.confirmedInstallScopes.delete(installIdentity);
    const isConfirmedContinuation =
      (request.acknowledgeInstallPolicyWarning === true ||
        request.acknowledgeCapabilities !== undefined) &&
      confirmedScope &&
      this.host.gateway.isCurrent(confirmedScope);
    // The server stages and inspects the requested artifact before asking for consent.
    // Catalog/search metadata cannot authorize that artifact's capabilities.
    await this.runMutation(
      installIdentity,
      (client) => installPlugin(client, request),
      async (result, refreshError, client, isCurrent) => {
        const installedPluginKey = pluginRowKey(result.plugin.id);
        this.host.applyMutationResult(result);
        if (installedPluginKey !== installIdentity) {
          this.host.setMessage(installIdentity, null);
        }
        this.host.setMessage(
          installedPluginKey,
          committedMutationMessage("installed", result.plugin.name, result, refreshError),
        );
        await this.host.refreshCatalogAfterMutation(client);
        if (isCurrent()) {
          const currentObserver = this.mutationObservers.get(installIdentity);
          this.mutationObservers.delete(installIdentity);
          await currentObserver?.onCommitted?.(result, refreshError);
        }
      },
      {
        confirm:
          isConfirmedContinuation || installObserver?.reviewConfirmed
            ? undefined
            : () => confirmPluginInstall(request),
        preserveMessageWhilePending: request.acknowledgeInstallPolicyWarning === true,
      },
      async (error, scope, isCurrent) => {
        const details =
          error instanceof GatewayRequestError ? asOptionalRecord(error.details) : undefined;
        const persistence = asOptionalRecord(details?.persistence);
        if (
          persistence?.operation === "install" &&
          typeof persistence.pluginId === "string" &&
          persistence.pluginId.trim()
        ) {
          const pluginId = persistence.pluginId;
          const key = pluginRowKey(pluginId);
          const runtime = asOptionalRecord(details?.runtime);
          const phase = asOptionalRecord(details?.runtimeAttempt)?.phase ?? runtime?.phase;
          const message: PluginRowMessage = {
            kind: "error",
            savedInstall: pluginId,
            text: [
              t(
                runtime?.committed === false
                  ? "pluginsPage.installSavedNotApplied"
                  : "pluginsPage.installSaved",
                {
                  name: pluginId,
                  error: formatUiError(error),
                },
              ),
              typeof phase === "string"
                ? t("pluginsPage.runtimeFailurePhase", { phase: formatUiExternalText(phase) })
                : null,
            ]
              .filter(Boolean)
              .join("\n"),
          };
          // Persistence is independent of runtime publication. Do not offer an install retry
          // while the authoritative reads catch up or fail after this saved outcome.
          await this.reconcileCommittedFailure(
            [installIdentity, key],
            message,
            scope.client,
            isCurrent,
          );
          if (isCurrent()) {
            const savedInstallObserver = this.mutationObservers.get(installIdentity);
            this.mutationObservers.delete(installIdentity);
            savedInstallObserver?.onFailure?.(message.text, pluginId);
          }
          return;
        }
        const consentDetails = readPluginCapabilityConsentError(error);
        if (consentDetails) {
          this.confirmedInstallScopes.set(installIdentity, scope);
          this.open(
            { kind: "install", request, installIdentity },
            consentDetails.pluginId,
            consentDetails,
          );
          return;
        }
        const policyWarning = readPluginInstallPolicyWarning(error);
        if (policyWarning) {
          this.confirmedInstallScopes.set(installIdentity, scope);
          this.host.setMessage(installIdentity, {
            kind: "warning",
            text: policyWarning.reason,
            installPolicyWarning: { details: policyWarning, request },
          });
          this.mutationObservers
            .get(installIdentity)
            ?.onInstallPolicyWarning?.(request, policyWarning);
          return;
        }
        const message = formatUiError(error);
        this.host.setMessage(installIdentity, { kind: "error", text: message });
        const currentObserver = this.mutationObservers.get(installIdentity);
        this.mutationObservers.delete(installIdentity);
        currentObserver?.onFailure?.(message);
      },
    );
  }

  private async reconcileCommittedFailure(
    keys: string[],
    message: PluginRowMessage,
    client: GatewayBrowserClient,
    isCurrent: () => boolean,
  ): Promise<void> {
    for (const key of keys) {
      this.host.setMessage(key, message);
    }
    const refreshConfig = this.host.getContext().runtimeConfig.refresh();
    const [configRefresh] = await Promise.allSettled([
      refreshConfig,
      isCurrent() ? this.host.refreshCatalogAfterMutation(client) : Promise.resolve(),
    ]);
    if (isCurrent() && configRefresh.status === "rejected") {
      for (const key of new Set(keys)) {
        if (this.host.getMessages()[key] === message) {
          this.host.setMessage(key, {
            ...message,
            text: `${message.text}\n${t("pluginsPage.configRefreshFailed", { error: formatUiError(configRefresh.reason) })}`,
          });
        }
      }
    }
  }

  async mutateInstalledPlugin(
    pluginId: string,
    action: "enable" | "disable" | "reload",
    rowKey = pluginRowKey(pluginId),
    options: Pick<PluginsReloadParams, "acknowledgeCapabilities"> = {},
    observer?: PluginMutationObserver,
  ): Promise<void> {
    const key = action === "reload" ? pluginRowKey(pluginId) : rowKey;
    if (observer) {
      this.mutationObservers.set(key, observer);
    }
    const name =
      this.host.getResult()?.plugins.find((entry) => entry.id === pluginId)?.name ?? pluginId;
    let onSettled: (() => void | Promise<void>) | undefined;
    await this.runMutation<PluginMutationResult | PluginsReloadResult>(
      key,
      (client) => {
        if (action !== "reload") {
          return setPluginEnabled(client, pluginId, action === "enable", options);
        }
        if (
          isGatewayMethodAdvertised(this.host.getContext().gateway.snapshot, "plugins.reload") !==
          true
        ) {
          throw new Error(t("pluginsPage.reloadUnavailable"));
        }
        if (rowKey !== key) {
          this.host.setMessage(rowKey, null);
        }
        return client.request<PluginsReloadResult>("plugins.reload", {
          plugins: [{ pluginId }],
          ...options,
        });
      },
      async (result, refreshError, client, isCurrent) => {
        if ("plugin" in result) {
          this.host.applyMutationResult(result);
        }
        this.host.setMessage(
          key,
          committedMutationMessage(
            action === "reload" ? "reloaded" : action === "enable" ? "enabled" : "disabled",
            "plugin" in result ? result.plugin.name : name,
            result,
            refreshError,
          ),
        );
        await this.host.refreshCatalogAfterMutation(client);
        if (isCurrent()) {
          const currentObserver = this.mutationObservers.get(key);
          this.mutationObservers.delete(key);
          if ("plugin" in result) {
            onSettled = () => currentObserver?.onCommitted?.(result, refreshError);
          } else {
            onSettled = currentObserver?.onReloaded;
          }
        }
      },
      {
        // Pure reload changes runtime only; accepting capabilities still persists consent.
        canDispatch:
          action === "reload" && !options.acknowledgeCapabilities ? this.host.canReload : undefined,
        preserveMessageWhilePending: action === "reload",
      },
      async (error, scope, isCurrent) => {
        const details =
          error instanceof GatewayRequestError ? asOptionalRecord(error.details) : undefined;
        const runtime = asOptionalRecord(details?.runtime);
        const consent = readPluginCapabilityConsentError(error);
        if (
          action !== "disable" &&
          runtime?.committed !== true &&
          consent &&
          this.host.canMutate()
        ) {
          this.open({ kind: action, pluginId, rowKey }, consent.pluginId, consent);
          return;
        }
        const phase = asOptionalRecord(details?.runtimeAttempt)?.phase ?? runtime?.phase;
        const savedInstall = this.host.getMessages()[key]?.savedInstall;
        const message: PluginRowMessage = {
          kind: "error",
          ...(savedInstall ? { savedInstall } : {}),
          text: [
            formatUiError(error),
            typeof phase === "string"
              ? t("pluginsPage.runtimeFailurePhase", { phase: formatUiExternalText(phase) })
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        };
        if (runtime?.committed === true) {
          // A published generation survives this failure even when its event was missed.
          await this.reconcileCommittedFailure([key], message, scope.client, isCurrent);
        } else {
          this.host.setMessage(key, message);
        }
        if (isCurrent()) {
          const currentObserver = this.mutationObservers.get(key);
          this.mutationObservers.delete(key);
          currentObserver?.onFailure?.(message.text, savedInstall);
        }
      },
    );
    // A follow-up enable may use this same row; release mutation ownership first.
    await onSettled?.();
  }
}
