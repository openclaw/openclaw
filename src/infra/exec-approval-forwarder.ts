import type { ReplyPayload } from "../auto-reply/types.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type {
  ExecApprovalForwardingConfig,
  ExecApprovalForwardTarget,
} from "../config/types.approvals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { compileConfigRegex } from "../security/config-regex.js";
import { testRegexWithBoundedInput } from "../security/safe-regex.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
  type DeliverableMessageChannel,
} from "../utils/message-channel.js";
import { resolveExecApprovalCommandDisplay } from "./exec-approval-command-display.js";
import { resolveExecApprovalSessionTarget } from "./exec-approval-session-target.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
} from "./exec-approvals.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";

const log = createSubsystemLogger("gateway/exec-approvals");
export type { ExecApprovalRequest, ExecApprovalResolved };

type ForwardTarget = ExecApprovalForwardTarget & { source: "session" | "target" };

type PendingApproval = {
  request: ExecApprovalRequest;
  targets: ForwardTarget[];
  timeoutId: NodeJS.Timeout | null;
};

export type ExecApprovalForwarder = {
  handleRequested: (request: ExecApprovalRequest) => Promise<boolean>;
  handleResolved: (resolved: ExecApprovalResolved) => Promise<void>;
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

function normalizeMode(mode?: ExecApprovalForwardingConfig["mode"]) {
  return mode ?? DEFAULT_MODE;
}

function matchSessionFilter(sessionKey: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (sessionKey.includes(pattern)) {
      return true;
    }
    const compiled = compileConfigRegex(pattern);
    return compiled?.regex ? testRegexWithBoundedInput(compiled.regex, sessionKey) : false;
  });
}

function shouldForward(params: {
  config?: {
    enabled?: boolean;
    agentFilter?: string[];
    sessionFilter?: string[];
  };
  request: ExecApprovalRequest;
}): boolean {
  const config = params.config;
  if (!config?.enabled) {
    return false;
  }
  if (config.agentFilter?.length) {
    const agentId =
      params.request.request.agentId ??
      parseAgentSessionKey(params.request.request.sessionKey)?.agentId;
    if (!agentId) {
      return false;
    }
    if (!config.agentFilter.includes(agentId)) {
      return false;
    }
  }
  if (config.sessionFilter?.length) {
    const sessionKey = params.request.request.sessionKey;
    if (!sessionKey) {
      return false;
    }
    if (!matchSessionFilter(sessionKey, config.sessionFilter)) {
      return false;
    }
  }
  return true;
}

function buildTargetKey(target: ExecApprovalForwardTarget): string {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  const accountId = target.accountId ?? "";
  const threadId = target.threadId ?? "";
  return [channel, target.to, accountId, threadId].join(":");
}

function shouldSkipForwardingFallback(params: {
  target: ExecApprovalForwardTarget;
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): boolean {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  if (!channel) {
    return false;
  }
  const adapter = getChannelPlugin(channel)?.execApprovals;
  return (
    adapter?.shouldSuppressForwardingFallback?.({
      cfg: params.cfg,
      target: params.target,
      request: params.request,
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
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  lines.push(`Expires in: ${expiresIn}s`);
  lines.push("Mode: foreground (interactive approvals available in this chat).");
  lines.push(
    "Background mode note: non-interactive runs cannot wait for chat approvals; use pre-approved policy (allow-always or ask=off).",
  );
  lines.push("Reply with: /approve <id> allow-once|allow-always|deny");
  return lines.join("\n");
}

function decisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "allowed always";
  }
  return "denied";
}

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

function buildRequestPayloadForTarget(
  cfg: OpenClawConfig,
  request: ExecApprovalRequest,
  nowMsValue: number,
  target: ForwardTarget,
): ReplyPayload {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  const pluginPayload = channel
    ? getChannelPlugin(channel)?.execApprovals?.buildPendingPayload?.({
        cfg,
        request,
        target,
        nowMs: nowMsValue,
      })
    : null;
  if (pluginPayload) {
    return pluginPayload;
  }
  return { text: buildRequestMessage(request, nowMsValue) };
}

function buildResolvedPayloadForTarget(
  cfg: OpenClawConfig,
  resolved: ExecApprovalResolved,
  target: ForwardTarget,
): ReplyPayload {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  const pluginPayload = channel
    ? getChannelPlugin(channel)?.execApprovals?.buildResolvedPayload?.({
        cfg,
        resolved,
        target,
      })
    : null;
  if (pluginPayload) {
    return pluginPayload;
  }
  return { text: buildResolvedMessage(resolved) };
}

function resolveForwardTargets(params: {
  cfg: OpenClawConfig;
  config?: ExecApprovalForwardingConfig;
  request: ExecApprovalRequest;
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
      request: params.request,
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

export function createExecApprovalForwarder(
  deps: ExecApprovalForwarderDeps = {},
): ExecApprovalForwarder {
  const getConfig = deps.getConfig ?? loadConfig;
  const deliver = deps.deliver ?? deliverOutboundPayloads;
  const nowMs = deps.nowMs ?? Date.now;
  const resolveSessionTarget = deps.resolveSessionTarget ?? defaultResolveSessionTarget;
  const pending = new Map<string, PendingApproval>();

  const handleRequested = async (request: ExecApprovalRequest): Promise<boolean> => {
    const cfg = getConfig();
    const config = cfg.approvals?.exec;
    const filteredTargets = [
      ...(shouldForward({ config, request })
        ? resolveForwardTargets({
            cfg,
            config,
            request,
            resolveSessionTarget,
          })
        : []),
    ].filter((target) => !shouldSkipForwardingFallback({ target, cfg, request }));

    if (filteredTargets.length === 0) {
      return false;
    }

    const expiresInMs = Math.max(0, request.expiresAtMs - nowMs());
    const timeoutId = setTimeout(() => {
      void (async () => {
        const entry = pending.get(request.id);
        if (!entry) {
          return;
        }
        pending.delete(request.id);
        const expiredText = buildExpiredMessage(request);
        await deliverToTargets({
          cfg,
          targets: entry.targets,
          buildPayload: () => ({ text: expiredText }),
          deliver,
        });
      })();
    }, expiresInMs);
    timeoutId.unref?.();

    const pendingEntry: PendingApproval = { request, targets: filteredTargets, timeoutId };
    pending.set(request.id, pendingEntry);

    if (pending.get(request.id) !== pendingEntry) {
      return false;
    }
    void deliverToTargets({
      cfg,
      targets: filteredTargets,
      buildPayload: (target) => buildRequestPayloadForTarget(cfg, request, nowMs(), target),
      beforeDeliver: async (target, payload) => {
        const channel = normalizeMessageChannel(target.channel) ?? target.channel;
        if (!channel) {
          return;
        }
        await getChannelPlugin(channel)?.execApprovals?.beforeDeliverPending?.({
          cfg,
          target,
          payload,
        });
      },
      deliver,
      shouldSend: () => pending.get(request.id) === pendingEntry,
    }).catch((err) => {
      log.error(`exec approvals: failed to deliver request ${request.id}: ${String(err)}`);
    });
    return true;
  };

  const handleResolved = async (resolved: ExecApprovalResolved) => {
    const entry = pending.get(resolved.id);
    if (entry) {
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
      pending.delete(resolved.id);
    }
    const cfg = getConfig();
    let targets = entry?.targets;

    if (!targets && resolved.request) {
      const request: ExecApprovalRequest = {
        id: resolved.id,
        request: resolved.request,
        createdAtMs: resolved.ts,
        expiresAtMs: resolved.ts,
      };
      const config = cfg.approvals?.exec;
      targets = [
        ...(shouldForward({ config, request })
          ? resolveForwardTargets({
              cfg,
              config,
              request,
              resolveSessionTarget,
            })
          : []),
      ].filter((target) => !shouldSkipForwardingFallback({ target, cfg, request }));
    }
    if (!targets || targets.length === 0) {
      return;
    }
    await deliverToTargets({
      cfg,
      targets,
      buildPayload: (target) => buildResolvedPayloadForTarget(cfg, resolved, target),
      deliver,
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

export function shouldForwardExecApproval(params: {
  config?: ExecApprovalForwardingConfig;
  request: ExecApprovalRequest;
}): boolean {
  return shouldForward(params);
}
