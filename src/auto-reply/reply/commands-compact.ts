import { statSync } from "node:fs";
import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { CommandHandler } from "./commands-types.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

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
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
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

function estimateTokensFromSessionFile(sessionFile: string | undefined): number | undefined {
  if (!sessionFile) return undefined;
  try {
    const stat = statSync(sessionFile);
    if (!stat.isFile() || stat.size <= 0) return undefined;
    return Math.floor(stat.size / 4);
  } catch {
    return undefined;
  }
}

function isCompactionSkipReason(reason?: string): boolean {
  const text = normalizeOptionalLowercaseString(reason) ?? "";
  return (
    text.includes("nothing to compact") ||
    text.includes("below threshold") ||
    text.includes("already compacted") ||
    text.includes("no real conversation messages")
  );
}

function formatCompactionReason(reason?: string): string | undefined {
  const text = normalizeOptionalString(reason);
  if (!text) {
    return undefined;
  }

  const lower = normalizeLowercaseStringOrEmpty(text);
  if (lower.includes("nothing to compact")) {
    return "nothing compactable in this session yet";
  }
  if (lower.includes("below threshold")) {
    return "context is below the compaction threshold";
  }
  if (lower.includes("already compacted")) {
    return "session was already compacted recently";
  }
  if (lower.includes("no real conversation messages")) {
    return "no real conversation messages yet";
  }
  return text;
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
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (!targetSessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Compaction unavailable (missing session id)." },
    };
  }
  const runtime = await import("./commands-compact.runtime.js");
  const sessionId = targetSessionEntry.sessionId;
  if (runtime.isEmbeddedPiRunActive(sessionId)) {
    runtime.abortEmbeddedPiRun(sessionId);
    await runtime.waitForEmbeddedPiRunEnd(sessionId, 15_000);
  }
  const sessionAgentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : (params.agentId ?? "main");
  const currentAgentId = params.agentId ?? "main";
  const sessionAgentDir =
    sessionAgentId === currentAgentId && params.agentDir
      ? params.agentDir
      : resolveAgentDir(params.cfg, sessionAgentId);
  const customInstructions = extractCompactInstructions({
    rawBody: params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body,
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: sessionAgentId,
    isGroup: params.isGroup,
  });
  const observedContextTokens =
    typeof params.contextTokens === "number" && params.contextTokens > 0
      ? params.contextTokens
      : typeof targetSessionEntry.contextTokens === "number" &&
          targetSessionEntry.contextTokens > 0
        ? targetSessionEntry.contextTokens
        : undefined;
  const result = await runtime.compactEmbeddedPiSession({
    sessionId,
    sessionKey: params.sessionKey,
    allowGatewaySubagentBinding: true,
    messageChannel: params.command.channel,
    groupId: targetSessionEntry.groupId,
    groupChannel: targetSessionEntry.groupChannel,
    groupSpace: targetSessionEntry.space,
    spawnedBy: targetSessionEntry.spawnedBy,
    senderId: params.command.senderId,
    senderName: params.ctx.SenderName,
    senderUsername: params.ctx.SenderUsername,
    senderE164: params.ctx.SenderE164,
    sessionFile: runtime.resolveSessionFilePath(
      sessionId,
      targetSessionEntry,
      runtime.resolveSessionFilePathOptions({
        agentId: sessionAgentId,
        storePath: params.storePath,
      }),
    ),
    workspaceDir: params.workspaceDir,
    agentDir: sessionAgentDir,
    config: params.cfg,
    skillsSnapshot: targetSessionEntry.skillsSnapshot,
    provider: params.provider,
    model: params.model,
    thinkLevel: params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel()),
    bashElevated: {
      enabled: false,
      allowed: false,
      defaultLevel: "off",
    },
    customInstructions,
    currentTokenCount: observedContextTokens,
    trigger: "manual",
    senderIsOwner: params.command.senderIsOwner,
    ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
  });

  const compactLabel =
    result.ok || isCompactionSkipReason(result.reason)
      ? result.compacted
        ? (() => {
            const before = result.result?.tokensBefore;
            const after = result.result?.tokensAfter;
            const hasBefore = typeof before === "number" && before > 0;
            const hasAfter = typeof after === "number" && after >= 0;
            if (hasBefore && hasAfter && before > after) {
              return `Compacted (${runtime.formatTokenCount(before)} → ${runtime.formatTokenCount(after)})`;
            }
            if (hasBefore) {
              return `Compacted (${runtime.formatTokenCount(before)} before)`;
            }
            if (hasAfter) {
              return `Compacted (≈${runtime.formatTokenCount(after)} after)`;
            }
            return "Compacted";
          })()
        : "Compaction skipped"
      : "Compaction failed";
  if (result.ok && result.compacted) {
    await runtime.incrementCompactionCount({
      cfg: params.cfg,
      sessionEntry: targetSessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      // Update token counts after compaction
      tokensAfter: result.result?.tokensAfter,
    });
  }
  // Use the post-compaction token count for context summary if available.
  // Fall back to a JSONL file-size estimate when the stored totalTokens is
  // stale — this can happen for backends that don't report usage back on
  // every turn, leaving the stored value near zero.
  const tokensAfterCompaction = result.result?.tokensAfter;
  const storedTotal = runtime.resolveFreshSessionTotalTokens(targetSessionEntry);
  const sessionFilePath = runtime.resolveSessionFilePath(
    sessionId,
    targetSessionEntry,
    runtime.resolveSessionFilePathOptions({
      agentId: sessionAgentId,
      storePath: params.storePath,
    }),
  );
  const fileEstimate = estimateTokensFromSessionFile(sessionFilePath);
  const fallbackTotal =
    typeof storedTotal === "number" && typeof fileEstimate === "number"
      ? Math.max(storedTotal, fileEstimate)
      : (storedTotal ?? fileEstimate);
  const totalTokens = tokensAfterCompaction ?? fallbackTotal;
  const contextSummary = runtime.formatContextUsageShort(
    typeof totalTokens === "number" && totalTokens > 0 ? totalTokens : null,
    params.contextTokens ?? targetSessionEntry.contextTokens ?? null,
  );
  const reason = formatCompactionReason(result.reason);
  const line = reason
    ? `${compactLabel}: ${reason} • ${contextSummary}`
    : `${compactLabel} • ${contextSummary}`;
  runtime.enqueueSystemEvent(line, { sessionKey: params.sessionKey });
  return { shouldContinue: false, reply: { text: `⚙️ ${line}` } };
};
