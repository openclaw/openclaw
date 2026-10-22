import type {
  ModelAuthLogoutResult,
  ModelAuthOrderSetResult,
} from "../../../../src/gateway/server-methods/models-auth-status.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { invalidateModelAuthStatusRequests } from "../../lib/model-auth-request-state.ts";
import {
  mergeProbeResults,
  modelProviderErrorMessage,
  modelProviderMutationWarnings,
} from "./config-mutation.ts";
import type {
  ModelProviderLogoutTarget,
  ModelProviderPendingLogout,
  ModelProviderRemovalTarget,
} from "./data.ts";
import type { ModelProvidersData } from "./load.ts";
import { showProfileActionError, showProfileLogoutSuccess } from "./profiles-view.tsx";
import { updateRecordEntry } from "./record-state.ts";

type PendingProfileOrder = {
  profileIds: string[] | null;
  optimisticOrder: string[];
};

type ProfileActionsOptions = {
  getAgentEpoch: () => number;
  getAgentId: () => string;
  getClient: () => GatewayBrowserClient | null;
  getClientEpoch: () => number;
  getData: () => ModelProvidersData | null;
  getOrders: () => Record<string, string[]>;
  setData: (data: ModelProvidersData) => void;
  setOrders: (orders: Record<string, string[]>) => void;
  canMutate: () => boolean;
  hasMutationAccess: () => boolean;
  isBusy: (key: string) => boolean;
  setBusy: (key: string, value: boolean) => void;
  setProbeResult: (cardId: string, result: ModelsProbeResult | null) => void;
  setProbeError: (cardId: string, message: string) => void;
  clearMessage: (cardId: string) => void;
  cancelRefresh: () => void;
  refresh: () => Promise<void>;
  getConfig: () => RuntimeConfigCapability;
  isCurrentClient: (client: GatewayBrowserClient, epoch: number) => boolean;
  onLogoutStarted: (receipt: { cardId: string; completion: Promise<void> }) => void;
};

export function createModelProviderProfileActions(options: ProfileActionsOptions) {
  let logoutConfirmation: AbortController | null = null;
  let probeEpochs = new Map<string, number>();
  const pendingOrders = new Map<string, PendingProfileOrder>();
  const activeOrderProviders = new Set<string>();

  function resetProbes(): void {
    probeEpochs = new Map();
  }

  function clearProbe(cardId: string): void {
    probeEpochs.set(cardId, (probeEpochs.get(cardId) ?? 0) + 1);
    options.setBusy("probe:" + cardId, false);
    options.setProbeResult(cardId, null);
  }

  async function probe(cardId: string, providers: string[]) {
    const client = options.getClient();
    const key = `probe:${cardId}`;
    if (!client || !options.canMutate() || options.isBusy(key)) {
      return;
    }
    const { agentId, isCurrent } = captureScope(client);
    const probeEpoch = (probeEpochs.get(cardId) ?? 0) + 1;
    probeEpochs.set(cardId, probeEpoch);
    const ownsProbe = () => isCurrent() && probeEpochs.get(cardId) === probeEpoch;
    options.setBusy(key, true);
    options.clearMessage(cardId);
    try {
      const results: ModelsProbeResult[] = [];
      for (const provider of providers) {
        if (!ownsProbe()) {
          return;
        }
        results.push(
          await client.request<ModelsProbeResult>("models.probe", { provider, agentId }),
        );
      }
      if (ownsProbe()) {
        options.setProbeResult(cardId, mergeProbeResults(cardId, results));
      }
    } catch (error) {
      if (!ownsProbe()) {
        return;
      }
      options.setProbeError(cardId, modelProviderErrorMessage(error));
    } finally {
      if (ownsProbe()) {
        options.setBusy(key, false);
      }
    }
  }

  function resetOrders(): void {
    pendingOrders.clear();
    options.setOrders({});
  }

  function setOrder(cardId: string, provider: string, profileIds: string[] | null): void {
    const providerStatus = options
      .getData()
      ?.authStatus?.providers.find((candidate) => candidate.provider === provider);
    const optimisticOrder =
      profileIds ?? providerStatus?.profiles.map((profile) => profile.profileId) ?? [];
    options.setOrders({ ...options.getOrders(), [provider]: optimisticOrder });
    pendingOrders.set(provider, { profileIds, optimisticOrder });
    options.clearMessage(cardId);
    void flushOrder(provider);
  }

  function flushPendingOrders(): void {
    if (!options.canMutate()) {
      return;
    }
    for (const provider of pendingOrders.keys()) {
      void flushOrder(provider);
    }
  }

  function cancelLogout(): void {
    logoutConfirmation?.abort();
  }

  async function requestLogout(pending: ModelProviderPendingLogout): Promise<void> {
    if (logoutConfirmation || !options.canMutate() || options.isBusy(`logout:${pending.cardId}`)) {
      return;
    }
    // Agent changes, reconnects and navigation abort this decision before it can
    // authorize a logout under a different scope.
    const controller = new AbortController();
    logoutConfirmation = controller;
    const removing = "removeTargets" in pending;
    const confirmed = await showConfirmDialog({
      title: removing
        ? t("modelProviders.remove.title", { provider: pending.label })
        : t("modelProviders.logout.actionFor", { account: pending.label }),
      message: removing
        ? [
            pending.removeTargets.some((target) => !target.credentialType)
              ? t("modelProviders.remove.accounts", { provider: pending.label })
              : "",
            pending.configKey ? t("modelProviders.remove.keys", { key: pending.configKey }) : "",
            pending.keptSource
              ? t("modelProviders.remove.kept", { source: pending.keptSource })
              : "",
          ]
            .filter(Boolean)
            .join(" ")
        : t("modelProviders.logout.confirm", { provider: pending.label }),
      confirmLabel: t(removing ? "modelProviders.remove.action" : "modelProviders.logout.action"),
      danger: true,
      signal: controller.signal,
    }).finally(() => {
      logoutConfirmation = null;
    });
    if (confirmed && !controller.signal.aborted && options.canMutate()) {
      await logout(pending.cardId, removing ? pending.removeTargets : [pending.target]);
    }
  }

  /** Account targets sign out their profiles; removal targets clear a provider or its API key. */
  async function logout(
    cardId: string,
    targets: Array<ModelProviderLogoutTarget | ModelProviderRemovalTarget>,
  ): Promise<void> {
    const client = options.getClient();
    const key = `logout:${cardId}`;
    if (!client || !options.canMutate() || options.isBusy(key)) {
      return;
    }
    const scope = captureScope(client);
    clearProbe(cardId);
    options.setBusy(key, true);
    options.clearMessage(cardId);
    const completion = settleLogout(key, targets, scope);
    options.onLogoutStarted({ cardId, completion });
    return completion;
  }

  async function settleLogout(
    key: string,
    targets: Array<ModelProviderLogoutTarget | ModelProviderRemovalTarget>,
    { agentId, isCurrent }: ReturnType<typeof captureScope>,
  ): Promise<void> {
    const receipts: ModelAuthLogoutResult[] = [];
    try {
      const result = await options.getConfig().runExternalMutation(
        async (activeClient) => {
          try {
            for (const target of targets) {
              if (!isCurrent() || !options.hasMutationAccess()) {
                throw new Error(t("modelProviders.remove.accessChanged"));
              }
              receipts.push(
                await activeClient.request<ModelAuthLogoutResult>("models.authLogout", {
                  ...target,
                  agentId,
                }),
              );
            }
          } finally {
            invalidateModelAuthStatusRequests(activeClient);
          }
          const warning = receipts.flatMap((receipt) => receipt.warning ?? []).join(" ");
          return { ...receipts.at(-1)!, ...(warning ? { warning } : {}) };
        },
        { canDispatch: () => isCurrent() && options.canMutate() },
      );
      if (!isCurrent()) {
        return;
      }
      if (!result.ok) {
        let refreshError: string | undefined;
        try {
          await options.refresh();
          refreshError = options.getData()?.error ?? undefined;
        } catch (error) {
          refreshError = modelProviderErrorMessage(error);
        }
        if (isCurrent()) {
          const completed = new Set(receipts.flatMap((receipt) => receipt.removedProfiles ?? []));
          showProfileActionError(
            [
              receipts.length
                ? t("modelProviders.remove.partial", { count: String(completed.size) })
                : "",
              ...receipts.flatMap((receipt) => receipt.warning ?? []),
              result.error,
              refreshError,
            ]
              .filter(Boolean)
              .join(" "),
          );
        }
        return;
      }
      const warning = await modelProviderMutationWarnings(result, async () => {
        await options.refresh();
        return options.getData()?.error;
      });
      if (isCurrent()) {
        showProfileLogoutSuccess(warning || undefined);
      }
    } catch (error) {
      if (isCurrent()) {
        showProfileActionError(error);
      }
    } finally {
      if (isCurrent()) {
        options.setBusy(key, false);
      }
    }
  }

  async function flushOrder(provider: string): Promise<void> {
    if (activeOrderProviders.has(provider)) {
      return;
    }
    activeOrderProviders.add(provider);
    let pending: PendingProfileOrder | undefined;
    try {
      while (true) {
        pending = pendingOrders.get(provider);
        if (!pending) {
          return;
        }
        const client = options.getClient();
        if (!client || !options.canMutate()) {
          return;
        }
        const { agentId, isCurrent } = captureScope(client);
        try {
          const result = await client.request<ModelAuthOrderSetResult>("models.authOrderSet", {
            provider,
            ...(pending.profileIds ? { profileIds: pending.profileIds } : {}),
            agentId,
          });
          invalidateModelAuthStatusRequests(client);
          if (!isCurrent()) {
            return;
          }
          if (pendingOrders.get(provider) === pending) {
            pendingOrders.delete(provider);
          }
          if (pending.profileIds && !result.warning) {
            options.cancelRefresh();
            applyOrder(provider, pending.profileIds);
            void options.refresh();
          } else {
            await options.refresh();
            if (!isCurrent()) {
              return;
            }
          }
          if (clearOptimisticOrder(provider, pending.optimisticOrder) && result.warning) {
            showProfileActionError(result.warning);
          }
        } catch (error) {
          if (!isCurrent()) {
            return;
          }
          if (pendingOrders.get(provider) === pending) {
            showProfileActionError(error);
          }
          return;
        }
      }
    } finally {
      activeOrderProviders.delete(provider);
      // A stale save can finish after a new agent queued the same provider.
      // Re-enter after releasing the slot so the new scope's intent is not stranded.
      if (
        pendingOrders.has(provider) &&
        pendingOrders.get(provider) !== pending &&
        options.canMutate()
      ) {
        void flushOrder(provider);
      }
    }
  }

  function captureScope(client: GatewayBrowserClient) {
    const clientEpoch = options.getClientEpoch();
    const agentId = options.getAgentId();
    const agentEpoch = options.getAgentEpoch();
    return {
      agentId,
      isCurrent: () =>
        options.isCurrentClient(client, clientEpoch) &&
        options.getAgentEpoch() === agentEpoch &&
        options.getAgentId() === agentId,
    };
  }

  function clearOptimisticOrder(provider: string, expected: string[]): boolean {
    const orders = options.getOrders();
    if (orders[provider] !== expected) {
      return false;
    }
    options.setOrders(updateRecordEntry<string[]>(orders, provider, null));
    return true;
  }

  function applyOrder(provider: string, profileIds: string[]): void {
    const data = options.getData();
    const authStatus = data?.authStatus;
    if (!data || !authStatus) {
      return;
    }
    const providers = authStatus.providers.map((candidate) =>
      (candidate.authProvider ?? candidate.provider) === provider
        ? { ...candidate, profileOrder: [...profileIds], profileOrderStored: true }
        : candidate,
    );
    options.setData({ ...data, authStatus: { ...authStatus, providers } });
  }
  return {
    resetProbes,
    clearProbe,
    probe,
    resetOrders,
    setOrder,
    flushPendingOrders,
    cancelLogout,
    requestLogout,
    logout,
  };
}
