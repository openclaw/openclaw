import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { logVerbose } from "../../globals.js";
import type { SessionEchoTarget, SessionEntry } from "../../config/sessions/types.js";
import { normalizeEchoTargetId } from "../../infra/outbound/echo.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const MAX_ECHO_TARGETS = 16;

// Identity of the thread that issued the command, in the SAME shape the echo
// fan-out uses for the turn ORIGIN (agent-runner-execution.ts derives origin
// from lastChannel ?? channel ?? Provider / lastTo / lastAccountId /
// lastThreadId). Capturing the pinned recipient from these exact fields is what
// makes self-exclusion correct: when this thread later drives a turn, origin ===
// the pinned target, so it is excluded from its own fan-out; when a sibling
// thread of the same session drives, origin !== this target, so this thread
// receives the mirror.
function callerEchoTarget(
  entry: SessionEntry,
  params: HandleCommandsParams,
): SessionEchoTarget | null {
  const channel = entry.lastChannel ?? entry.channel ?? params.ctx.Provider;
  const to = entry.lastTo ?? params.ctx.To;
  if (!channel || !to) {
    return null;
  }
  return {
    channel,
    to,
    accountId: entry.lastAccountId ?? params.ctx.AccountId,
    threadId: entry.lastThreadId ?? params.ctx.MessageThreadId,
    label: "pinned",
    addedAt: Date.now(),
  } as SessionEchoTarget;
}

function sameTarget(a: SessionEchoTarget, b: SessionEchoTarget): boolean {
  return (
    a.channel === b.channel &&
    normalizeEchoTargetId(a.channel, a.to) === normalizeEchoTargetId(b.channel, b.to) &&
    (a.accountId ?? "") === (b.accountId ?? "") &&
    String(a.threadId ?? "") === String(b.threadId ?? "")
  );
}

// `/pin` (a.k.a. `/mirror`): opt the CURRENT thread in as a mirror recipient of
// the session it is bound to. Pin-from-here by construction — there is no
// arbitrary-target argument, so a pin can never cross a session boundary: the
// recipient identity and the session both come from this same inbound context.
export const handlePinCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const matches =
    normalized === "/pin" ||
    normalized.startsWith("/pin ") ||
    normalized === "/mirror" ||
    normalized.startsWith("/mirror ");
  if (!matches) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(`Ignoring /pin from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
    return { shouldContinue: false };
  }

  const keyword = normalized.startsWith("/mirror") ? "/mirror" : "/pin";
  const rawArgs = normalized.slice(keyword.length).trim();
  const mode = normalizeLowercaseStringOrEmpty(rawArgs);

  const entry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (!entry || !params.sessionStore || !params.sessionKey) {
    return {
      shouldContinue: false,
      reply: { text: "📌 Cannot pin: no active session in this context." },
    };
  }

  const target = callerEchoTarget(entry, params);
  if (!target) {
    return {
      shouldContinue: false,
      reply: { text: "📌 Cannot pin: this thread has no resolved channel to mirror to." },
    };
  }

  const existing = entry.echoTargets ?? [];
  const isPinned = existing.some((t) => sameTarget(t, target));

  if (!mode || mode === "status") {
    return {
      shouldContinue: false,
      reply: {
        text: isPinned
          ? "📌 This thread is pinned: it mirrors turns from other threads of this session."
          : "📌 This thread is not pinned. Use /pin on to mirror this session's turns here.",
      },
    };
  }

  if (mode === "on") {
    if (isPinned) {
      return { shouldContinue: false, reply: { text: "📌 Already pinned." } };
    }
    if (existing.length >= MAX_ECHO_TARGETS) {
      return {
        shouldContinue: false,
        reply: { text: `📌 Pin limit reached (max ${MAX_ECHO_TARGETS}).` },
      };
    }
    entry.echoTargets = [...existing, target];
    await persistSessionEntry({ ...params, sessionEntry: entry });
    return {
      shouldContinue: false,
      reply: { text: "📌 Pinned. This thread will mirror turns from other threads of this session." },
    };
  }

  if (mode === "off") {
    if (!isPinned) {
      return { shouldContinue: false, reply: { text: "📌 This thread was not pinned." } };
    }
    const filtered = existing.filter((t) => !sameTarget(t, target));
    if (filtered.length > 0) {
      entry.echoTargets = filtered;
    } else {
      delete entry.echoTargets;
    }
    await persistSessionEntry({ ...params, sessionEntry: entry });
    return { shouldContinue: false, reply: { text: "📌 Unpinned. This thread will no longer mirror." } };
  }

  return {
    shouldContinue: false,
    reply: { text: "📌 Usage: /pin on | off | status" },
  };
};
