import { parseDurationMs } from "../../cli/parse-duration.js";
import { isRestartEnabled } from "../../config/commands.js";
import {
  formatThreadBindingDurationLabel,
  getThreadBindingManager,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
} from "../../discord/monitor/thread-bindings.js";
import { logVerbose } from "../../globals.js";
import { scheduleGatewaySigusr1Restart, triggerOpenClawRestart } from "../../infra/restart.js";
import { loadCostUsageSummary, loadSessionCostSummary } from "../../infra/session-cost-usage.js";
import { formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import { parseActivationCommand } from "../group-activation.js";
import { parseSendPolicyCommand } from "../send-policy.js";
import { normalizeUsageDisplay, resolveResponseUsageMode } from "../thinking.js";
import { handleAbortTrigger, handleStopCommand } from "./commands-session-abort.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";

const SESSION_COMMAND_PREFIX = "/session";
const SESSION_DURATION_OFF_VALUES = new Set(["off", "disable", "disabled", "none", "0"]);
const SESSION_ACTION_IDLE = "idle";
const SESSION_ACTION_MAX_AGE = "max-age";

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
  return "Usage: /session idle <duration|off> | /session max-age <duration|off> (example: /session idle 24h)";
}

function parseSessionDurationMs(raw: string): number {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new Error("missing duration");
  }
  if (SESSION_DURATION_OFF_VALUES.has(normalized)) {
    return 0;
  }
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const hours = Number(normalized);
    if (!Number.isFinite(hours) || hours < 0) {
      throw new Error("invalid duration");
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
  if (action !== SESSION_ACTION_IDLE && action !== SESSION_ACTION_MAX_AGE) {
    return {
      shouldContinue: false,
      reply: { text: resolveSessionCommandUsage() },
    };
  }

  if (!isDiscordSurface(params)) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ /session idle and /session max-age are currently available for Discord thread-bound sessions.",
      },
    };
  }

  const threadId =
    params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
  if (!threadId) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ /session idle and /session max-age must be run inside a focused Discord thread.",
      },
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

  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMs({
    record: binding,
    defaultIdleTimeoutMs: threadBindings.getIdleTimeoutMs(),
  });
  const idleExpiresAt = resolveThreadBindingInactivityExpiresAt({
    record: binding,
    defaultIdleTimeoutMs: threadBindings.getIdleTimeoutMs(),
  });
  const maxAgeMs = resolveThreadBindingMaxAgeMs({
    record: binding,
    defaultMaxAgeMs: threadBindings.getMaxAgeMs(),
  });
  const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
    record: binding,
    defaultMaxAgeMs: threadBindings.getMaxAgeMs(),
  });

  const durationArgRaw = tokens.slice(1).join("");
  if (!durationArgRaw) {
    if (action === SESSION_ACTION_IDLE) {
      if (
        typeof idleExpiresAt === "number" &&
        Number.isFinite(idleExpiresAt) &&
        idleExpiresAt > Date.now()
      ) {
        return {
          shouldContinue: false,
          reply: {
            text: `ℹ️ Idle timeout active (${formatThreadBindingDurationLabel(idleTimeoutMs)}, next auto-unfocus at ${formatSessionExpiry(idleExpiresAt)}).`,
          },
        };
      }
      return {
        shouldContinue: false,
        reply: { text: "ℹ️ Idle timeout is currently disabled for this focused session." },
      };
    }

    if (
      typeof maxAgeExpiresAt === "number" &&
      Number.isFinite(maxAgeExpiresAt) &&
      maxAgeExpiresAt > Date.now()
    ) {
      return {
        shouldContinue: false,
        reply: {
          text: `ℹ️ Max age active (${formatThreadBindingDurationLabel(maxAgeMs)}, hard auto-unfocus at ${formatSessionExpiry(maxAgeExpiresAt)}).`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: "ℹ️ Max age is currently disabled for this focused session." },
    };
  }

  const senderId = params.command.senderId?.trim() || "";
  if (binding.boundBy && binding.boundBy !== "system" && senderId && senderId !== binding.boundBy) {
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Only ${binding.boundBy} can update session lifecycle settings for this thread.`,
      },
    };
  }

  let durationMs: number;
  try {
    durationMs = parseSessionDurationMs(durationArgRaw);
  } catch {
    return {
      shouldContinue: false,
      reply: { text: resolveSessionCommandUsage() },
    };
  }

  const updatedBindings =
    action === SESSION_ACTION_IDLE
      ? setThreadBindingIdleTimeoutBySessionKey({
          targetSessionKey: binding.targetSessionKey,
          accountId,
          idleTimeoutMs: durationMs,
        })
      : setThreadBindingMaxAgeBySessionKey({
          targetSessionKey: binding.targetSessionKey,
          accountId,
          maxAgeMs: durationMs,
        });
  if (updatedBindings.length === 0) {
    return {
      shouldContinue: false,
      reply: {
        text:
          action === SESSION_ACTION_IDLE
            ? "⚠️ Failed to update idle timeout for the current binding."
            : "⚠️ Failed to update max age for the current binding.",
      },
    };
  }

  if (durationMs <= 0) {
    return {
      shouldContinue: false,
      reply: {
        text:
          action === SESSION_ACTION_IDLE
            ? `✅ Idle timeout disabled for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"}.`
            : `✅ Max age disabled for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"}.`,
      },
    };
  }

  const nextBinding = updatedBindings[0];
  const nextExpiry =
    action === SESSION_ACTION_IDLE
      ? resolveThreadBindingInactivityExpiresAt({
          record: nextBinding,
          defaultIdleTimeoutMs: threadBindings.getIdleTimeoutMs(),
        })
      : resolveThreadBindingMaxAgeExpiresAt({
          record: nextBinding,
          defaultMaxAgeMs: threadBindings.getMaxAgeMs(),
        });
  const expiryLabel =
    typeof nextExpiry === "number" && Number.isFinite(nextExpiry)
      ? formatSessionExpiry(nextExpiry)
      : "n/a";

  return {
    shouldContinue: false,
    reply: {
      text:
        action === SESSION_ACTION_IDLE
          ? `✅ Idle timeout set to ${formatThreadBindingDurationLabel(durationMs)} for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"} (next auto-unfocus at ${expiryLabel}).`
          : `✅ Max age set to ${formatThreadBindingDurationLabel(durationMs)} for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"} (hard auto-unfocus at ${expiryLabel}).`,
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

export { handleAbortTrigger, handleStopCommand };
