import { callGateway } from "../../../gateway/call.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import {
  COMMAND_SPAWN,
  type ChatMessage,
  type SubagentsCommandContext,
  formatLogLines,
  resolveExplicitSubagentEntryForToken,
  resolveImplicitSubagentEntryForSpawnCommand,
  resolveSubagentTarget,
  resolveSubagentEntryForToken,
  stopWithText,
  stripToolMessages,
} from "./shared.js";

export async function handleSubagentsLogAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { handledPrefix, runs, restTokens } = ctx;
  const firstToken = restTokens[0];
  const loweredFirst = normalizeLowercaseStringOrEmpty(firstToken);
  const implicitTargetAllowed =
    handledPrefix === COMMAND_SPAWN &&
    (!firstToken || loweredFirst === "tools" || /^\d+$/.test(firstToken));
  const explicitTarget = implicitTargetAllowed
    ? null
    : resolveExplicitSubagentEntryForToken(runs, firstToken);

  if (!firstToken && handledPrefix !== COMMAND_SPAWN) {
    return stopWithText("📜 Usage: /subagents log <id|#> [limit]");
  }

  if (handledPrefix === COMMAND_SPAWN && firstToken && !implicitTargetAllowed && !explicitTarget) {
    const targetResolution = resolveSubagentTarget(runs, firstToken);
    return stopWithText(`⚠️ ${targetResolution.error ?? `Unknown subagent id: ${firstToken}`}`);
  }

  const includeTools = restTokens.some(
    (token) => normalizeLowercaseStringOrEmpty(token) === "tools",
  );
  const limitToken = restTokens.find((token) => /^\d+$/.test(token));
  const limit = limitToken ? Math.min(200, Math.max(1, Number.parseInt(limitToken, 10))) : 20;

  const targetResolution =
    handledPrefix === COMMAND_SPAWN
      ? (explicitTarget ?? resolveImplicitSubagentEntryForSpawnCommand(ctx))
      : resolveSubagentEntryForToken(runs, firstToken);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }

  const history = await callGateway<{ messages: Array<unknown> }>({
    method: "chat.history",
    params: { sessionKey: targetResolution.entry.childSessionKey, limit },
  });
  const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
  const filtered = includeTools ? rawMessages : stripToolMessages(rawMessages);
  const lines = formatLogLines(filtered as ChatMessage[]);
  const header = `📜 Subagent log: ${formatRunLabel(targetResolution.entry)}`;
  if (lines.length === 0) {
    return stopWithText(`${header}\n(no messages)`);
  }
  return stopWithText([header, ...lines].join("\n"));
}
