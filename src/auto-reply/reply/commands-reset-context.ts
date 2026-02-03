import type { CommandHandler } from "./commands-types.js";
import {
  abortEmbeddedPiRun,
  compactEmbeddedPiSession,
  isEmbeddedPiRunActive,
  waitForEmbeddedPiRunEnd,
} from "../../agents/pi-embedded.js";
import { resolveSessionFilePath } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { formatTokenCount } from "../status.js";
import { incrementCompactionCount } from "./session-updates.js";

const CONTEXT_THRESHOLD_PERCENT = 70;

/**
 * /reset-context command handler
 *
 * 1. Runs compaction
 * 2. Checks context usage
 * 3. If >70% → signals that a new session is needed (returns special result)
 * 4. If ≤70% → confirms context is cleared
 */
export const handleResetContextCommand: CommandHandler = async (params) => {
  const commandNormalized = params.command.commandBodyNormalized;
  const isResetContext =
    commandNormalized === "/reset-context" || commandNormalized.startsWith("/reset-context ");
  if (!isResetContext) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reset-context from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!params.sessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Сброс контекста недоступен (нет session id)." },
    };
  }

  const sessionId = params.sessionEntry.sessionId;
  const contextTokens = params.contextTokens ?? params.sessionEntry.contextTokens ?? 200_000;

  // Step 1: Abort any active run
  if (isEmbeddedPiRunActive(sessionId)) {
    abortEmbeddedPiRun(sessionId);
    await waitForEmbeddedPiRunEnd(sessionId, 15_000);
  }

  // Step 2: Run compaction
  const result = await compactEmbeddedPiSession({
    sessionId,
    sessionKey: params.sessionKey,
    messageChannel: params.command.channel,
    groupId: params.sessionEntry.groupId,
    groupChannel: params.sessionEntry.groupChannel,
    groupSpace: params.sessionEntry.space,
    spawnedBy: params.sessionEntry.spawnedBy,
    sessionFile: resolveSessionFilePath(sessionId, params.sessionEntry),
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    skillsSnapshot: params.sessionEntry.skillsSnapshot,
    provider: params.provider,
    model: params.model,
    thinkLevel: params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel()),
    bashElevated: {
      enabled: false,
      allowed: false,
      defaultLevel: "off",
    },
    ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
  });

  // Step 3: Calculate context usage after compaction
  const tokensAfter = result.result?.tokensAfter ?? params.sessionEntry.totalTokens ?? 0;
  const usagePercent = contextTokens > 0 ? Math.round((tokensAfter / contextTokens) * 100) : 0;

  // Update compaction count if successful
  if (result.ok && result.compacted) {
    await incrementCompactionCount({
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      tokensAfter: result.result?.tokensAfter,
    });
  }

  // Step 4: Check if we need a new session
  if (usagePercent > CONTEXT_THRESHOLD_PERCENT) {
    // Context still too large - advise user to create new session
    const message =
      `⚠️ Контекст слишком большой (${usagePercent}%). ` +
      `Компакция выполнена, но этого недостаточно.\n\n` +
      `➡️ Отправьте /new чтобы создать новую сессию.`;
    enqueueSystemEvent(message, { sessionKey: params.sessionKey });

    return {
      shouldContinue: false,
      reply: { text: message },
    };
  }

  // Context is within acceptable limits
  const tokensBefore = result.result?.tokensBefore;
  const compactLabel = result.ok
    ? result.compacted
      ? tokensBefore != null && tokensAfter != null
        ? `Сжато (${formatTokenCount(tokensBefore)} → ${formatTokenCount(tokensAfter)})`
        : "Сжато"
      : "Сжатие пропущено"
    : "Сжатие не удалось";

  const successMessage = `✅ ${compactLabel}. Текущая загрузка: ${usagePercent}%`;
  enqueueSystemEvent(successMessage, { sessionKey: params.sessionKey });

  return {
    shouldContinue: false,
    reply: { text: successMessage },
  };
};
