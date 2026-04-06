import { extractCompactionStageTelemetry } from "../../agents/compaction.js";
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

function parseCompactCommand(params: {
  rawBody?: string;
  ctx: import("../templating.js").MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): { instructions?: string; dryRun: boolean } {
  const raw = stripStructuralPrefixes(params.rawBody ?? "");
  const stripped = params.isGroup
    ? stripMentions(raw, params.ctx, params.cfg, params.agentId)
    : raw;
  const trimmed = stripped.trim();
  if (!trimmed) {
    return { dryRun: false };
  }
  const lowered = trimmed.toLowerCase();
  const prefix = lowered.startsWith("/compact") ? "/compact" : null;
  if (!prefix) {
    return { dryRun: false };
  }
  let rest = trimmed.slice(prefix.length).trimStart();
  if (rest.startsWith(":")) {
    rest = rest.slice(1).trimStart();
  }

  let dryRun = false;
  for (const flag of ["--dry-run", "--inspect"]) {
    if (rest === flag || rest.startsWith(`${flag} `) || rest.startsWith(`${flag}:`)) {
      dryRun = true;
      rest = rest.slice(flag.length).trimStart();
      if (rest.startsWith(":")) {
        rest = rest.slice(1).trimStart();
      }
      break;
    }
  }

  return { instructions: rest.length ? rest : undefined, dryRun };
}

function isCompactionSkipReason(reason?: string): boolean {
  const text = reason?.trim().toLowerCase() ?? "";
  return (
    text.includes("nothing to compact") ||
    text.includes("below threshold") ||
    text.includes("already compacted") ||
    text.includes("no real conversation messages")
  );
}

function formatCompactionReason(reason?: string): string | undefined {
  const text = reason?.trim();
  if (!text) {
    return undefined;
  }

  const lower = text.toLowerCase();
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

type CompactionDryRunInspectDetails = {
  topContributors?: Array<{ role?: string; chars?: number; tool?: string }>;
  lightTrim?: {
    trimmedMessages?: number;
    trimmedToolResults?: number;
    tokenDelta?: number;
  };
};

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatCompactionDryRunHints(
  details: CompactionDryRunInspectDetails | undefined,
  telemetry: ReturnType<typeof extractCompactionStageTelemetry>,
): string[] {
  const hints: string[] = [];

  if (details?.lightTrim) {
    const trimParts: string[] = [];
    const trimmedMessages = Math.max(0, details.lightTrim.trimmedMessages ?? 0);
    const trimmedToolResults = Math.max(0, details.lightTrim.trimmedToolResults ?? 0);
    if (trimmedMessages > 0) {
      trimParts.push(pluralize(trimmedMessages, "msg"));
    }
    if (trimmedToolResults > 0) {
      trimParts.push(pluralize(trimmedToolResults, "tool"));
    }
    if (trimParts.length > 0) {
      const tokenDelta = Math.max(0, details.lightTrim.tokenDelta ?? 0);
      hints.push(
        tokenDelta > 0
          ? `light-trim=${trimParts.join("/")} (-${formatTokenCount(tokenDelta)} tok)`
          : `light-trim=${trimParts.join("/")}`,
      );
    }
  }

  const droppedMessages = Math.max(0, telemetry?.droppedMessages ?? 0);
  const droppedChunks = Math.max(0, telemetry?.droppedChunks ?? 0);
  if (droppedMessages > 0 || droppedChunks > 0) {
    const pruneParts: string[] = [];
    if (droppedMessages > 0) {
      pruneParts.push(pluralize(droppedMessages, "msg"));
    }
    if (droppedChunks > 0) {
      pruneParts.push(pluralize(droppedChunks, "chunk"));
    }
    hints.push(`history-prune=${pruneParts.join("/")}`);
  }

  const qualityRetriesPlanned = Math.max(0, telemetry?.qualityRetriesPlanned ?? 0);
  if (telemetry?.qualityGuardEnabled && qualityRetriesPlanned > 0) {
    hints.push(`quality-guard≤${pluralize(qualityRetriesPlanned, "retry")}`);
  }

  return hints;
}

function formatCompactionDryRunLine(params: {
  result: Awaited<ReturnType<typeof compactEmbeddedPiSession>>;
  contextSummary: string;
}): string {
  const telemetry = extractCompactionStageTelemetry(params.result.result?.details);
  const details =
    params.result.result?.details && typeof params.result.result.details === "object"
      ? (params.result.result.details as CompactionDryRunInspectDetails)
      : undefined;
  const stagePlan = telemetry?.plan?.map((entry) => entry.stage).join(" → ") || "finalize";
  const entryReason = telemetry?.entryReason?.replaceAll("_", " ") ?? "summary ready";
  const topContributor = details?.topContributors?.[0];
  const topLabel = topContributor?.tool
    ? `${topContributor.role}:${topContributor.tool}`
    : topContributor?.role;
  const parts = [`Dry-run: would run ${stagePlan} (${entryReason})`];
  if (topLabel) {
    parts.push(`top=${topLabel}`);
  }
  parts.push(...formatCompactionDryRunHints(details, telemetry));
  parts.push(params.contextSummary);
  return parts.join(" • ");
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
  const compactCommand = parseCompactCommand({
    rawBody: params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body,
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    isGroup: params.isGroup,
  });
  if (compactCommand.dryRun && isEmbeddedPiRunActive(sessionId)) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Dry-run unavailable while the session is actively running." },
    };
  }
  if (isEmbeddedPiRunActive(sessionId)) {
    abortEmbeddedPiRun(sessionId);
    await waitForEmbeddedPiRunEnd(sessionId, 15_000);
  }
  const customInstructions = compactCommand.instructions;
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
    dryRun: compactCommand.dryRun,
    trigger: "manual",
    senderIsOwner: params.command.senderIsOwner,
    ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
  });

  const compactLabel = compactCommand.dryRun
    ? "Compaction dry-run"
    : result.ok || isCompactionSkipReason(result.reason)
      ? result.compacted
        ? result.result?.tokensBefore != null && result.result?.tokensAfter != null
          ? `Compacted (${formatTokenCount(result.result.tokensBefore)} → ${formatTokenCount(result.result.tokensAfter)})`
          : result.result?.tokensBefore
            ? `Compacted (${formatTokenCount(result.result.tokensBefore)} before)`
            : "Compacted"
        : "Compaction skipped"
      : "Compaction failed";
  if (!compactCommand.dryRun && result.ok && result.compacted) {
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
  const reason = formatCompactionReason(result.reason);
  const line = compactCommand.dryRun
    ? formatCompactionDryRunLine({ result, contextSummary })
    : reason
      ? `${compactLabel}: ${reason} • ${contextSummary}`
      : `${compactLabel} • ${contextSummary}`;
  if (!compactCommand.dryRun) {
    enqueueSystemEvent(line, { sessionKey: params.sessionKey });
  }
  return { shouldContinue: false, reply: { text: `⚙️ ${line}` } };
};
