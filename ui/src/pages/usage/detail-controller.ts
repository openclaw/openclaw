import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
} from "../../components/panel-refresh-status.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import {
  requestSessionUsage,
  requestSessionUsageLogs,
  requestSessionUsageTimeSeries,
  type SessionUsageQuery,
  type SessionUsageTarget,
} from "../../lib/sessions/usage.ts";
import { createUsageRequest } from "./request.ts";
import type { SessionLogEntry, UsageSessionEntry } from "./types.ts";

type UsageDetailTarget = Pick<UsageSessionEntry, "key" | "agentId" | "sessionId">;

function sameUsageTarget(a: UsageDetailTarget | undefined, b: UsageDetailTarget): boolean {
  return a?.key === b.key && a.agentId === b.agentId && a.sessionId === b.sessionId;
}

function createUsageDetailRequest<T>(
  notify: () => void,
  gateway: GatewayPageBinding,
  request: (
    client: GatewayBrowserClient,
    target: SessionUsageTarget,
    signal: AbortSignal,
    sessionId: string | undefined,
  ) => Promise<T>,
  resolveTarget: (key: string) => UsageDetailTarget,
  canLoad?: (key: string) => boolean,
  onClear?: () => void,
) {
  let value: { target: UsageDetailTarget; data?: T } | null = null;
  let status = createPanelRefreshStatus();
  let pending: Promise<void> | null = null;
  const task = createUsageRequest(notify, {
    task: async (
      [client, target]: readonly [GatewayBrowserClient, UsageDetailTarget],
      { signal },
    ) => ({
      target,
      // Qualified keys can name disk-backed owners outside the configured roster.
      // Keep key-only wire routing while retaining the full local target identity.
      data: await request(
        client,
        {
          key: target.key,
          ...(!parseAgentSessionKeyParts(target.key.trim()) && target.agentId
            ? { agentId: target.agentId }
            : {}),
        },
        signal,
        target.sessionId,
      ),
    }),
    onComplete: (result) => {
      pending = null;
      value = result;
      status = completePanelRefresh();
    },
    onError: (error) => {
      pending = null;
      const clearData = isMissingOperatorReadScopeError(error);
      status = failPanelRefresh(
        clearData ? createPanelRefreshStatus() : status,
        error,
        gateway.snapshot,
      );
      if (clearData && value) {
        delete value.data;
      }
      if (clearData && status.error) {
        status = { ...status, error: formatMissingOperatorReadScopeMessage("usage details") };
      }
    },
  });

  const cancel = () => {
    if (pending && gateway.snapshot && !isGatewayAvailable(gateway.snapshot)) {
      status = failPanelRefresh(status, undefined, gateway.snapshot);
    }
    pending = null;
    task.cancel();
  };
  const reset = (target?: UsageDetailTarget) => {
    value = target ? { target } : null;
    status = createPanelRefreshStatus();
    onClear?.();
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
      const target = resolveTarget(sessionKey);
      await pending;
      if (
        !pending &&
        (!value || sameUsageTarget(value.target, target)) &&
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
        reset(enabled ? target : undefined);
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
      return (pending = task.run([client, target]));
    },
    cancel,
    clear() {
      reset();
      cancel();
    },
  };
}

export class UsageDetailsController {
  readonly timeSeries;
  readonly sessionLogs;
  readonly session;

  constructor(
    notify: () => void,
    gateway: GatewayPageBinding,
    query: () => SessionUsageQuery,
    sessions: () => UsageSessionEntry[],
    clearTimeSeriesRange: () => void,
  ) {
    const resolveTarget = (key: string): UsageDetailTarget => {
      const session = sessions().find((entry) => entry.key === key);
      const agentId = session?.agentId ?? query().agentId;
      return { key, ...(agentId ? { agentId } : {}), sessionId: session?.sessionId };
    };
    this.timeSeries = createUsageDetailRequest(
      notify,
      gateway,
      requestSessionUsageTimeSeries,
      resolveTarget,
      undefined,
      clearTimeSeriesRange,
    );
    this.sessionLogs = createUsageDetailRequest(
      notify,
      gateway,
      async (client, target) => {
        const payload = await requestSessionUsageLogs(client, target);
        // SAFETY: sessions.usage.logs returns entries normalized by the Gateway's loadSessionLogs.
        return Array.isArray(payload.logs) ? (payload.logs as SessionLogEntry[]) : null;
      },
      resolveTarget,
    );
    this.session = createUsageDetailRequest(
      notify,
      gateway,
      async (client, target, signal, sessionId) => {
        const result = await requestSessionUsage(
          client,
          { ...query(), agentId: target.agentId },
          { key: target.key, includeContextWeight: true, signal },
        );
        const session = result.sessions[0];
        if (
          sessionId !== undefined &&
          session?.sessionId !== undefined &&
          session.sessionId !== sessionId
        ) {
          throw new Error(t("usage.details.contextOutOfDate"));
        }
        return session;
      },
      resolveTarget,
    );
  }

  load(sessionKey: string, refreshAll = true): void {
    void this.session.load(sessionKey, refreshAll);
    void this.timeSeries.load(sessionKey, refreshAll);
    void this.sessionLogs.load(sessionKey, refreshAll);
  }

  cancel(): void {
    this.session.cancel();
    this.timeSeries.cancel();
    this.sessionLogs.cancel();
  }

  clear(): void {
    this.session.clear();
    this.timeSeries.clear();
    this.sessionLogs.clear();
  }
}
