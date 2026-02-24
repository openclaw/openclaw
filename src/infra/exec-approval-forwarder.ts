import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type {
  ExecApprovalForwardingConfig,
  ExecApprovalForwardTarget,
} from "../config/types.approvals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAccountId, parseAgentSessionKey } from "../routing/session-key.js";
import { compileSafeRegex } from "../security/safe-regex.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
} from "./exec-approvals.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { resolveSessionDeliveryTarget } from "./outbound/targets.js";

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
    const regex = compileSafeRegex(pattern);
    return regex ? regex.test(sessionKey) : false;
  });
}

function shouldForward(params: {
  config?: ExecApprovalForwardingConfig;
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

function resolveChannelAccountConfig<T>(
  accounts: Record<string, T> | undefined,
  accountId?: string,
): T | undefined {
  if (!accounts || !accountId?.trim()) {
    return undefined;
  }
  const normalized = normalizeAccountId(accountId);
  const direct = accounts[normalized];
  if (direct) {
    return direct;
  }
  const fallbackKey = Object.keys(accounts).find(
    (key) => key.toLowerCase() === normalized.toLowerCase(),
  );
  return fallbackKey ? accounts[fallbackKey] : undefined;
}

// Discord has component-based exec approvals; skip text fallback only when the
// Discord-specific handler is enabled for the same target account.
function shouldSkipDiscordForwarding(
  target: ExecApprovalForwardTarget,
  cfg: OpenClawConfig,
): boolean {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  if (channel !== "discord") {
    return false;
  }
  const discord = cfg.channels?.discord as
    | {
        execApprovals?: { enabled?: boolean; approvers?: Array<string | number> };
        accounts?: Record<
          string,
          { execApprovals?: { enabled?: boolean; approvers?: Array<string | number> } }
        >;
      }
    | undefined;
  if (!discord) {
    return false;
  }
  const account = resolveChannelAccountConfig(discord.accounts, target.accountId);
  const execApprovals = account?.execApprovals ?? discord.execApprovals;
  return Boolean(execApprovals?.enabled && (execApprovals.approvers?.length ?? 0) > 0);
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
  const command = formatApprovalCommand(request.request.command);
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

function defaultResolveSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): ExecApprovalForwardTarget | null {
  const sessionKey = params.request.request.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? params.request.request.agentId ?? "main";
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return null;
  }
  const target = resolveSessionDeliveryTarget({ entry, requestedChannel: "last" });
  if (!target.channel || !target.to) {
    return null;
  }
  if (!isDeliverableMessageChannel(target.channel)) {
    return null;
  }
  return {
    channel: target.channel,
    to: target.to,
    accountId: target.accountId,
    threadId: target.threadId,
  };
}

async function deliverToTargets(params: {
  cfg: OpenClawConfig;
  targets: ForwardTarget[];
  text: string;
  deliver: typeof deliverOutboundPayloads;
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
      await params.deliver({
        cfg: params.cfg,
        channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [{ text: params.text }],
      });
    } catch (err) {
      log.error(`exec approvals: failed to deliver to ${channel}:${target.to}: ${String(err)}`);
    }
  });
  await Promise.allSettled(deliveries);
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
    if (!shouldForward({ config, request })) {
      return false;
    }
    const filteredTargets = resolveForwardTargets({
      cfg,
      config,
      request,
      resolveSessionTarget,
    }).filter((target) => !shouldSkipDiscordForwarding(target, cfg));

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
        await deliverToTargets({ cfg, targets: entry.targets, text: expiredText, deliver });
      })();
    }, expiresInMs);
    timeoutId.unref?.();

    const pendingEntry: PendingApproval = { request, targets: filteredTargets, timeoutId };
    pending.set(request.id, pendingEntry);

    if (pending.get(request.id) !== pendingEntry) {
      return false;
    }

    const text = buildRequestMessage(request, nowMs());
    void deliverToTargets({
      cfg,
      targets: filteredTargets,
      text,
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
      if (shouldForward({ config, request })) {
        targets = resolveForwardTargets({
          cfg,
          config,
          request,
          resolveSessionTarget,
        }).filter((target) => !shouldSkipDiscordForwarding(target, cfg));
      }
    }
    if (!targets || targets.length === 0) {
      return;
    }
    const text = buildResolvedMessage(resolved);
    await deliverToTargets({ cfg, targets, text, deliver });
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
