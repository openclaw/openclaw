import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { resolveRequesterSessionKey } from "./commands-subagents-dispatch.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND = "/long";

const USAGE =
  "Usage: /long [background|desktop] <task>\n" +
  "Forks the task into a detached background agent that runs independently of " +
  "this conversation and reports back here when it's done.";

/**
 * `/long [mode] <task>` — fork a long-running task into a detached subagent so it
 * survives the conversation turn timeout instead of being killed by the
 * no-output watchdog.
 *
 * - `background` (default): spawn a detached subagent via `spawnSubagentDirect`.
 *   It runs independently and posts its result back into this chat on completion.
 * - `desktop`: host-specific (e.g. open a local Claude Code window). Core OpenClaw
 *   has no portable way to do this, so the command passes the message through
 *   (`shouldContinue: true`) — a workspace instruction or hook can act on it.
 */
export const handleLongCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized.trim();
  if (normalized !== COMMAND && !normalized.startsWith(`${COMMAND} `)) {
    return null;
  }

  const unauthorized = rejectUnauthorizedCommand(params, COMMAND);
  if (unauthorized) {
    return unauthorized;
  }

  let rest = normalized.slice(COMMAND.length).trim();

  // Optional leading mode token. `desktop` is host-specific and not implemented
  // in core — pass the message straight through so a workspace instruction can
  // handle it. `background` is the default and is stripped if stated explicitly.
  const firstToken = rest.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (firstToken === "desktop") {
    return { shouldContinue: true };
  }
  if (firstToken === "background") {
    rest = rest.slice("background".length).trim();
  }

  const task = rest;
  if (!task) {
    return { shouldContinue: false, reply: { text: USAGE } };
  }

  const requesterKey =
    resolveRequesterSessionKey(params, { preferCommandTarget: true }) ?? params.sessionKey;
  const requesterSessionEntry = params.sessionStore?.[requesterKey] ?? params.sessionEntry;
  const agentId = params.agentId?.trim() || "main";

  const commandTo = normalizeOptionalString(params.command.to) ?? "";
  const originatingTo = normalizeOptionalString(params.ctx.OriginatingTo) ?? "";
  const fallbackTo = normalizeOptionalString(params.ctx.To) ?? "";
  const normalizedTo = originatingTo || commandTo || fallbackTo || undefined;

  const result = await spawnSubagentDirect(
    {
      task,
      agentId,
      mode: "run",
      cleanup: "keep",
      expectsCompletionMessage: true,
    },
    {
      agentSessionKey: requesterKey,
      agentChannel: params.ctx.OriginatingChannel ?? params.command.channel,
      agentAccountId: params.ctx.AccountId,
      agentTo: normalizedTo,
      agentThreadId: params.ctx.MessageThreadId,
      agentGroupId: requesterSessionEntry?.groupId ?? null,
      agentGroupChannel: requesterSessionEntry?.groupChannel ?? null,
      agentGroupSpace: requesterSessionEntry?.space ?? null,
    },
  );

  if (result.status === "accepted") {
    const runRef = result.runId ? ` (run ${result.runId.slice(0, 8)})` : "";
    return {
      shouldContinue: false,
      reply: {
        text:
          `🧵 Forked to background${runRef}. It runs independently of this ` +
          "conversation — I'll report back here when it's done. Track it with /subagents list.",
      },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: `⚠️ /long failed to fork: ${result.error ?? result.status}`, isError: true },
  };
};
