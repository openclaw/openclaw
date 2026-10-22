import { isGatewayProtocolResponseError } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { onCleanup } from "solid-js";
import { Check } from "typebox/value";
import type { CapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  PluginsInstallProgressEventSchema,
  type PluginsSetEnabledParams,
} from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import {
  inspectPlugin,
  readPluginCapabilityConsentError,
} from "../../lib/plugins/capability-consent-error.ts";
import {
  runPluginConfigMutation,
  setPluginEnabled,
  type PluginInstallRequest,
  type PluginListResult,
  type PluginMutationResult,
  type PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import type {
  PluginConsentInspectionRead,
  PluginConsentIntent,
  PluginConsentState,
} from "./consent-dialog.tsx";
import { readPluginInstallPolicyWarning } from "./install-policy-warning.ts";
import type { PluginInstallProgress } from "./install-progress.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.tsx";
import type { PluginMutationAction } from "./plugins-page-model.ts";

type PluginMutationSuccess<Result> = (
  result: Result,
  refreshError: string | null,
  client: GatewayBrowserClient,
  isLatest: () => boolean,
) => Promise<void>;

type PluginMutationOptions = {
  action: PluginMutationAction;
  confirm?: () => Promise<boolean>;
  preserveMessageWhilePending?: boolean;
};

type PluginsConsentOptions = {
  gateway: GatewayPageBinding;
  getContext: () => ApplicationContext;
  getResult: () => PluginListResult | null;
  canMutate: () => boolean;
  isBusy: (rowKey: string) => boolean;
  setBusy: (rowKey: string, action: PluginMutationAction | null) => void;
  setMessage: (rowKey: string, message: PluginRowMessage | null) => void;
  getMessages: () => Readonly<Record<string, PluginRowMessage>>;
  clearPageNotice: () => void;
  closeDetails: () => void;
  applyMutationResult: (result: PluginMutationResult) => void;
  refreshCatalogAfterMutation: (client: GatewayBrowserClient) => Promise<void>;
  onChange: () => void;
};

export function pluginMutationWarnings(
  result: Pick<PluginMutationResult, "warnings">,
  refreshError: string | null,
): PluginRowMessage | null {
  const warnings = [
    ...(result.warnings ?? []).map((warning) => formatUiExternalText(warning)),
    refreshError ? t("pluginsPage.configRefreshFailed", { error: refreshError }) : null,
  ].filter(Boolean);
  return warnings.length ? { kind: "warning", text: warnings.join("\n") } : null;
}

function pluginRuntimeFailureText(details: Record<string, unknown> | undefined, text: string) {
  const phase =
    asOptionalRecord(details?.runtimeAttempt)?.phase ?? asOptionalRecord(details?.runtime)?.phase;
  return typeof phase === "string"
    ? [text, t("pluginsPage.runtimeFailurePhase", { phase: formatUiExternalText(phase) })]
        .filter(Boolean)
        .join("\n")
    : text;
}

export function createPluginsConsent(host: PluginsConsentOptions) {
  const state: {
    consent: PluginConsentState | null;
    inspection: PluginsInspectResult | null;
    inspectionLoading: boolean;
    inspectionError: string | null;
    inspectionRead: PluginConsentInspectionRead | null;
    installProgress: Map<string, PluginInstallProgress>;
  } = {
    consent: null,
    inspection: null,
    inspectionLoading: false,
    inspectionError: null,
    inspectionRead: null,
    installProgress: new Map<string, PluginInstallProgress>(),
  };
  onCleanup(() => {
    retireInspection();
    state.consent = null;
    mutationTokens.clear();
    state.installProgress.clear();
    installPolicyScopes.clear();
  });
  let nextMutationToken = 0;
  let inspectionCompletion: PromiseWithResolvers<string | null> | null = null;
  const mutationTokens = new Map<string, number>();
  // Warning acknowledgement belongs to the connection that admitted the install.
  const installPolicyScopes = new Map<string, GatewayConnectionScope>();

  function getActiveInstall(rowKey: string): PluginInstallProgress | undefined {
    const direct = state.installProgress.get(rowKey);
    if (direct && direct.finishedAt === undefined) {
      return direct;
    }
    // Inventory can publish the installed identity before the install RPC settles.
    // Reuse its catalog relation so presentation and mutation admission keep one owner.
    const plugin = host.getResult()?.plugins.find((entry) => pluginRowKey(entry.id) === rowKey);
    const progress = plugin?.catalogId
      ? state.installProgress.get(`install:${plugin.catalogId}`)
      : undefined;
    return progress?.finishedAt === undefined ? progress : undefined;
  }

  function reset(): void {
    close();
    mutationTokens.clear();
    state.installProgress.clear();
    installPolicyScopes.clear();
  }

  function reconcileInstallMessages(
    result: PluginListResult | null,
  ): Record<string, PluginRowMessage> {
    const messages = { ...host.getMessages() };
    const previous = host.getResult();
    for (const [key, message] of Object.entries(messages)) {
      const id = message.savedInstall;
      if (!id) {
        continue;
      }
      const installed = result?.plugins.some((plugin) => plugin.id === id && plugin.installed);
      // Inventory takes ownership of a saved install and its later removal. Retire only
      // finished attempts; an active install still owns progress until its final response.
      if (
        installed ||
        (result && previous?.plugins.some((plugin) => plugin.id === id && plugin.installed))
      ) {
        if (state.installProgress.get(key)?.finishedAt !== undefined) {
          state.installProgress.delete(key);
        }
        if (!installed || key !== pluginRowKey(id)) {
          delete messages[key];
        }
      }
    }
    return messages;
  }

  async function runMutation<Result>(
    rowKey: string,
    mutate: (client: GatewayBrowserClient) => Promise<Result>,
    onSuccess: PluginMutationSuccess<Result>,
    options: PluginMutationOptions,
    onError: (
      error: unknown,
      scope: GatewayConnectionScope,
      isCurrent: () => boolean,
    ) => void | Promise<void> = (error) => {
      host.setMessage(rowKey, { kind: "error", text: formatUiError(error) });
    },
  ): Promise<void> {
    const scope = host.gateway.capture();
    const canDispatch = () => host.canMutate() && !getActiveInstall(rowKey);
    if (!scope || !canDispatch() || host.isBusy(rowKey)) {
      return;
    }
    if (
      options.confirm &&
      (!(await options.confirm()) ||
        !host.gateway.isCurrent(scope) ||
        !canDispatch() ||
        host.isBusy(rowKey))
    ) {
      return;
    }
    // Confirmation, config queue, and request share the captured Gateway epoch and client.
    host.clearPageNotice();
    const mutationToken = ++nextMutationToken;
    mutationTokens.set(rowKey, mutationToken);
    const isCurrent = () =>
      host.gateway.isCurrent(scope) && mutationTokens.get(rowKey) === mutationToken;
    const isLatest = () => isCurrent() && nextMutationToken === mutationToken;
    host.setBusy(rowKey, options.action);
    if (!options.preserveMessageWhilePending) {
      host.setMessage(rowKey, null);
    }
    try {
      const mutation = await runPluginConfigMutation(
        host.getContext().runtimeConfig,
        scope.client,
        mutate,
        { canDispatch: () => isCurrent() && canDispatch() },
      );
      if (isCurrent()) {
        await onSuccess(mutation.value, mutation.refreshError, scope.client, isLatest);
      }
    } catch (error) {
      if (isCurrent()) {
        await onError(error, scope, isCurrent);
      }
    } finally {
      if (mutationTokens.get(rowKey) === mutationToken) {
        mutationTokens.delete(rowKey);
        host.setBusy(rowKey, null);
      }
    }
  }

  function open(
    intent: PluginConsentIntent,
    pluginId: string,
    details?: CapabilityConsentErrorDetails,
  ): void {
    if (!host.canMutate()) {
      return;
    }
    const plugin = host.getResult()?.plugins.find((entry) => entry.id === pluginId);
    host.closeDetails();
    retireInspection();
    state.inspection = null;
    state.inspectionError = null;
    state.inspectionLoading = true;
    state.consent = {
      intent,
      pluginId,
      fallback: {
        name: plugin?.name ?? pluginId,
        ...(plugin?.version ? { version: plugin.version } : {}),
        ...(plugin?.origin === "official" ? { official: true } : {}),
      },
      ...(details ? { details } : {}),
    };
    host.onChange();
    void inspect();
  }

  function close(): void {
    retireInspection();
    state.consent = null;
    state.inspection = null;
    state.inspectionLoading = false;
    state.inspectionError = null;
    host.onChange();
  }

  function retireInspection(): void {
    // Closing or replacing the modal releases presentation before its RPC settles.
    inspectionCompletion?.resolve(null);
    inspectionCompletion = null;
    state.inspectionRead = null;
  }

  async function inspect(): Promise<void> {
    const consent = state.consent;
    const scope = host.gateway.capture();
    if (!consent?.pluginId || !scope) {
      return;
    }
    retireInspection();
    const completion = Promise.withResolvers<string | null>();
    inspectionCompletion = completion;
    state.inspectionRead = { result: completion.promise };
    state.inspectionLoading = true;
    state.inspectionError = null;
    host.onChange();
    let error: string | null = null;
    try {
      const inspection = await inspectPlugin(scope.client, consent.pluginId);
      if (host.gateway.isCurrent(scope) && state.consent === consent) {
        state.inspection = inspection;
      }
    } catch (cause) {
      if (host.gateway.isCurrent(scope) && state.consent === consent) {
        error = state.inspectionError = formatUiError(cause);
      }
    } finally {
      if (host.gateway.isCurrent(scope) && state.consent === consent) {
        state.inspectionLoading = false;
        host.onChange();
      }
      completion.resolve(error);
    }
  }

  function confirm(): void {
    const intent = state.consent?.intent;
    const reviewToken = state.inspection?.reviewToken;
    if (!intent || state.inspectionLoading || state.inspectionError || !reviewToken) {
      return;
    }
    close();
    void mutateInstalledPlugin(intent.pluginId, intent.kind, intent.rowKey, {
      acknowledgeCapabilities: { reviewToken },
    });
  }

  async function install(request: PluginInstallRequest, installIdentity: string): Promise<void> {
    const installed = host
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
    const messages = host.getMessages();
    const saved =
      messages[installIdentity] ?? (installed ? messages[pluginRowKey(installed.id)] : undefined);
    if (saved?.savedInstall) {
      return;
    }
    const confirmedScope = installPolicyScopes.get(installIdentity);
    installPolicyScopes.delete(installIdentity);
    if (
      request.acknowledgeInstallPolicyWarning &&
      (!confirmedScope || !host.gateway.isCurrent(confirmedScope))
    ) {
      host.setMessage(installIdentity, {
        kind: "error",
        text: t("pluginsPage.installDestinationChanged"),
      });
      return;
    }
    // The Gateway owns artifact acceptance and validation within this install request.
    await runMutation(
      installIdentity,
      async (client) => {
        const scope = host.gateway.capture();
        let progress: PluginInstallProgress = { startedAt: Date.now(), activities: [] };
        state.installProgress.set(installIdentity, progress);
        host.onChange();
        const current = () =>
          scope &&
          host.gateway.isCurrent(scope) &&
          state.installProgress.get(installIdentity) === progress;
        let requestId: string | undefined;
        const unsubscribe = client.addEventListener((event) => {
          if (
            event.event !== "plugins.install.progress" ||
            !Check(PluginsInstallProgressEventSchema, event.payload) ||
            event.payload.requestId !== requestId ||
            !current()
          ) {
            return;
          }
          const activity = event.payload;
          const index = progress.activities.findIndex(
            (row) => row.activityId === activity.activityId,
          );
          progress = {
            ...progress,
            activities:
              index < 0
                ? [...progress.activities, activity]
                : progress.activities.map((row, at) => (at === index ? activity : row)),
          };
          state.installProgress.set(installIdentity, progress);
          host.onChange();
        });
        let result: PluginMutationResult;
        try {
          result = await client.request<PluginMutationResult>("plugins.install", request, {
            onSent: (id) => {
              requestId = id;
            },
          });
        } finally {
          unsubscribe();
        }
        if (current()) {
          // The final RPC result settles installation before optional config/catalog refreshes.
          state.installProgress.delete(installIdentity);
          host.applyMutationResult(result);
        }
        return result;
      },
      async (result, refreshError, client) => {
        const installedPluginKey = pluginRowKey(result.plugin.id);
        if (installedPluginKey !== installIdentity) {
          host.setMessage(installIdentity, null);
        }
        host.setMessage(installedPluginKey, pluginMutationWarnings(result, refreshError));
        await host.refreshCatalogAfterMutation(client);
      },
      {
        action: "install",
        preserveMessageWhilePending: request.acknowledgeInstallPolicyWarning === true,
      },
      async (error, scope, isCurrent) => {
        const details =
          error instanceof GatewayRequestError ? asOptionalRecord(error.details) : undefined;
        const persistence = asOptionalRecord(details?.persistence);
        const policyWarning = readPluginInstallPolicyWarning(error);
        const canRetry = isGatewayProtocolResponseError(error) && !persistence && !policyWarning;
        const savedInstall =
          persistence?.operation === "install" &&
          typeof persistence.pluginId === "string" &&
          persistence.pluginId.trim()
            ? persistence.pluginId
            : undefined;
        const failureState = savedInstall
          ? "saved"
          : details?.pluginInstallRejected === true
            ? "rejected"
            : canRetry
              ? "retry"
              : "unknown";
        const failure = {
          title: t(`pluginsPage.installProgress.${failureState}.title`),
          recovery: t(`pluginsPage.installProgress.${failureState}.recovery`),
          detail: formatUiError(error),
        };
        const progress = state.installProgress.get(installIdentity);
        if (progress) {
          // Only a correlated final rejection proves an unsaved attempt can restart.
          // Transport loss and saved installs retain their recovery state instead.
          state.installProgress.set(installIdentity, {
            ...progress,
            finishedAt: Date.now(),
            canRetry,
            ...(!policyWarning || savedInstall ? { failure } : {}),
          });
          host.onChange();
        }
        if (savedInstall) {
          const pluginId = savedInstall;
          const key = pluginRowKey(pluginId);
          const runtime = asOptionalRecord(details?.runtime);
          const message: PluginRowMessage = {
            kind: "error",
            savedInstall: pluginId,
            text: pluginRuntimeFailureText(
              details,
              t(
                runtime?.committed === false
                  ? "pluginsPage.installSavedNotApplied"
                  : "pluginsPage.installSaved",
                {
                  name: pluginId,
                  error: formatUiError(error),
                },
              ),
            ),
          };
          // Persistence is independent of runtime publication. Do not offer an install retry
          // while the authoritative reads catch up or fail after this saved outcome.
          await reconcileCommittedFailure([installIdentity, key], message, scope.client, isCurrent);
          return;
        }
        if (policyWarning) {
          installPolicyScopes.set(installIdentity, scope);
          host.setMessage(installIdentity, {
            kind: "warning",
            text: policyWarning.reason,
            installPolicyWarning: { details: policyWarning, request },
          });
          return;
        }
        host.setMessage(installIdentity, {
          kind: "error",
          text: `${failure.recovery}\n${failure.detail}`,
        });
      },
    );
  }

  async function reconcileCommittedFailure(
    keys: string[],
    message: PluginRowMessage,
    client: GatewayBrowserClient,
    isCurrent: () => boolean,
  ): Promise<void> {
    for (const key of keys) {
      host.setMessage(key, message);
    }
    const refreshConfig = host.getContext().runtimeConfig.refresh();
    const [configRefresh] = await Promise.allSettled([
      refreshConfig,
      isCurrent() ? host.refreshCatalogAfterMutation(client) : Promise.resolve(),
    ]);
    if (isCurrent() && configRefresh.status === "rejected") {
      for (const key of new Set(keys)) {
        if (host.getMessages()[key] === message) {
          host.setMessage(key, {
            ...message,
            text: `${message.text}\n${t("pluginsPage.configRefreshFailed", { error: formatUiError(configRefresh.reason) })}`,
          });
        }
      }
    }
  }

  async function mutateInstalledPlugin(
    pluginId: string,
    action: "enable" | "disable",
    rowKey = pluginRowKey(pluginId),
    options: Pick<PluginsSetEnabledParams, "acknowledgeCapabilities"> = {},
  ): Promise<void> {
    await runMutation(
      rowKey,
      (client) => setPluginEnabled(client, pluginId, action === "enable", options),
      async (result, refreshError, client) => {
        host.applyMutationResult(result);
        host.setMessage(rowKey, pluginMutationWarnings(result, refreshError));
        await host.refreshCatalogAfterMutation(client);
      },
      { action },
      async (error, scope, isCurrent) => {
        const details =
          error instanceof GatewayRequestError ? asOptionalRecord(error.details) : undefined;
        const runtime = asOptionalRecord(details?.runtime);
        const consent = readPluginCapabilityConsentError(error);
        if (action !== "disable" && runtime?.committed !== true && consent && host.canMutate()) {
          open({ kind: action, pluginId, rowKey }, consent.pluginId, consent);
          return;
        }
        const savedInstall = host.getMessages()[rowKey]?.savedInstall;
        const message: PluginRowMessage = {
          kind: "error",
          ...(savedInstall ? { savedInstall } : {}),
          text: pluginRuntimeFailureText(details, formatUiError(error)),
        };
        if (runtime?.committed === true) {
          // A published generation survives this failure even when its event was missed.
          await reconcileCommittedFailure([rowKey], message, scope.client, isCurrent);
        } else {
          host.setMessage(rowKey, message);
        }
      },
    );
  }
  return {
    read: () => state,
    getActiveInstall,
    reset,
    reconcileInstallMessages,
    runMutation,
    close,
    inspect,
    confirm,
    install,
    mutateInstalledPlugin,
  };
}
