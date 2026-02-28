import path from "node:path";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type {
  ExecApprovalForwardingConfig,
  ExecApprovalForwardTarget,
} from "../config/types.approvals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAccountId, parseAgentSessionKey } from "../routing/session-key.js";
import { compileSafeRegex } from "../security/safe-regex.js";
import { editMessageTelegram } from "../telegram/send.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
  type DeliverableMessageChannel,
} from "../utils/message-channel.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
} from "./exec-approvals.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";
import type { OutboundDeliveryResult } from "./outbound/deliver.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { resolveSessionDeliveryTarget } from "./outbound/targets.js";

const log = createSubsystemLogger("gateway/exec-approvals");
const FORWARDER_STATE_FILENAME = "exec-approval-forwarder.json";
const FORWARDER_STATE_VERSION = 1 as const;
const FINALIZED_STATE_RETENTION_MS = 15 * 60 * 1000;
const MAX_FINALIZED_STATE_ENTRIES = 1024;

export type { ExecApprovalRequest, ExecApprovalResolved };

type ForwardTarget = ExecApprovalForwardTarget & { source: "session" | "target" };

type PendingTelegramMessageRef = {
  targetKey: string;
  accountId?: string;
  chatId: string;
  messageId: string;
};

type PendingApproval = {
  request: ExecApprovalRequest;
  targets: ForwardTarget[];
  timeoutId: NodeJS.Timeout | null;
  telegramMessages: PendingTelegramMessageRef[];
};

type FinalizedApproval = {
  request: ExecApprovalRequest;
  statusText: string;
  finalizedAtMs: number;
};

type PersistedPendingApproval = {
  request: ExecApprovalRequest;
  targets: ForwardTarget[];
  telegramMessages: PendingTelegramMessageRef[];
};

type PersistedForwarderState = {
  version: typeof FORWARDER_STATE_VERSION;
  updatedAtMs: number;
  pending: PersistedPendingApproval[];
};

export type ExecApprovalForwarder = {
  handleRequested: (request: ExecApprovalRequest) => Promise<boolean>;
  handleResolved: (resolved: ExecApprovalResolved) => Promise<void>;
  recoverPendingFromState?: () => Promise<void>;
  stop: () => void;
};

export type ExecApprovalForwarderDeps = {
  getConfig?: () => OpenClawConfig;
  deliver?: typeof deliverOutboundPayloads;
  editTelegramMessage?: typeof editMessageTelegram;
  nowMs?: () => number;
  resolveSessionTarget?: (params: {
    cfg: OpenClawConfig;
    request: ExecApprovalRequest;
  }) => ExecApprovalForwardTarget | null;
  stateFilePath?: string | null;
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

function resolveForwarderStateFilePath(value?: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return path.join(resolveStateDir(), FORWARDER_STATE_FILENAME);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizePersistedTarget(value: unknown): ForwardTarget | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    channel?: unknown;
    to?: unknown;
    accountId?: unknown;
    threadId?: unknown;
    source?: unknown;
  };
  const channel = typeof candidate.channel === "string" ? candidate.channel.trim() : "";
  const to = typeof candidate.to === "string" ? candidate.to.trim() : "";
  if (!channel || !to) {
    return null;
  }
  const source = candidate.source === "session" ? "session" : "target";
  const accountId = typeof candidate.accountId === "string" ? candidate.accountId : undefined;
  const threadId =
    typeof candidate.threadId === "string" || typeof candidate.threadId === "number"
      ? candidate.threadId
      : undefined;
  return { channel, to, accountId, threadId, source };
}

function isForwardTarget(value: ForwardTarget | null): value is ForwardTarget {
  return value !== null;
}

function sanitizePersistedTelegramRef(value: unknown): PendingTelegramMessageRef | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    targetKey?: unknown;
    accountId?: unknown;
    chatId?: unknown;
    messageId?: unknown;
  };
  const targetKey = typeof candidate.targetKey === "string" ? candidate.targetKey.trim() : "";
  const chatId = typeof candidate.chatId === "string" ? candidate.chatId.trim() : "";
  const messageId = typeof candidate.messageId === "string" ? candidate.messageId.trim() : "";
  if (!targetKey || !chatId || !messageId) {
    return null;
  }
  const accountId = typeof candidate.accountId === "string" ? candidate.accountId : undefined;
  return { targetKey, accountId, chatId, messageId };
}

function isPendingTelegramMessageRef(
  value: PendingTelegramMessageRef | null,
): value is PendingTelegramMessageRef {
  return value !== null;
}

function sanitizePersistedRequest(value: unknown): ExecApprovalRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    id?: unknown;
    request?: unknown;
    createdAtMs?: unknown;
    expiresAtMs?: unknown;
  };
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id || !candidate.request || typeof candidate.request !== "object") {
    return null;
  }
  const requestPayload = candidate.request as { command?: unknown };
  const command = typeof requestPayload.command === "string" ? requestPayload.command.trim() : "";
  if (!command) {
    return null;
  }
  if (!isFiniteNumber(candidate.createdAtMs) || !isFiniteNumber(candidate.expiresAtMs)) {
    return null;
  }
  return {
    id,
    request: candidate.request as ExecApprovalRequest["request"],
    createdAtMs: candidate.createdAtMs,
    expiresAtMs: candidate.expiresAtMs,
  };
}

function readPersistedPendingApprovals(value: unknown): PersistedPendingApproval[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const parsed = value as {
    version?: unknown;
    pending?: unknown;
  };
  if (parsed.version !== FORWARDER_STATE_VERSION || !Array.isArray(parsed.pending)) {
    return [];
  }
  const out: PersistedPendingApproval[] = [];
  const seenIds = new Set<string>();
  for (const item of parsed.pending) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const candidate = item as {
      request?: unknown;
      targets?: unknown;
      telegramMessages?: unknown;
    };
    const request = sanitizePersistedRequest(candidate.request);
    if (!request || seenIds.has(request.id)) {
      continue;
    }
    const targets = Array.isArray(candidate.targets)
      ? candidate.targets.map((target) => sanitizePersistedTarget(target)).filter(isForwardTarget)
      : [];
    if (targets.length === 0) {
      continue;
    }
    const telegramMessages = Array.isArray(candidate.telegramMessages)
      ? candidate.telegramMessages
          .map((ref) => sanitizePersistedTelegramRef(ref))
          .filter(isPendingTelegramMessageRef)
      : [];
    seenIds.add(request.id);
    out.push({
      request,
      targets,
      telegramMessages,
    });
  }
  return out;
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

function buildRequestButtons(
  approvalId: string,
): Array<Array<{ text: string; callback_data: string }>> | undefined {
  const allowOnce = `/approve ${approvalId} allow-once`;
  const allowAlways = `/approve ${approvalId} allow-always`;
  const deny = `/approve ${approvalId} deny`;
  const maxBytes = 64;
  if (
    Buffer.byteLength(allowOnce, "utf8") > maxBytes ||
    Buffer.byteLength(allowAlways, "utf8") > maxBytes ||
    Buffer.byteLength(deny, "utf8") > maxBytes
  ) {
    return undefined;
  }
  return [
    [
      { text: "Allow once", callback_data: allowOnce },
      { text: "Always allow", callback_data: allowAlways },
    ],
    [{ text: "Deny", callback_data: deny }],
  ];
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
  const target = resolveSessionDeliveryTarget({
    entry,
    requestedChannel: "last",
    turnSourceChannel: normalizeTurnSourceChannel(params.request.request.turnSourceChannel),
    turnSourceTo: params.request.request.turnSourceTo?.trim() || undefined,
    turnSourceAccountId: params.request.request.turnSourceAccountId?.trim() || undefined,
    turnSourceThreadId: params.request.request.turnSourceThreadId ?? undefined,
  });
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
  payloadForTarget?: (target: ForwardTarget) => ReplyPayload;
}): Promise<Array<{ target: ForwardTarget; deliveries: OutboundDeliveryResult[] }>> {
  const sent: Array<{ target: ForwardTarget; deliveries: OutboundDeliveryResult[] }> = [];
  const deliveries = params.targets.map(async (target) => {
    if (params.shouldSend && !params.shouldSend()) {
      return;
    }
    const channel = normalizeMessageChannel(target.channel) ?? target.channel;
    if (!isDeliverableMessageChannel(channel)) {
      return;
    }
    try {
      const payload: ReplyPayload = params.payloadForTarget
        ? params.payloadForTarget(target)
        : { text: params.text };
      const result = await params.deliver({
        cfg: params.cfg,
        channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [payload],
      });
      sent.push({ target, deliveries: result });
    } catch (err) {
      log.error(`exec approvals: failed to deliver to ${channel}:${target.to}: ${String(err)}`);
    }
  });
  await Promise.allSettled(deliveries);
  return sent;
}

function collectTelegramMessageRefs(
  deliveries: Array<{ target: ForwardTarget; deliveries: OutboundDeliveryResult[] }>,
): PendingTelegramMessageRef[] {
  const refs: PendingTelegramMessageRef[] = [];
  for (const item of deliveries) {
    const normalizedChannel = normalizeMessageChannel(item.target.channel) ?? item.target.channel;
    if (normalizedChannel !== "telegram") {
      continue;
    }
    const targetKey = buildTargetKey(item.target);
    for (const delivery of item.deliveries) {
      const chatId = typeof delivery.chatId === "string" ? delivery.chatId.trim() : "";
      const messageId = typeof delivery.messageId === "string" ? delivery.messageId.trim() : "";
      if (!chatId || !messageId) {
        continue;
      }
      refs.push({
        targetKey,
        accountId: item.target.accountId,
        chatId,
        messageId,
      });
    }
  }
  return refs;
}

function buildFinalizedRequestMessage(params: {
  request: ExecApprovalRequest;
  statusText: string;
  nowMs: number;
}): string {
  const combined = `${buildRequestMessage(params.request, params.nowMs)}\n\n${params.statusText}`;
  if (combined.length <= 3900) {
    return combined;
  }
  return `${params.statusText}\nID: ${params.request.id}`;
}

async function markPendingTelegramMessagesFinal(params: {
  entry: PendingApproval;
  statusText: string;
  nowMs: number;
  editTelegramMessage: typeof editMessageTelegram;
}): Promise<Set<string>> {
  const editedTargetKeys = new Set<string>();
  const seen = new Set<string>();
  const finalizedText = buildFinalizedRequestMessage({
    request: params.entry.request,
    statusText: params.statusText,
    nowMs: params.nowMs,
  });
  for (const ref of params.entry.telegramMessages) {
    const dedupeKey = `${ref.chatId}:${ref.messageId}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    try {
      await params.editTelegramMessage(ref.chatId, ref.messageId, finalizedText, {
        accountId: ref.accountId,
        buttons: [],
      });
      editedTargetKeys.add(ref.targetKey);
    } catch (err) {
      log.error(
        `exec approvals: failed to edit telegram request ${ref.chatId}/${ref.messageId}: ${String(err)}`,
      );
    }
  }
  return editedTargetKeys;
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
  const editTelegramMessage = deps.editTelegramMessage ?? editMessageTelegram;
  const nowMs = deps.nowMs ?? Date.now;
  const resolveSessionTarget = deps.resolveSessionTarget ?? defaultResolveSessionTarget;
  const stateFilePath = resolveForwarderStateFilePath(deps.stateFilePath);
  const withStateLock = createAsyncLock();
  let recoveredFromState = false;
  let statePersistenceEnabled = false;
  const pending = new Map<string, PendingApproval>();
  const finalized = new Map<string, FinalizedApproval>();

  const pruneFinalized = () => {
    const cutoff = nowMs() - FINALIZED_STATE_RETENTION_MS;
    for (const [id, entry] of finalized) {
      if (entry.finalizedAtMs <= cutoff) {
        finalized.delete(id);
      }
    }
    while (finalized.size > MAX_FINALIZED_STATE_ENTRIES) {
      const oldestId = finalized.keys().next().value;
      if (!oldestId) {
        break;
      }
      finalized.delete(oldestId);
    }
  };

  const rememberFinalized = (id: string, request: ExecApprovalRequest, statusText: string) => {
    finalized.set(id, { request, statusText, finalizedAtMs: nowMs() });
    pruneFinalized();
  };

  const getFinalized = (id: string): FinalizedApproval | undefined => {
    pruneFinalized();
    return finalized.get(id);
  };

  const snapshotPersistedState = (): PersistedForwarderState => ({
    version: FORWARDER_STATE_VERSION,
    updatedAtMs: nowMs(),
    pending: Array.from(pending.values()).map((entry) => ({
      request: entry.request,
      targets: entry.targets.map((target) => ({
        channel: target.channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        source: target.source,
      })),
      telegramMessages: entry.telegramMessages.map((ref) => ({ ...ref })),
    })),
  });

  const persistPendingState = async () => {
    if (!stateFilePath || !statePersistenceEnabled) {
      return;
    }
    const snapshot = snapshotPersistedState();
    await withStateLock(async () => {
      await writeJsonAtomic(stateFilePath, snapshot);
    });
  };

  const schedulePersistPendingState = () => {
    if (!stateFilePath || !statePersistenceEnabled) {
      return;
    }
    void persistPendingState().catch((err) => {
      log.error(`exec approvals: failed to persist forwarder state: ${String(err)}`);
    });
  };

  const recoverPendingFromState = async () => {
    if (recoveredFromState) {
      return;
    }
    recoveredFromState = true;
    statePersistenceEnabled = Boolean(stateFilePath);
    if (!stateFilePath) {
      return;
    }
    const state = await readJsonFile<unknown>(stateFilePath);
    const recoveredEntries = readPersistedPendingApprovals(state);
    if (recoveredEntries.length === 0) {
      await persistPendingState();
      return;
    }
    log.info(
      `exec approvals: recovering ${recoveredEntries.length} stale forwarded approvals after restart`,
    );
    const cfg = getConfig();
    for (const recovered of recoveredEntries) {
      const entry: PendingApproval = {
        request: recovered.request,
        targets: recovered.targets,
        timeoutId: null,
        telegramMessages: recovered.telegramMessages,
      };
      const expiredText = `⏱️ Exec approval expired after gateway restart. ID: ${recovered.request.id}`;
      const editedTargetKeys = await markPendingTelegramMessagesFinal({
        entry,
        statusText: expiredText,
        nowMs: nowMs(),
        editTelegramMessage,
      });
      const followUpTargets = recovered.targets.filter(
        (target) => !editedTargetKeys.has(buildTargetKey(target)),
      );
      if (followUpTargets.length > 0) {
        await deliverToTargets({ cfg, targets: followUpTargets, text: expiredText, deliver });
      }
    }
    await persistPendingState();
  };

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
        schedulePersistPendingState();
        const expiredText = buildExpiredMessage(request);
        rememberFinalized(request.id, request, expiredText);
        const editedTargetKeys = await markPendingTelegramMessagesFinal({
          entry,
          statusText: expiredText,
          nowMs: nowMs(),
          editTelegramMessage,
        });
        const followUpTargets = entry.targets.filter(
          (target) => !editedTargetKeys.has(buildTargetKey(target)),
        );
        if (followUpTargets.length > 0) {
          await deliverToTargets({ cfg, targets: followUpTargets, text: expiredText, deliver });
        }
      })();
    }, expiresInMs);
    timeoutId.unref?.();

    const pendingEntry: PendingApproval = {
      request,
      targets: filteredTargets,
      timeoutId,
      telegramMessages: [],
    };
    pending.set(request.id, pendingEntry);
    schedulePersistPendingState();

    if (pending.get(request.id) !== pendingEntry) {
      return false;
    }

    const text = buildRequestMessage(request, nowMs());
    const requestButtons = buildRequestButtons(request.id);
    void deliverToTargets({
      cfg,
      targets: filteredTargets,
      text,
      deliver,
      shouldSend: () => pending.get(request.id) === pendingEntry,
      payloadForTarget: (target) => {
        const normalizedChannel = normalizeMessageChannel(target.channel) ?? target.channel;
        if (normalizedChannel !== "telegram" || !requestButtons) {
          return { text };
        }
        return {
          text,
          channelData: {
            telegram: {
              buttons: requestButtons,
            },
          },
        };
      },
    })
      .then(async (deliveries) => {
        const deliveryRefs = collectTelegramMessageRefs(deliveries);
        if (pending.get(request.id) !== pendingEntry) {
          const finalizedEntry = getFinalized(request.id);
          if (!finalizedEntry || deliveryRefs.length === 0) {
            return;
          }
          const lateEntry: PendingApproval = {
            request: finalizedEntry.request,
            targets: filteredTargets,
            timeoutId: null,
            telegramMessages: deliveryRefs,
          };
          await markPendingTelegramMessagesFinal({
            entry: lateEntry,
            statusText: finalizedEntry.statusText,
            nowMs: nowMs(),
            editTelegramMessage,
          });
          return;
        }
        pendingEntry.telegramMessages = deliveryRefs;
        schedulePersistPendingState();
      })
      .catch((err) => {
        log.error(
          `exec approvals: failed to deliver/finalize request ${request.id}: ${String(err)}`,
        );
      });
    return true;
  };

  const handleResolved = async (resolved: ExecApprovalResolved) => {
    const entry = pending.get(resolved.id);
    const text = buildResolvedMessage(resolved);
    if (entry) {
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
      pending.delete(resolved.id);
      schedulePersistPendingState();
      rememberFinalized(resolved.id, entry.request, text);
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
      rememberFinalized(resolved.id, request, text);
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
    const editedTargetKeys = entry
      ? await markPendingTelegramMessagesFinal({
          entry,
          statusText: text,
          nowMs: nowMs(),
          editTelegramMessage,
        })
      : new Set<string>();
    const followUpTargets = targets.filter(
      (target) => !editedTargetKeys.has(buildTargetKey(target)),
    );
    if (followUpTargets.length === 0) {
      return;
    }
    await deliverToTargets({ cfg, targets: followUpTargets, text, deliver });
  };

  const stop = () => {
    for (const entry of pending.values()) {
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
    }
    pending.clear();
    finalized.clear();
    schedulePersistPendingState();
  };

  return { handleRequested, handleResolved, recoverPendingFromState, stop };
}

export function shouldForwardExecApproval(params: {
  config?: ExecApprovalForwardingConfig;
  request: ExecApprovalRequest;
}): boolean {
  return shouldForward(params);
}
