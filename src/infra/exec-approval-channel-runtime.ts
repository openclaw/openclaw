import type { OpenClawConfig } from "../config/config.js";
import type { GatewayClient } from "../gateway/client.js";
import { createOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

type ApprovalRequestEvent = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolvedEvent = ExecApprovalResolved | PluginApprovalResolved;

export type ExecApprovalChannelRuntimeEventKind = "exec" | "plugin";

type PendingApprovalEntry<TPending, TRequest extends ApprovalRequestEvent> = {
  request: TRequest;
  entries: TPending[];
  timeoutId: NodeJS.Timeout | null;
};

export type ExecApprovalChannelRuntimeAdapter<
  TPending,
  TRequest extends ApprovalRequestEvent = ExecApprovalRequest,
  TResolved extends ApprovalResolvedEvent = ExecApprovalResolved,
> = {
  label: string;
  clientDisplayName: string;
  cfg: OpenClawConfig;
  gatewayUrl?: string;
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  isConfigured: () => boolean;
  shouldHandle: (request: TRequest) => boolean;
  deliverRequested: (request: TRequest) => Promise<TPending[]>;
  finalizeResolved: (params: {
    request: TRequest;
    resolved: TResolved;
    entries: TPending[];
  }) => Promise<void>;
  finalizeExpired?: (params: {
    request: TRequest;
    entries: TPending[];
  }) => Promise<void>;
  nowMs?: () => number;
};

export type ExecApprovalChannelRuntime<
  TRequest extends ApprovalRequestEvent = ExecApprovalRequest,
  TResolved extends ApprovalResolvedEvent = ExecApprovalResolved,
> = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  handleRequested: (request: TRequest) => Promise<void>;
  handleResolved: (resolved: TResolved) => Promise<void>;
  handleExpired: (approvalId: string) => Promise<void>;
  request: <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
};

export function createExecApprovalChannelRuntime<
  TPending,
  TRequest extends ApprovalRequestEvent = ExecApprovalRequest,
  TResolved extends ApprovalResolvedEvent = ExecApprovalResolved,
>(
  adapter: ExecApprovalChannelRuntimeAdapter<TPending, TRequest, TResolved>,
): ExecApprovalChannelRuntime<TRequest, TResolved> {
  const log = createSubsystemLogger(adapter.label);
  const nowMs = adapter.nowMs ?? Date.now;
  const eventKinds = new Set<ExecApprovalChannelRuntimeEventKind>(adapter.eventKinds ?? ["exec"]);
  const pending = new Map<string, PendingApprovalEntry<TPending, TRequest>>();
  let gatewayClient: GatewayClient | null = null;
  let started = false;

  const spawn = (label: string, promise: Promise<void>): void => {
    void promise.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`${label}: ${message}`);
    });
  };

  const clearPendingEntry = (approvalId: string): PendingApprovalEntry<TPending, TRequest> | null => {
    const entry = pending.get(approvalId);
    if (!entry) {
      return null;
    }
    pending.delete(approvalId);
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }
    return entry;
  };

  const handleExpired = async (approvalId: string): Promise<void> => {
    const entry = clearPendingEntry(approvalId);
    if (!entry) {
      return;
    }
    log.debug(`expired ${approvalId}`);
    await adapter.finalizeExpired?.({
      request: entry.request,
      entries: entry.entries,
    });
  };

  const handleRequested = async (request: TRequest): Promise<void> => {
    if (!adapter.shouldHandle(request)) {
      return;
    }

    log.debug(`received request ${request.id}`);
    const entries = await adapter.deliverRequested(request);
    if (!entries.length) {
      return;
    }

    const timeoutMs = Math.max(0, request.expiresAtMs - nowMs());
    const timeoutId = setTimeout(() => {
      void handleExpired(request.id);
    }, timeoutMs);
    timeoutId.unref?.();

    const existing = pending.get(request.id);
    if (existing?.timeoutId) {
      clearTimeout(existing.timeoutId);
    }
    pending.set(request.id, {
      request,
      entries,
      timeoutId,
    });
  };

  const handleResolved = async (resolved: TResolved): Promise<void> => {
    const entry = clearPendingEntry(resolved.id);
    if (!entry) {
      return;
    }
    log.debug(`resolved ${resolved.id} with ${resolved.decision}`);
    await adapter.finalizeResolved({
      request: entry.request,
      resolved,
      entries: entry.entries,
    });
  };

  const handleGatewayEvent = (evt: EventFrame): void => {
    if (evt.event === "exec.approval.requested" && eventKinds.has("exec")) {
      spawn("error handling approval request", handleRequested(evt.payload as TRequest));
      return;
    }
    if (evt.event === "plugin.approval.requested" && eventKinds.has("plugin")) {
      spawn("error handling approval request", handleRequested(evt.payload as TRequest));
      return;
    }
    if (evt.event === "exec.approval.resolved" && eventKinds.has("exec")) {
      spawn("error handling approval resolved", handleResolved(evt.payload as TResolved));
      return;
    }
    if (evt.event === "plugin.approval.resolved" && eventKinds.has("plugin")) {
      spawn("error handling approval resolved", handleResolved(evt.payload as TResolved));
    }
  };

  return {
    async start(): Promise<void> {
      if (started) {
        return;
      }

      if (!adapter.isConfigured()) {
        log.debug("disabled");
        return;
      }

      const client = await createOperatorApprovalsGatewayClient({
        config: adapter.cfg,
        gatewayUrl: adapter.gatewayUrl,
        clientDisplayName: adapter.clientDisplayName,
        onEvent: handleGatewayEvent,
        onHelloOk: () => {
          log.debug("connected to gateway");
        },
        onConnectError: (err) => {
          log.error(`connect error: ${err.message}`);
        },
        onClose: (code, reason) => {
          log.debug(`gateway closed: ${code} ${reason}`);
        },
      });

      client.start();
      gatewayClient = client;
      started = true;
    },

    async stop(): Promise<void> {
      if (!started) {
        return;
      }
      started = false;
      for (const entry of pending.values()) {
        if (entry.timeoutId) {
          clearTimeout(entry.timeoutId);
        }
      }
      pending.clear();
      gatewayClient?.stop();
      gatewayClient = null;
      log.debug("stopped");
    },

    handleRequested,
    handleResolved,
    handleExpired,

    async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
      if (!gatewayClient) {
        throw new Error(`${adapter.label}: gateway client not connected`);
      }
      return (await gatewayClient.request(method, params)) as T;
    },
  };
}
