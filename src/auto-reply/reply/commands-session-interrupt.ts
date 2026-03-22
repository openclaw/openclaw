import crypto from "node:crypto";
import { abortEmbeddedPiRun } from "../../agents/pi-embedded.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { logWarn } from "../../logger.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveSessionEntryForKey, stopSubagentsForRequester } from "./abort.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { clearSessionQueues } from "./queue.js";

export const MAX_INTERRUPT_CHARS = 4_000;
export const INTERRUPT_CONTEXT_NOTE =
  "[User interrupted the running task. Abandon any prior unfinished work and focus on the new instruction below.]\n\n";

export const handleInterruptCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/interrupt" && !normalized.startsWith("/interrupt ")) {
    return null;
  }

  const unauthorized = rejectUnauthorizedCommand(params, "/interrupt");
  if (unauthorized) {
    return unauthorized;
  }

  const interruptMessage = normalized.slice("/interrupt".length).trim();
  if (!interruptMessage) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          "Usage: /interrupt <message>",
          "",
          "Aborts the current agent run and immediately redirects it with a new instruction,",
          "preserving session context (memory, history) so the agent can adapt without a full restart.",
          "",
          "Example: /interrupt actually, focus on the billing module first",
        ].join("\n"),
      },
    };
  }

  if (interruptMessage.length > MAX_INTERRUPT_CHARS) {
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Interrupt message too long (max ${MAX_INTERRUPT_CHARS} chars).`,
      },
    };
  }

  const { entry, key } = resolveSessionEntryForKey(params.sessionStore, params.sessionKey);
  const targetKey = key ?? params.sessionKey;
  const sessionId = entry?.sessionId;

  // Abort the current run and stop any spawned subagents.
  if (sessionId) {
    abortEmbeddedPiRun(sessionId);
  }
  stopSubagentsForRequester({ cfg: params.cfg, requesterSessionKey: targetKey });

  const cleared = clearSessionQueues([targetKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `interrupt: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }

  // Re-queue the interrupt message as a fresh agent turn for this session so
  // the response is delivered back through the normal channel routing.
  const fullMessage = INTERRUPT_CONTEXT_NOTE + interruptMessage;
  try {
    const channel =
      params.ctx.OriginatingChannel ?? params.command.channel ?? INTERNAL_MESSAGE_CHANNEL;
    const to = params.ctx.OriginatingTo ?? params.command.to ?? "";
    await callGateway({
      method: "agent",
      params: {
        message: fullMessage,
        sessionKey: targetKey,
        sessionId,
        deliver: true,
        channel,
        to,
        timeout: 0,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    logWarn(
      `interrupt: failed to re-queue message: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Failed to redirect agent — the run was aborted but the new instruction could not be queued. Please try again.",
      },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: "⚙️ Interrupted — redirecting agent with new instruction." },
  };
};
