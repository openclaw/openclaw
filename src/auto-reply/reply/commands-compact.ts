import {
  abortEmbeddedPiRun,
  compactEmbeddedPiSession,
  isEmbeddedPiRunActive,
  waitForEmbeddedPiRunEnd,
} from "../../agents/pi-embedded.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveFreshSessionTotalTokens,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { formatContextUsageShort, formatTokenCount } from "../status.js";
import type { CommandHandler } from "./commands-types.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { incrementCompactionCount } from "./session-updates.js";

/**
 * Rewrite generic SDK cancellation reasons into user-friendly messages.
 *
 * The pi-coding-agent SDK returns "Compaction cancelled" when an extension
 * cancels via `{ cancel: true }`, but that tells the user nothing about *why*.
 * This function maps known reason patterns to actionable descriptions.
 */
function humanizeCompactionReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  // The safeguard extension now sets specific reasons via lastCancelReason,
  // which compact.ts retrieves and passes through instead of the generic
  // "Compaction cancelled" from the SDK. Handle both the new specific reasons
  // and the old generic fallback.
  if (lower === "no compaction model configured") {
    return "no compaction model is configured — check your model settings";
  }
  if (lower === "no api key available for compaction model") {
    return "no API key available for the compaction model";
  }
  if (lower.startsWith("summarization failed:")) {
    return trimmed; // Already descriptive enough
  }
  // Generic SDK fallback (should be rare now that safeguard sets specific reasons)
  if (lower === "compaction cancelled" || lower === "compaction canceled") {
    return "compaction was not needed or could not run — check /status for details";
  }
  if (lower === "no real conversation messages") {
    return "no conversation messages to summarize";
  }
  return trimmed;
}

function extractCompactInstructions(params: {
  rawBody?: string;
  ctx: import("../templating.js").MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): string | undefined {
  const raw = stripStructuralPrefixes(params.rawBody ?? "");
  const stripped = params.isGroup
    ? stripMentions(raw, params.ctx, params.cfg, params.agentId)
    : raw;
  const trimmed = stripped.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  const prefix = lowered.startsWith("/compact") ? "/compact" : null;
  if (!prefix) {
    return undefined;
  }
  let rest = trimmed.slice(prefix.length).trimStart();
  if (rest.startsWith(":")) {
    rest = rest.slice(1).trimStart();
  }
  return rest.length ? rest : undefined;
}

export const handleCompactCommand: CommandHandler = async (params) => {
  const compactRequested =
    params.command.commandBodyNormalized === "/compact" ||
    params.command.commandBodyNormalized.startsWith("/compact ");
  if (!compactRequested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /compact from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!params.sessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Compaction unavailable (missing session id)." },
    };
  }
  const sessionId = params.sessionEntry.sessionId;
  if (isEmbeddedPiRunActive(sessionId)) {
    abortEmbeddedPiRun(sessionId);
    await waitForEmbeddedPiRunEnd(sessionId, 15_000);
  }
  const customInstructions = extractCompactInstructions({
    rawBody: params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body,
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    isGroup: params.isGroup,
  });
  const result = await compactEmbeddedPiSession({
    sessionId,
    sessionKey: params.sessionKey,
    allowGatewaySubagentBinding: true,
    messageChannel: params.command.channel,
    groupId: params.sessionEntry.groupId,
    groupChannel: params.sessionEntry.groupChannel,
    groupSpace: params.sessionEntry.space,
    spawnedBy: params.sessionEntry.spawnedBy,
    sessionFile: resolveSessionFilePath(
      sessionId,
      params.sessionEntry,
      resolveSessionFilePathOptions({
        agentId: params.agentId,
        storePath: params.storePath,
      }),
    ),
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
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
    customInstructions,
    trigger: "manual",
    senderIsOwner: params.command.senderIsOwner,
    ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
  });

  const rawReason = result.reason?.trim();
  const rawReasonLower = rawReason?.toLowerCase();
  // Benign skips: context too low or no messages — the system worked as intended.
  // These get a friendly "Compaction skipped" label.
  const isCancellation =
    rawReasonLower === "compaction cancelled" ||
    rawReasonLower === "compaction canceled" ||
    rawReasonLower === "no real conversation messages";
  // Configuration/runtime errors still show "Compaction failed" so the user
  // knows action is needed (e.g. missing model, missing API key, crash).
  const compactLabel = result.ok
    ? result.compacted
      ? result.result?.tokensBefore != null && result.result?.tokensAfter != null
        ? `Compacted (${formatTokenCount(result.result.tokensBefore)} → ${formatTokenCount(result.result.tokensAfter)})`
        : result.result?.tokensBefore
          ? `Compacted (${formatTokenCount(result.result.tokensBefore)} before)`
          : "Compacted"
      : "Compaction skipped"
    : isCancellation
      ? "Compaction skipped"
      : "Compaction failed";
  if (result.ok && result.compacted) {
    await incrementCompactionCount({
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      // Update token counts after compaction
      tokensAfter: result.result?.tokensAfter,
    });
  }
  // Use the post-compaction token count for context summary if available
  const tokensAfterCompaction = result.result?.tokensAfter;
  const totalTokens = tokensAfterCompaction ?? resolveFreshSessionTotalTokens(params.sessionEntry);
  const contextSummary = formatContextUsageShort(
    typeof totalTokens === "number" && totalTokens > 0 ? totalTokens : null,
    params.contextTokens ?? params.sessionEntry.contextTokens ?? null,
  );
  const reason = humanizeCompactionReason(rawReason);
  const line = reason
    ? `${compactLabel}: ${reason} • ${contextSummary}`
    : `${compactLabel} • ${contextSummary}`;
  enqueueSystemEvent(line, { sessionKey: params.sessionKey });
  return { shouldContinue: false, reply: { text: `⚙️ ${line}` } };
};
