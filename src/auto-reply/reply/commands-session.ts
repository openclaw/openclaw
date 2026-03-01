import { parseDurationMs } from "../../cli/parse-duration.js";
import { isRestartEnabled } from "../../config/commands.js";
import { updateSessionStore } from "../../config/sessions.js";
import {
  formatThreadBindingTtlLabel,
  getThreadBindingManager,
  setThreadBindingTtlBySessionKey,
} from "../../discord/monitor/thread-bindings.js";
import { USER_ARCHIVE_SHUTDOWN_REASON, requestGatewayStop } from "../../gateway/shutdown-state.js";
import { logVerbose } from "../../globals.js";
import { scheduleGatewaySigusr1Restart, triggerOpenClawRestart } from "../../infra/restart.js";
import { loadCostUsageSummary, loadSessionCostSummary } from "../../infra/session-cost-usage.js";
import { archiveAndTerminateCurrentSession } from "../../sessions/archive-service.js";
import { formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import { parseActivationCommand } from "../group-activation.js";
import { parseSendPolicyCommand } from "../send-policy.js";
import { normalizeUsageDisplay, resolveResponseUsageMode } from "../thinking.js";
import { handleAbortTrigger, handleStopCommand } from "./commands-session-abort.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";

const SESSION_COMMAND_PREFIX = "/session";
const SESSION_TTL_OFF_VALUES = new Set(["off", "disable", "disabled", "none", "0"]);
const archiveSessionInProgress = new Set<string>();

function isDiscordSurface(params: Parameters<CommandHandler>[0]): boolean {
  const channel =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return (
    String(channel ?? "")
      .trim()
      .toLowerCase() === "discord"
  );
}

function resolveDiscordAccountId(params: Parameters<CommandHandler>[0]): string {
  const accountId = typeof params.ctx.AccountId === "string" ? params.ctx.AccountId.trim() : "";
  return accountId || "default";
}

function resolveSessionCommandUsage() {
  return "Usage: /session ttl <duration|off> (example: /session ttl 24h)";
}

function parseSessionTtlMs(raw: string): number {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new Error("missing ttl");
  }
  if (SESSION_TTL_OFF_VALUES.has(normalized)) {
    return 0;
  }
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const hours = Number(normalized);
    if (!Number.isFinite(hours) || hours < 0) {
      throw new Error("invalid ttl");
    }
    return Math.round(hours * 60 * 60 * 1000);
  }
  return parseDurationMs(normalized, { defaultUnit: "h" });
}

function formatSessionExpiry(expiresAt: number) {
  return new Date(expiresAt).toISOString();
}

export const handleActivationCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const activationCommand = parseActivationCommand(params.command.commandBodyNormalized);
  if (!activationCommand.hasCommand) {
    return null;
  }
  if (!params.isGroup) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Group activation only applies to group chats." },
    };
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /activation from unauthorized sender in group: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!activationCommand.mode) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Usage: /activation mention|always" },
    };
  }
  if (params.sessionEntry && params.sessionStore && params.sessionKey) {
    params.sessionEntry.groupActivation = activationCommand.mode;
    params.sessionEntry.groupActivationNeedsSystemIntro = true;
    await persistSessionEntry(params);
  }
  return {
    shouldContinue: false,
    reply: {
      text: `⚙️ Group activation set to ${activationCommand.mode}.`,
    },
  };
};

export const handleSendPolicyCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const sendPolicyCommand = parseSendPolicyCommand(params.command.commandBodyNormalized);
  if (!sendPolicyCommand.hasCommand) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /send from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!sendPolicyCommand.mode) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Usage: /send on|off|inherit" },
    };
  }
  if (params.sessionEntry && params.sessionStore && params.sessionKey) {
    if (sendPolicyCommand.mode === "inherit") {
      delete params.sessionEntry.sendPolicy;
    } else {
      params.sessionEntry.sendPolicy = sendPolicyCommand.mode;
    }
    await persistSessionEntry(params);
  }
  const label =
    sendPolicyCommand.mode === "inherit"
      ? "inherit"
      : sendPolicyCommand.mode === "allow"
        ? "on"
        : "off";
  return {
    shouldContinue: false,
    reply: { text: `⚙️ Send policy set to ${label}.` },
  };
};

export const handleUsageCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/usage" && !normalized.startsWith("/usage ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /usage from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const rawArgs = normalized === "/usage" ? "" : normalized.slice("/usage".length).trim();
  const requested = rawArgs ? normalizeUsageDisplay(rawArgs) : undefined;
  if (rawArgs.toLowerCase().startsWith("cost")) {
    const sessionSummary = await loadSessionCostSummary({
      sessionId: params.sessionEntry?.sessionId,
      sessionEntry: params.sessionEntry,
      sessionFile: params.sessionEntry?.sessionFile,
      config: params.cfg,
      agentId: params.agentId,
    });
    const summary = await loadCostUsageSummary({ days: 30, config: params.cfg });

    const sessionCost = formatUsd(sessionSummary?.totalCost);
    const sessionTokens = sessionSummary?.totalTokens
      ? formatTokenCount(sessionSummary.totalTokens)
      : undefined;
    const sessionMissing = sessionSummary?.missingCostEntries ?? 0;
    const sessionSuffix = sessionMissing > 0 ? " (partial)" : "";
    const sessionLine =
      sessionCost || sessionTokens
        ? `Session ${sessionCost ?? "n/a"}${sessionSuffix}${sessionTokens ? ` · ${sessionTokens} tokens` : ""}`
        : "Session n/a";

    const todayKey = new Date().toLocaleDateString("en-CA");
    const todayEntry = summary.daily.find((entry) => entry.date === todayKey);
    const todayCost = formatUsd(todayEntry?.totalCost);
    const todayMissing = todayEntry?.missingCostEntries ?? 0;
    const todaySuffix = todayMissing > 0 ? " (partial)" : "";
    const todayLine = `Today ${todayCost ?? "n/a"}${todaySuffix}`;

    const last30Cost = formatUsd(summary.totals.totalCost);
    const last30Missing = summary.totals.missingCostEntries;
    const last30Suffix = last30Missing > 0 ? " (partial)" : "";
    const last30Line = `Last 30d ${last30Cost ?? "n/a"}${last30Suffix}`;

    return {
      shouldContinue: false,
      reply: { text: `💸 Usage cost\n${sessionLine}\n${todayLine}\n${last30Line}` },
    };
  }

  if (rawArgs && !requested) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Usage: /usage off|tokens|full|cost" },
    };
  }

  const currentRaw =
    params.sessionEntry?.responseUsage ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey]?.responseUsage : undefined);
  const current = resolveResponseUsageMode(currentRaw);
  const next = requested ?? (current === "off" ? "tokens" : current === "tokens" ? "full" : "off");

  if (params.sessionEntry && params.sessionStore && params.sessionKey) {
    if (next === "off") {
      delete params.sessionEntry.responseUsage;
    } else {
      params.sessionEntry.responseUsage = next;
    }
    await persistSessionEntry(params);
  }

  return {
    shouldContinue: false,
    reply: {
      text: `⚙️ Usage footer: ${next}.`,
    },
  };
};

export const handleSessionCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (!/^\/session(?:\s|$)/.test(normalized)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /session from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const rest = normalized.slice(SESSION_COMMAND_PREFIX.length).trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  const action = tokens[0]?.toLowerCase();
  if (action !== "ttl") {
    return {
      shouldContinue: false,
      reply: { text: resolveSessionCommandUsage() },
    };
  }

  if (!isDiscordSurface(params)) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ /session ttl is currently available for Discord thread-bound sessions." },
    };
  }

  const threadId =
    params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
  if (!threadId) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ /session ttl must be run inside a focused Discord thread." },
    };
  }

  const accountId = resolveDiscordAccountId(params);
  const threadBindings = getThreadBindingManager(accountId);
  if (!threadBindings) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Discord thread bindings are unavailable for this account." },
    };
  }

  const binding = threadBindings.getByThreadId(threadId);
  if (!binding) {
    return {
      shouldContinue: false,
      reply: { text: "ℹ️ This thread is not currently focused." },
    };
  }

  const ttlArgRaw = tokens.slice(1).join("");
  if (!ttlArgRaw) {
    const expiresAt = binding.expiresAt;
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      return {
        shouldContinue: false,
        reply: {
          text: `ℹ️ Session TTL active (${formatThreadBindingTtlLabel(expiresAt - Date.now())}, auto-unfocus at ${formatSessionExpiry(expiresAt)}).`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: "ℹ️ Session TTL is currently disabled for this focused session." },
    };
  }

  const senderId = params.command.senderId?.trim() || "";
  if (binding.boundBy && binding.boundBy !== "system" && senderId && senderId !== binding.boundBy) {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Only ${binding.boundBy} can update session TTL for this thread.` },
    };
  }

  let ttlMs: number;
  try {
    ttlMs = parseSessionTtlMs(ttlArgRaw);
  } catch {
    return {
      shouldContinue: false,
      reply: { text: resolveSessionCommandUsage() },
    };
  }

  const updatedBindings = setThreadBindingTtlBySessionKey({
    targetSessionKey: binding.targetSessionKey,
    accountId,
    ttlMs,
  });
  if (updatedBindings.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Failed to update session TTL for the current binding." },
    };
  }

  if (ttlMs <= 0) {
    return {
      shouldContinue: false,
      reply: {
        text: `✅ Session TTL disabled for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"}.`,
      },
    };
  }

  const expiresAt = updatedBindings[0]?.expiresAt;
  const expiryLabel =
    typeof expiresAt === "number" && Number.isFinite(expiresAt)
      ? formatSessionExpiry(expiresAt)
      : "n/a";
  return {
    shouldContinue: false,
    reply: {
      text: `✅ Session TTL set to ${formatThreadBindingTtlLabel(ttlMs)} for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"} (auto-unfocus at ${expiryLabel}).`,
    },
  };
};

export const handleRestartCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/restart") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /restart from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!isRestartEnabled(params.cfg)) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ /restart is disabled (commands.restart=false).",
      },
    };
  }
  const hasSigusr1Listener = process.listenerCount("SIGUSR1") > 0;
  if (hasSigusr1Listener) {
    scheduleGatewaySigusr1Restart({ reason: "/restart" });
    return {
      shouldContinue: false,
      reply: {
        text: "⚙️ Restarting OpenClaw in-process (SIGUSR1); back in a few seconds.",
      },
    };
  }
  const restartMethod = triggerOpenClawRestart();
  if (!restartMethod.ok) {
    const detail = restartMethod.detail ? ` Details: ${restartMethod.detail}` : "";
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Restart failed (${restartMethod.method}).${detail}`,
      },
    };
  }
  return {
    shouldContinue: false,
    reply: {
      text: `⚙️ Restarting OpenClaw via ${restartMethod.method}; give me a few seconds to come back online.`,
    },
  };
};

export const handleArchiveSessionCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/archive-session") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /archive-session from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!params.sessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Cannot archive this session because no active transcript was found.",
      },
    };
  }
  const lockKey = params.sessionKey || params.sessionEntry.sessionId;
  if (archiveSessionInProgress.has(lockKey)) {
    return {
      shouldContinue: false,
      reply: {
        text: "ℹ️ Archiving current session is already in progress.",
      },
    };
  }
  archiveSessionInProgress.add(lockKey);
  try {
    let shutdownReason = USER_ARCHIVE_SHUTDOWN_REASON;
    await archiveAndTerminateCurrentSession({
      sessionKey: params.sessionKey,
      sessionId: params.sessionEntry.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionEntry.sessionFile,
      agentId: params.agentId,
      flush: async () => {
        if (params.sessionEntry && params.sessionStore && params.sessionKey) {
          await persistSessionEntry(params);
        }
      },
      terminate: (reason) => {
        shutdownReason = reason;
      },
      log: {
        info: (message) => logVerbose(message),
        warn: (message) => logVerbose(message),
      },
    });
    // Prevent transcript re-creation races by removing the archived session entry
    // before shutdown. Any late mirror/persist attempt then sees no active key.
    if (params.sessionKey) {
      delete params.sessionStore?.[params.sessionKey];
      if (params.storePath) {
        await updateSessionStore(params.storePath, (store) => {
          delete store[params.sessionKey];
        });
      }
    }
    requestGatewayStop({ reason: shutdownReason, delayMs: 0 });
    return {
      shouldContinue: false,
      // Do not emit a success chat reply here: sending an assistant reply after
      // archiving can recreate a fresh transcript file for this same session key.
      // UI clients should surface local status and exit immediately after dispatch.
      reply: undefined,
    };
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Archive failed: ${String(err)}\nSession was not terminated.`,
      },
    };
  } finally {
    archiveSessionInProgress.delete(lockKey);
  }
};

export { handleAbortTrigger, handleStopCommand };
