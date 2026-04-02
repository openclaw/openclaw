import type { ReplyPayload } from "../auto-reply/types.js";
import { getChannelPlugin, resolveChannelApprovalAdapter } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type {
  ExecApprovalForwardingConfig,
  ExecApprovalForwardTarget,
} from "../config/types.approvals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildApprovalPendingReplyPayload,
  buildApprovalResolvedReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  buildPluginApprovalResolvedReplyPayload,
} from "../plugin-sdk/approval-renderers.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
  type DeliverableMessageChannel,
} from "../utils/message-channel.js";
import { matchesApprovalRequestFilters } from "./approval-request-filters.js";
import { resolveExecApprovalCommandDisplay } from "./exec-approval-command-display.js";
import { formatExecApprovalExpiresIn } from "./exec-approval-reply.js";
import { resolveExecApprovalSessionTarget } from "./exec-approval-session-target.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
} from "./exec-approvals.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import {
  approvalDecisionLabel,
  buildPluginApprovalExpiredMessage,
  buildPluginApprovalRequestMessage,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "./plugin-approvals.js";

const log = createSubsystemLogger("gateway/exec-approvals");
export type { ExecApprovalRequest, ExecApprovalResolved };

type ApprovalKind = "exec" | "plugin";
type ForwardTarget = ExecApprovalForwardTarget & { source: "session" | "target" };

type ApprovalRouteRequest = {
  agentId?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

type PendingApproval<TRouteRequest extends ApprovalRouteRequest> = {
  routeRequest: TRouteRequest;
  targets: ForwardTarget[];
  timeoutId: NodeJS.Timeout | null;
};

type ApprovalRenderContext<TRouteRequest extends ApprovalRouteRequest> = {
  cfg: OpenClawConfig;
  target: ForwardTarget;
  routeRequest: TRouteRequest;
};

type ApprovalPendingRenderContext<
  TRequest,
  TRouteRequest extends ApprovalRouteRequest,
> = ApprovalRenderContext<TRouteRequest> & {
  request: TRequest;
  nowMs: number;
};

type ApprovalResolvedRenderContext<
  TResolved,
  TRouteRequest extends ApprovalRouteRequest,
> = ApprovalRenderContext<TRouteRequest> & {
  resolved: TResolved;
};

type ApprovalStrategy<
  TRequest,
  TResolved,
  TRouteRequest extends ApprovalRouteRequest = ApprovalRouteRequest,
> = {
  kind: ApprovalKind;
  config: (cfg: OpenClawConfig) => ExecApprovalForwardingConfig | undefined;
  getRequestId: (request: TRequest) => string;
  getResolvedId: (resolved: TResolved) => string;
  getExpiresAtMs: (request: TRequest) => number;
  getRouteRequestFromRequest: (request: TRequest) => TRouteRequest;
  getRouteRequestFromResolved: (resolved: TResolved) => TRouteRequest | null;
  buildExpiredText: (request: TRequest) => string;
  buildPendingPayload: (
    params: ApprovalPendingRenderContext<TRequest, TRouteRequest>,
  ) => ReplyPayload;
  buildResolvedPayload: (
    params: ApprovalResolvedRenderContext<TResolved, TRouteRequest>,
  ) => ReplyPayload;
};

export type ExecApprovalForwarder = {
  handleRequested: (request: ExecApprovalRequest) => Promise<boolean>;
  handleResolved: (resolved: ExecApprovalResolved) => Promise<void>;
  handlePluginApprovalRequested?: (request: PluginApprovalRequest) => Promise<boolean>;
  handlePluginApprovalResolved?: (resolved: PluginApprovalResolved) => Promise<void>;
  stop: () => void;
};

export type ExecApprovalForwarderDeps = {
  getConfig?: () => OpenClawConfig;
  deliver?: typeof deliverOutboundPayloads;
  nowMs?: () => number;
  resolveSessionTarget?: (params: {
    cfg: OpenClawConfig;
    request: ExecApprovalRequest;
  }) => ExecApprovalForwardTarget | null;
};

const DEFAULT_MODE = "session" as const;
const SYNTHETIC_APPROVAL_REQUEST_ID = "__approval-routing__";

function normalizeMode(mode?: ExecApprovalForwardingConfig["mode"]) {
  return mode ?? DEFAULT_MODE;
}

function shouldForwardRoute(params: {
  config?: {
    enabled?: boolean;
    agentFilter?: string[];
    sessionFilter?: string[];
  };
  routeRequest: ApprovalRouteRequest;
}): boolean {
  const config = params.config;
  if (!config?.enabled) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: params.routeRequest,
    agentFilter: config.agentFilter,
    sessionFilter: config.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

function buildTargetKey(target: ExecApprovalForwardTarget): string {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  const accountId = target.accountId ?? "";
  const threadId = target.threadId ?? "";
  return [channel, target.to, accountId, threadId].join(":");
}

function buildSyntheticApprovalRequest(routeRequest: ApprovalRouteRequest): ExecApprovalRequest {
  return {
    id: SYNTHETIC_APPROVAL_REQUEST_ID,
    request: {
      command: "",
      agentId: routeRequest.agentId ?? null,
      sessionKey: routeRequest.sessionKey ?? null,
      turnSourceChannel: routeRequest.turnSourceChannel ?? null,
      turnSourceTo: routeRequest.turnSourceTo ?? null,
      turnSourceAccountId: routeRequest.turnSourceAccountId ?? null,
      turnSourceThreadId: routeRequest.turnSourceThreadId ?? null,
    },
    createdAtMs: 0,
    expiresAtMs: 0,
  };
}

function shouldSkipForwardingFallback(params: {
  approvalKind: "exec" | "plugin";
  target: ExecApprovalForwardTarget;
  cfg: OpenClawConfig;
  routeRequest: ApprovalRouteRequest;
}): boolean {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  if (!channel) {
    return false;
  }
  const adapter = resolveChannelApprovalAdapter(getChannelPlugin(channel));
  return (
    adapter?.delivery?.shouldSuppressForwardingFallback?.({
      cfg: params.cfg,
      approvalKind: params.approvalKind,
      target: params.target,
      request: buildSyntheticApprovalRequest(params.routeRequest),
    }) ?? false
  );
}

function formatApprovalCommand(command: string): { inline: boolean; text: string } {
  if (!command.includes("\n") && !command.includes("`")) {
    return { inline: true, text: `\`${command}\`` };
  }

  let fence = "```";
  while (command.includes(fence)) {
    fence += "`";
  }
  return { inline: false, text: `${fence}\n${command}\n${fence}` };
}

function buildRequestMessage(request: ExecApprovalRequest, nowMs: number) {
  const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(request.request);
  const decisionText = allowedDecisions.join("|");
  const lines: string[] = ["🔒 Exec approval required", `ID: ${request.id}`];
  const command = formatApprovalCommand(
    resolveExecApprovalCommandDisplay(request.request).commandText,
  );
  if (command.inline) {
    lines.push(`Command: ${command.text}`);
  } else {
    lines.push("Command:");
    lines.push(command.text);
  }
  if (request.request.cwd) {
    lines.push(`CWD: ${request.request.cwd}`);
  }
  if (request.request.nodeId) {
    lines.push(`Node: ${request.request.nodeId}`);
  }
  if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) {
    lines.push(`Env overrides: ${request.request.envKeys.join(", ")}`);
  }
  if (request.request.host) {
    lines.push(`Host: ${request.request.host}`);
  }
  if (request.request.agentId) {
    lines.push(`Agent: ${request.request.agentId}`);
  }
  if (request.request.security) {
    lines.push(`Security: ${request.request.security}`);
  }
  if (request.request.ask) {
    lines.push(`Ask: ${request.request.ask}`);
  }
  lines.push(`Expires in: ${formatExecApprovalExpiresIn(request.expiresAtMs, nowMs)}`);
  lines.push("Mode: foreground (interactive approvals available in this chat).");
  lines.push(
    allowedDecisions.includes("allow-always")
      ? "Background mode note: non-interactive runs cannot wait for chat approvals; use pre-approved policy (allow-always or ask=off)."
      : "Background mode note: non-interactive runs cannot wait for chat approvals; the effective policy still requires per-run approval unless ask=off.",
  );
  lines.push(`Reply with: /approve <id> ${decisionText}`);
  if (!allowedDecisions.includes("allow-always")) {
    lines.push(
      "Allow Always is unavailable because the effective policy requires approval every time.",
    );
  }
  return lines.join("\n");
}

const decisionLabel = approvalDecisionLabel;

function buildResolvedMessage(resolved: ExecApprovalResolved) {
  const base = `✅ Exec approval ${decisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

function buildExpiredMessage(request: ExecApprovalRequest) {
  return `⏱️ Exec approval expired. ID: ${request.id}`;
}

function normalizeTurnSourceChannel(value?: string | null): DeliverableMessageChannel | undefined {
  const normalized = value ? normalizeMessageChannel(value) : undefined;
  return normalized && isDeliverableMessageChannel(normalized) ? normalized : undefined;
}

function defaultResolveSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): ExecApprovalForwardTarget | null {
  const resolvedTarget = resolveExecApprovalSessionTarget({
    cfg: params.cfg,
    request: params.request,
    turnSourceChannel: normalizeTurnSourceChannel(params.request.request.turnSourceChannel),
    turnSourceTo: params.request.request.turnSourceTo?.trim() || undefined,
    turnSourceAccountId: params.request.request.turnSourceAccountId?.trim() || undefined,
    turnSourceThreadId: params.request.request.turnSourceThreadId ?? undefined,
  });
  if (!resolvedTarget?.channel || !resolvedTarget.to) {
    return null;
  }
  const channel = resolvedTarget.channel;
  if (!isDeliverableMessageChannel(channel)) {
    return null;
  }
  return {
    channel,
    to: resolvedTarget.to,
    accountId: resolvedTarget.accountId,
    threadId: resolvedTarget.threadId,
  };
}

async function deliverToTargets(params: {
  cfg: OpenClawConfig;
  targets: ForwardTarget[];
  buildPayload: (target: ForwardTarget) => ReplyPayload;
  deliver: typeof deliverOutboundPayloads;
  beforeDeliver?: (target: ForwardTarget, payload: ReplyPayload) => Promise<void> | void;
  shouldSend?: () => boolean;
}) {
  const deliveries = params.targets.map(async (target) => {
    if (params.shouldSend && !params.shouldSend()) {
      return;
    }
    const channel = normalizeMessageChannel(target.channel) ?? target.channel;
    if (!isDeliverableMessageChannel(channel)) {
      return;
    }
    try {
      const payload = params.buildPayload(target);
      await params.beforeDeliver?.(target, payload);
      await params.deliver({
        cfg: params.cfg,
        channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [payload],
      });
    } catch (err) {
      log.error(`exec approvals: failed to deliver to ${channel}:${target.to}: ${String(err)}`);
    }
  });
  await Promise.allSettled(deliveries);
}

function buildExecPendingPayload(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
  target: ForwardTarget;
  nowMs: number;
}): ReplyPayload {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  const pluginPayload = channel
    ? resolveChannelApprovalAdapter(getChannelPlugin(channel))?.render?.exec?.buildPendingPayload?.(
        {
          cfg: params.cfg,
          request: params.request,
          target: params.target,
          nowMs: params.nowMs,
        },
      )
    : null;
  if (pluginPayload) {
    return pluginPayload;
  }
  return buildApprovalPendingReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    text: buildRequestMessage(params.request, params.nowMs),
    allowedDecisions: resolveExecApprovalRequestAllowedDecisions(params.request.request),
  });
}

function buildExecResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: ExecApprovalResolved;
  target: ForwardTarget;
}): ReplyPayload {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  const pluginPayload = channel
    ? resolveChannelApprovalAdapter(
        getChannelPlugin(channel),
      )?.render?.exec?.buildResolvedPayload?.({
        cfg: params.cfg,
        resolved: params.resolved,
        target: params.target,
      })
    : null;
  if (pluginPayload) {
    return pluginPayload;
  }
  return buildApprovalResolvedReplyPayload({
    approvalId: params.resolved.id,
    approvalSlug: params.resolved.id.slice(0, 8),
    text: buildResolvedMessage(params.resolved),
  });
}

function buildPluginPendingPayload(params: {
  cfg: OpenClawConfig;
  request: PluginApprovalRequest;
  target: ForwardTarget;
  nowMs: number;
}): ReplyPayload {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  const adapterPayload = channel
    ? resolveChannelApprovalAdapter(
        getChannelPlugin(channel),
      )?.render?.plugin?.buildPendingPayload?.({
        cfg: params.cfg,
        request: params.request,
        target: params.target,
        nowMs: params.nowMs,
      })
    : null;
  if (adapterPayload) {
    return adapterPayload;
  }
  return buildPluginApprovalPendingReplyPayload({
    request: params.request,
    nowMs: params.nowMs,
    text: buildPluginApprovalRequestMessage(params.request, params.nowMs),
  });
}

function buildPluginResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: PluginApprovalResolved;
  target: ForwardTarget;
}): ReplyPayload {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  const adapterPayload = channel
    ? resolveChannelApprovalAdapter(
        getChannelPlugin(channel),
      )?.render?.plugin?.buildResolvedPayload?.({
        cfg: params.cfg,
        resolved: params.resolved,
        target: params.target,
      })
    : null;
  if (adapterPayload) {
    return adapterPayload;
  }
  return buildPluginApprovalResolvedReplyPayload({
    resolved: params.resolved,
  });
}

function resolveForwardTargets(params: {
  cfg: OpenClawConfig;
  config?: ExecApprovalForwardingConfig;
  routeRequest: ApprovalRouteRequest;
  resolveSessionTarget: (params: {
    cfg: OpenClawConfig;
    request: ExecApprovalRequest;
  }) => ExecApprovalForwardTarget | null;
}): ForwardTarget[] {
  const mode = normalizeMode(params.config?.mode);
  const targets: ForwardTarget[] = [];
  const seen = new Set<string>();

  if (mode === "session" || mode === "both") {
    const sessionTarget = params.resolveSessionTarget({
      cfg: params.cfg,
      request: buildSyntheticApprovalRequest(params.routeRequest),
    });
    if (sessionTarget) {
      const key = buildTargetKey(sessionTarget);
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ ...sessionTarget, source: "session" });
      }
    }
  }

  if (mode === "targets" || mode === "both") {
    const explicitTargets = params.config?.targets ?? [];
    for (const target of explicitTargets) {
      const key = buildTargetKey(target);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      targets.push({ ...target, source: "target" });
    }
  }

  return targets;
}

function createApprovalHandlers<
  TRequest,
  TResolved,
  TRouteRequest extends ApprovalRouteRequest = ApprovalRouteRequest,
>(params: {
  strategy: ApprovalStrategy<TRequest, TResolved, TRouteRequest>;
  getConfig: () => OpenClawConfig;
  deliver: typeof deliverOutboundPayloads;
  nowMs: () => number;
  resolveSessionTarget: (params: {
    cfg: OpenClawConfig;
    request: ExecApprovalRequest;
  }) => ExecApprovalForwardTarget | null;
}) {
  const pending = new Map<string, PendingApproval<TRouteRequest>>();

  const handleRequested = async (request: TRequest): Promise<boolean> => {
    const cfg = params.getConfig();
    const config = params.strategy.config(cfg);
    const requestId = params.strategy.getRequestId(request);
    const routeRequest = params.strategy.getRouteRequestFromRequest(request);
    const filteredTargets = [
      ...(shouldForwardRoute({ config, routeRequest })
        ? resolveForwardTargets({
            cfg,
            config,
            routeRequest,
            resolveSessionTarget: params.resolveSessionTarget,
          })
        : []),
    ].filter(
      (target) =>
        !shouldSkipForwardingFallback({
          approvalKind: params.strategy.kind,
          target,
          cfg,
          routeRequest,
        }),
    );
    if (filteredTargets.length === 0) {
      return false;
    }

    const expiresInMs = Math.max(0, params.strategy.getExpiresAtMs(request) - params.nowMs());
    const timeoutId = setTimeout(() => {
      void (async () => {
        const entry = pending.get(requestId);
        if (!entry) {
          return;
        }
        pending.delete(requestId);
        await deliverToTargets({
          cfg,
          targets: entry.targets,
          buildPayload: () => ({ text: params.strategy.buildExpiredText(request) }),
          deliver: params.deliver,
        });
      })();
    }, expiresInMs);
    timeoutId.unref?.();

    const pendingEntry: PendingApproval<TRouteRequest> = {
      routeRequest,
      targets: filteredTargets,
      timeoutId,
    };
    pending.set(requestId, pendingEntry);

    if (pending.get(requestId) !== pendingEntry) {
      return false;
    }

    void deliverToTargets({
      cfg,
      targets: filteredTargets,
      buildPayload: (target) =>
        params.strategy.buildPendingPayload({
          cfg,
          request,
          target,
          routeRequest,
          nowMs: params.nowMs(),
        }),
      beforeDeliver: async (target, payload) => {
        const channel = normalizeMessageChannel(target.channel) ?? target.channel;
        if (!channel) {
          return;
        }
        await getChannelPlugin(channel)?.outbound?.beforeDeliverPayload?.({
          cfg,
          target,
          payload,
          hint: {
            kind: "approval-pending",
            approvalKind: params.strategy.kind,
          },
        });
      },
      deliver: params.deliver,
      shouldSend: () => pending.get(requestId) === pendingEntry,
    }).catch((err) => {
      log.error(
        `${params.strategy.kind} approvals: failed to deliver request ${requestId}: ${String(err)}`,
      );
    });
    return true;
  };

  const handleResolved = async (resolved: TResolved) => {
    const resolvedId = params.strategy.getResolvedId(resolved);
    const entry = pending.get(resolvedId);
    if (entry?.timeoutId) {
      clearTimeout(entry.timeoutId);
    }
    if (entry) {
      pending.delete(resolvedId);
    }

    const cfg = params.getConfig();
    let targets = entry?.targets;
    if (!targets) {
      const routeRequest = params.strategy.getRouteRequestFromResolved(resolved);
      if (routeRequest) {
        const config = params.strategy.config(cfg);
        targets = [
          ...(shouldForwardRoute({ config, routeRequest })
            ? resolveForwardTargets({
                cfg,
                config,
                routeRequest,
                resolveSessionTarget: params.resolveSessionTarget,
              })
            : []),
        ].filter(
          (target) =>
            !shouldSkipForwardingFallback({
              approvalKind: params.strategy.kind,
              target,
              cfg,
              routeRequest,
            }),
        );
      }
    }
    if (!targets?.length) {
      return;
    }

    await deliverToTargets({
      cfg,
      targets,
      buildPayload: (target) =>
        params.strategy.buildResolvedPayload({
          cfg,
          resolved,
          target,
          routeRequest:
            entry?.routeRequest ??
            params.strategy.getRouteRequestFromResolved(resolved) ??
            ({} as TRouteRequest),
        }),
      deliver: params.deliver,
    });
  };

  const stop = () => {
    for (const entry of pending.values()) {
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
    }
    pending.clear();
  };

  return { handleRequested, handleResolved, stop };
}

const execApprovalStrategy: ApprovalStrategy<ExecApprovalRequest, ExecApprovalResolved> = {
  kind: "exec",
  config: (cfg) => cfg.approvals?.exec,
  getRequestId: (request) => request.id,
  getResolvedId: (resolved) => resolved.id,
  getExpiresAtMs: (request) => request.expiresAtMs,
  getRouteRequestFromRequest: (request) => ({
    agentId: request.request.agentId ?? null,
    sessionKey: request.request.sessionKey ?? null,
    turnSourceChannel: request.request.turnSourceChannel ?? null,
    turnSourceTo: request.request.turnSourceTo ?? null,
    turnSourceAccountId: request.request.turnSourceAccountId ?? null,
    turnSourceThreadId: request.request.turnSourceThreadId ?? null,
  }),
  getRouteRequestFromResolved: (resolved) =>
    resolved.request
      ? {
          agentId: resolved.request.agentId ?? null,
          sessionKey: resolved.request.sessionKey ?? null,
          turnSourceChannel: resolved.request.turnSourceChannel ?? null,
          turnSourceTo: resolved.request.turnSourceTo ?? null,
          turnSourceAccountId: resolved.request.turnSourceAccountId ?? null,
          turnSourceThreadId: resolved.request.turnSourceThreadId ?? null,
        }
      : null,
  buildExpiredText: buildExpiredMessage,
  buildPendingPayload: ({ cfg, request, target, nowMs }) =>
    buildExecPendingPayload({
      cfg,
      request,
      target,
      nowMs,
    }),
  buildResolvedPayload: ({ cfg, resolved, target }) =>
    buildExecResolvedPayload({
      cfg,
      resolved,
      target,
    }),
};

const pluginApprovalStrategy: ApprovalStrategy<PluginApprovalRequest, PluginApprovalResolved> = {
  kind: "plugin",
  config: (cfg) => cfg.approvals?.plugin,
  getRequestId: (request) => request.id,
  getResolvedId: (resolved) => resolved.id,
  getExpiresAtMs: (request) => request.expiresAtMs,
  getRouteRequestFromRequest: (request) => ({
    agentId: request.request.agentId ?? null,
    sessionKey: request.request.sessionKey ?? null,
    turnSourceChannel: request.request.turnSourceChannel ?? null,
    turnSourceTo: request.request.turnSourceTo ?? null,
    turnSourceAccountId: request.request.turnSourceAccountId ?? null,
    turnSourceThreadId: request.request.turnSourceThreadId ?? null,
  }),
  getRouteRequestFromResolved: (resolved) =>
    resolved.request
      ? {
          agentId: resolved.request.agentId ?? null,
          sessionKey: resolved.request.sessionKey ?? null,
          turnSourceChannel: resolved.request.turnSourceChannel ?? null,
          turnSourceTo: resolved.request.turnSourceTo ?? null,
          turnSourceAccountId: resolved.request.turnSourceAccountId ?? null,
          turnSourceThreadId: resolved.request.turnSourceThreadId ?? null,
        }
      : null,
  buildExpiredText: buildPluginApprovalExpiredMessage,
  buildPendingPayload: ({ cfg, request, target, nowMs }) =>
    buildPluginPendingPayload({
      cfg,
      request,
      target,
      nowMs,
    }),
  buildResolvedPayload: ({ cfg, resolved, target }) =>
    buildPluginResolvedPayload({
      cfg,
      resolved,
      target,
    }),
};

export function createExecApprovalForwarder(
  deps: ExecApprovalForwarderDeps = {},
): ExecApprovalForwarder {
  const getConfig = deps.getConfig ?? loadConfig;
  const deliver = deps.deliver ?? deliverOutboundPayloads;
  const nowMs = deps.nowMs ?? Date.now;
  const resolveSessionTarget = deps.resolveSessionTarget ?? defaultResolveSessionTarget;

  const execHandlers = createApprovalHandlers({
    strategy: execApprovalStrategy,
    getConfig,
    deliver,
    nowMs,
    resolveSessionTarget,
  });
  const pluginHandlers = createApprovalHandlers({
    strategy: pluginApprovalStrategy,
    getConfig,
    deliver,
    nowMs,
    resolveSessionTarget,
  });

  return {
    handleRequested: execHandlers.handleRequested,
    handleResolved: execHandlers.handleResolved,
    handlePluginApprovalRequested: pluginHandlers.handleRequested,
    handlePluginApprovalResolved: pluginHandlers.handleResolved,
    stop: () => {
      execHandlers.stop();
      pluginHandlers.stop();
    },
  };
}

export function shouldForwardExecApproval(params: {
  config?: ExecApprovalForwardingConfig;
  request: ExecApprovalRequest;
}): boolean {
  return shouldForwardRoute({
    config: params.config,
    routeRequest: execApprovalStrategy.getRouteRequestFromRequest(params.request),
  });
}
