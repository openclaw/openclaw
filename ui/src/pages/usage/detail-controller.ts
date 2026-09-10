import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
} from "../../components/panel-refresh-status.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import {
  requestSessionUsage,
  requestSessionUsageLogs,
  requestSessionUsageTimeSeries,
  type SessionUsageQuery,
  type SessionUsageTarget,
} from "../../lib/sessions/usage.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { failUsageDetailRefresh } from "./detail-refresh.ts";
import { createUsageRequest } from "./request.ts";
import type { SessionLogEntry, UsageSessionEntry } from "./types.ts";

function sameUsageTarget(a: SessionUsageTarget | undefined, b: SessionUsageTarget): boolean {
  return a?.key === b.key && a.agentId === b.agentId;
}

function createUsageDetailRequest<T>(
  host: ReactiveControllerHost,
  gateway: GatewayPageController,
  request: (
    client: GatewayBrowserClient,
    target: SessionUsageTarget,
    signal: AbortSignal,
  ) => Promise<T>,
  resolveTarget: (key: string) => SessionUsageTarget,
  canLoad?: (key: string) => boolean,
) {
  let value: { target: SessionUsageTarget; data?: T } | null = null;
  let status = createPanelRefreshStatus();
  let pending: Promise<void> | null = null;
  let generation = 0;
  const task = createUsageRequest(host, {
    task: async (
      [client, target]: readonly [GatewayBrowserClient, SessionUsageTarget],
      { signal },
    ) => ({
      target,
      // Qualified keys can name disk-backed owners outside the configured roster.
      // Keep key-only wire routing while retaining the full local target identity.
      data: await request(
        client,
        parseAgentSessionKeyParts(target.key.trim()) ? { key: target.key } : target,
        signal,
      ),
    }),
    onComplete: (result) => {
      pending = null;
      value = result;
      status = completePanelRefresh();
    },
    onError: (error) => {
      pending = null;
      const failure = failUsageDetailRefresh(status, error, gateway.snapshot);
      if (failure.clearData && value) {
        delete value.data;
      }
      status = failure.status;
    },
  });

  const cancel = () => {
    if (pending && gateway.snapshot && !isGatewayAvailable(gateway.snapshot)) {
      status = failPanelRefresh(status, undefined, gateway.snapshot);
    }
    pending = null;
    generation += 1;
    task.cancel();
  };
  return {
    get data() {
      return value?.data ?? null;
    },
    get status() {
      return status;
    },
    get loading() {
      return pending !== null;
    },
    async recover(sessionKey: string, loadInitial = false): Promise<void> {
      const current = generation;
      const target = resolveTarget(sessionKey);
      await pending;
      if (
        current === generation &&
        sameUsageTarget(target, resolveTarget(sessionKey)) &&
        gateway.snapshot &&
        isGatewayAvailable(gateway.snapshot) &&
        (status.awaitingGateway || status.error !== null || (loadInitial && !status.hasLoaded))
      ) {
        void this.load(sessionKey);
      }
    },
    load(sessionKey: string, refresh = true): Promise<void> {
      const client = gateway.client;
      if (!client || !gateway.connected) {
        return Promise.resolve();
      }
      const enabled = Boolean(sessionKey) && canLoad?.(sessionKey) !== false;
      const target = resolveTarget(sessionKey);
      const sameTarget = sameUsageTarget(value?.target, target);
      if (!sameTarget || !enabled) {
        value = enabled ? { target } : null;
        status = createPanelRefreshStatus();
      }
      if (!enabled) {
        cancel();
        return Promise.resolve();
      }
      // Routine overview refresh retains matching details, but never another owner's data.
      if (!refresh && sameTarget) {
        return pending ?? Promise.resolve();
      }
      status = beginPanelRefresh(status);
      generation += 1;
      return (pending = task.run([client, target]));
    },
    cancel,
    clear() {
      value = null;
      status = createPanelRefreshStatus();
      cancel();
    },
  };
}

export class UsageDetailsController {
  readonly timeSeries;
  readonly sessionLogs;
  readonly contextWeight;

  constructor(
    host: ReactiveControllerHost,
    gateway: GatewayPageController,
    query: () => SessionUsageQuery,
    sessions: () => UsageSessionEntry[],
  ) {
    const resolveTarget = (key: string): SessionUsageTarget => {
      const agentId = sessions().find((session) => session.key === key)?.agentId ?? query().agentId;
      return { key, ...(agentId ? { agentId } : {}) };
    };
    this.timeSeries = createUsageDetailRequest(
      host,
      gateway,
      requestSessionUsageTimeSeries,
      resolveTarget,
    );
    this.sessionLogs = createUsageDetailRequest(
      host,
      gateway,
      async (client, target) => {
        const payload = await requestSessionUsageLogs(client, target);
        // SAFETY: sessions.usage.logs returns entries normalized by the Gateway's loadSessionLogs.
        return Array.isArray(payload.logs) ? (payload.logs as SessionLogEntry[]) : null;
      },
      resolveTarget,
    );
    this.contextWeight = createUsageDetailRequest(
      host,
      gateway,
      async (client, target, signal) => {
        const result = await requestSessionUsage(
          client,
          { ...query(), agentId: target.agentId },
          {
            key: target.key,
            includeContextWeight: true,
            signal,
          },
        );
        return result.sessions[0]?.contextWeight;
      },
      resolveTarget,
      (key) => sessions().some((session) => session.key === key && session.hasContextWeight),
    );
  }

  load(sessionKey: string, refreshAll = true): void {
    void this.timeSeries.load(sessionKey, refreshAll);
    void this.sessionLogs.load(sessionKey, refreshAll);
    void this.contextWeight.load(sessionKey);
  }

  cancel(): void {
    this.timeSeries.cancel();
    this.sessionLogs.cancel();
    this.contextWeight.cancel();
  }

  clear(): void {
    this.timeSeries.clear();
    this.sessionLogs.clear();
    this.contextWeight.clear();
  }
}
