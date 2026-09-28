import type {
  ModelAuthLogoutResult,
  ModelAuthOrderSetResult,
} from "../../../../src/gateway/server-methods/models-auth-status.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { invalidateModelAuthStatusRequests } from "../../lib/model-auth-request-state.ts";
import {
  isMissingMethodError,
  mergeProbeResults,
  modelProviderErrorMessage,
} from "./config-mutation.ts";
import type { ModelProviderLogoutTarget } from "./data.ts";
import type { ModelProvidersData } from "./load.ts";

type PendingProfileOrder = {
  cardId: string;
  profileIds: string[] | null;
  optimisticOrder: string[];
};

type ProfileActionsControllerOptions = {
  getAgentEpoch: () => number;
  getAgentId: () => string;
  getClient: () => GatewayBrowserClient | null;
  getClientEpoch: () => number;
  getData: () => ModelProvidersData | null;
  getOrders: () => Record<string, string[]>;
  setData: (data: ModelProvidersData) => void;
  setOrders: (orders: Record<string, string[]>) => void;
  canMutate: () => boolean;
  isBusy: (key: string) => boolean;
  setBusy: (key: string, value: boolean) => void;
  setProbeResult: (cardId: string, result: ModelsProbeResult | null) => void;
  setProbeError: (cardId: string, message: string) => void;
  clearMessage: (cardId: string) => void;
  setError: (cardId: string, error: unknown) => void;
  setLogoutSuccess: (warning?: string) => void;
  cancelRefresh: () => void;
  refresh: () => Promise<void>;
  getConfig: () => RuntimeConfigCapability;
  isCurrentClient: (client: GatewayBrowserClient, epoch: number) => boolean;
};

export class ModelProviderProfileActionsController {
  private probeEpochs = new Map<string, number>();
  private probeUnsupported = false;
  private readonly pendingOrders = new Map<string, PendingProfileOrder>();
  private readonly activeOrderProviders = new Set<string>();

  constructor(private readonly options: ProfileActionsControllerOptions) {}

  get probeAvailable(): boolean {
    return !this.probeUnsupported;
  }

  resetProbes(): void {
    this.probeEpochs = new Map();
    this.probeUnsupported = false;
  }

  clearProbe(cardId: string): void {
    this.probeEpochs.set(cardId, (this.probeEpochs.get(cardId) ?? 0) + 1);
    this.options.setBusy("probe:" + cardId, false);
    this.options.setProbeResult(cardId, null);
  }

  async probe(cardId: string, providers: string[]) {
    const client = this.options.getClient();
    const key = `probe:${cardId}`;
    if (!client || !this.options.canMutate() || this.options.isBusy(key) || this.probeUnsupported) {
      return;
    }
    const clientEpoch = this.options.getClientEpoch();
    const agentId = this.options.getAgentId();
    const agentEpoch = this.options.getAgentEpoch();
    const probeEpoch = (this.probeEpochs.get(cardId) ?? 0) + 1;
    this.probeEpochs.set(cardId, probeEpoch);
    const ownsProbe = () =>
      this.options.isCurrentClient(client, clientEpoch) &&
      this.options.getAgentEpoch() === agentEpoch &&
      this.options.getAgentId() === agentId &&
      this.probeEpochs.get(cardId) === probeEpoch;
    this.options.setBusy(key, true);
    this.options.clearMessage(cardId);
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
        this.options.setProbeResult(cardId, mergeProbeResults(cardId, results));
      }
    } catch (error) {
      if (!ownsProbe()) {
        return;
      }
      if (isMissingMethodError(error)) {
        this.probeUnsupported = true;
        this.options.setProbeError(cardId, t("modelProviders.probe.unavailable"));
      } else {
        this.options.setProbeError(cardId, modelProviderErrorMessage(error));
      }
    } finally {
      if (ownsProbe()) {
        this.options.setBusy(key, false);
      }
    }
  }

  resetOrders(): void {
    this.pendingOrders.clear();
    this.options.setOrders({});
  }

  setOrder(cardId: string, provider: string, profileIds: string[] | null): void {
    const providerStatus = this.options
      .getData()
      ?.authStatus?.providers.find((candidate) => candidate.provider === provider);
    const optimisticOrder =
      profileIds ?? providerStatus?.profiles.map((profile) => profile.profileId) ?? [];
    this.options.setOrders({ ...this.options.getOrders(), [provider]: optimisticOrder });
    this.pendingOrders.set(provider, { cardId, profileIds, optimisticOrder });
    this.options.clearMessage(cardId);
    void this.flushOrder(provider);
  }

  flushPendingOrders(): void {
    if (!this.options.canMutate()) {
      return;
    }
    for (const provider of this.pendingOrders.keys()) {
      void this.flushOrder(provider);
    }
  }

  async logout(cardId: string, target: ModelProviderLogoutTarget): Promise<void> {
    const client = this.options.getClient();
    const key = `logout:${cardId}`;
    if (!client || !this.options.canMutate() || this.options.isBusy(key)) {
      return;
    }
    const clientEpoch = this.options.getClientEpoch();
    const agentId = this.options.getAgentId();
    const agentEpoch = this.options.getAgentEpoch();
    const isCurrentScope = () => this.isCurrentScope(client, clientEpoch, agentEpoch, agentId);
    this.clearProbe(cardId);
    this.options.setBusy(key, true);
    this.options.clearMessage(cardId);
    try {
      const result = await this.options.getConfig().runExternalMutation(
        async (activeClient) => {
          const receipt = await activeClient.request<ModelAuthLogoutResult>("models.authLogout", {
            ...target,
            agentId,
          });
          invalidateModelAuthStatusRequests(activeClient);
          return receipt;
        },
        { canDispatch: () => isCurrentScope() && this.options.canMutate() },
      );
      if (!isCurrentScope()) {
        return;
      }
      if (!result.ok) {
        await this.options.refresh();
        if (isCurrentScope()) {
          this.options.setError(cardId, result.error);
        }
        return;
      }
      const warnings = result.value.warning ? [result.value.warning] : [];
      if (!result.refresh.ok) {
        warnings.push(result.refresh.error);
      } else {
        try {
          await this.options.refresh();
          const warning = this.options.getData()?.error;
          if (warning) {
            warnings.push(warning);
          }
        } catch (error) {
          warnings.push(modelProviderErrorMessage(error));
        }
      }
      if (isCurrentScope()) {
        this.options.setLogoutSuccess(warnings.join(" ") || undefined);
      }
    } catch (error) {
      if (isCurrentScope()) {
        this.options.setError(cardId, error);
      }
    } finally {
      if (isCurrentScope()) {
        this.options.setBusy(key, false);
      }
    }
  }

  private async flushOrder(provider: string): Promise<void> {
    if (this.activeOrderProviders.has(provider)) {
      return;
    }
    this.activeOrderProviders.add(provider);
    try {
      while (true) {
        const pending = this.pendingOrders.get(provider);
        if (!pending) {
          return;
        }
        const client = this.options.getClient();
        if (!client || !this.options.canMutate()) {
          return;
        }
        this.pendingOrders.delete(provider);
        const clientEpoch = this.options.getClientEpoch();
        const agentEpoch = this.options.getAgentEpoch();
        const agentId = this.options.getAgentId();
        try {
          const result = await client.request<ModelAuthOrderSetResult>("models.authOrderSet", {
            provider,
            ...(pending.profileIds ? { profileIds: pending.profileIds } : {}),
            agentId,
          });
          invalidateModelAuthStatusRequests(client);
          if (!this.isCurrentScope(client, clientEpoch, agentEpoch, agentId)) {
            return;
          }
          if (pending.profileIds && !result.warning) {
            this.options.cancelRefresh();
            this.applyOrder(provider, pending.profileIds);
            void this.options.refresh();
          } else {
            await this.options.refresh();
            if (!this.isCurrentScope(client, clientEpoch, agentEpoch, agentId)) {
              return;
            }
          }
          if (this.clearOptimisticOrder(provider, pending.optimisticOrder) && result.warning) {
            this.options.setError(pending.cardId, result.warning);
          }
        } catch (error) {
          if (!this.isCurrentScope(client, clientEpoch, agentEpoch, agentId)) {
            return;
          }
          if (this.clearOptimisticOrder(provider, pending.optimisticOrder)) {
            this.options.setError(pending.cardId, error);
          }
        }
      }
    } finally {
      this.activeOrderProviders.delete(provider);
      // A stale save can finish after a new agent queued the same provider.
      // Re-enter after releasing the slot so the new scope's intent is not stranded.
      if (this.pendingOrders.has(provider) && this.options.canMutate()) {
        void this.flushOrder(provider);
      }
    }
  }

  private isCurrentScope(
    client: GatewayBrowserClient,
    clientEpoch: number,
    agentEpoch: number,
    agentId: string,
  ): boolean {
    return (
      this.options.isCurrentClient(client, clientEpoch) &&
      this.options.getAgentEpoch() === agentEpoch &&
      this.options.getAgentId() === agentId
    );
  }

  private clearOptimisticOrder(provider: string, expected: string[]): boolean {
    const orders = this.options.getOrders();
    if (orders[provider] !== expected) {
      return false;
    }
    const next = { ...orders };
    delete next[provider];
    this.options.setOrders(next);
    return true;
  }

  private applyOrder(provider: string, profileIds: string[]): void {
    const data = this.options.getData();
    const authStatus = data?.authStatus;
    if (!data || !authStatus) {
      return;
    }
    const providers = [...authStatus.providers];
    for (const [index, candidate] of providers.entries()) {
      if ((candidate.authProvider ?? candidate.provider) !== provider) {
        continue;
      }
      const { profileOrder: _order, profileOrderStored: _stored, ...base } = candidate;
      providers[index] = {
        ...base,
        profileOrder: [...profileIds],
        profileOrderStored: true,
      };
    }
    this.options.setData({ ...data, authStatus: { ...authStatus, providers } });
  }
}
