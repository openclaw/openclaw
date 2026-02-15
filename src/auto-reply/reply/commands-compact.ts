import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import type { CommandHandler } from "./commands-types.js";
import { isCliProvider } from "../../agents/model-selection.js";
import {
  abortEmbeddedPiRun,
  compactEmbeddedPiSession,
  isEmbeddedPiRunActive,
  runEmbeddedPiAgent,
  waitForEmbeddedPiRunEnd,
} from "../../agents/pi-embedded.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import {
  resolveFreshSessionTotalTokens,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { formatContextUsageShort, formatTokenCount } from "../status.js";
import { resolveMemoryFlushSettings } from "./memory-flush.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { incrementCompactionCount } from "./session-updates.js";

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

  // Optional: run a manual memory flush turn before /compact.
  // This is more general than auto memory flush (which triggers near the context window limit).
  const memoryFlushSettings = resolveMemoryFlushSettings(params.cfg);
  if (memoryFlushSettings?.onManualCompact) {
    const memoryFlushWritable = (() => {
      if (!params.sessionKey) {
        return true;
      }
      const runtime = resolveSandboxRuntimeStatus({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
      });
      if (!runtime.sandboxed) {
        return true;
      }
      const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, runtime.agentId);
      return sandboxCfg.workspaceAccess === "rw";
    })();

    const usingCliProvider = params.provider ? isCliProvider(params.provider, params.cfg) : false;

    if (!memoryFlushWritable) {
      logVerbose("Skipping manual /compact memory flush: workspace is read-only.");
    } else if (usingCliProvider) {
      logVerbose("Skipping manual /compact memory flush: CLI providers do not support tool runs.");
    } else {
      try {
        await runEmbeddedPiAgent({
          sessionId,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          messageChannel: params.command.channel,
          messageProvider: params.ctx.Provider?.trim().toLowerCase() || undefined,
          agentAccountId: params.ctx.AccountId,
          messageTo: params.ctx.OriginatingTo ?? params.ctx.To,
          messageThreadId: params.ctx.MessageThreadId ?? undefined,
          groupId: params.sessionEntry.groupId,
          groupChannel: params.sessionEntry.groupChannel,
          groupSpace: params.sessionEntry.space,
          spawnedBy: params.sessionEntry.spawnedBy,
          senderIsOwner: params.command.senderIsOwner,
          ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
          sessionFile: resolveSessionFilePath(sessionId, params.sessionEntry),
          workspaceDir: params.workspaceDir,
          config: params.cfg,
          skillsSnapshot: params.sessionEntry.skillsSnapshot,
          prompt: memoryFlushSettings.prompt,
          extraSystemPrompt: memoryFlushSettings.systemPrompt,
          provider: params.provider,
          model: params.model,
          thinkLevel: params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel()),
          timeoutMs: 120_000,
          runId: randomUUID(),
        });
      } catch (err) {
        logVerbose(`manual /compact memory flush failed: ${String(err)}`);
      }
    }
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

  const compactLabel = result.ok
    ? result.compacted
      ? result.result?.tokensBefore != null && result.result?.tokensAfter != null
        ? `Compacted (${formatTokenCount(result.result.tokensBefore)} → ${formatTokenCount(result.result.tokensAfter)})`
        : result.result?.tokensBefore
          ? `Compacted (${formatTokenCount(result.result.tokensBefore)} before)`
          : "Compacted"
      : "Compaction skipped"
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
  const reason = result.reason?.trim();
  const line = reason
    ? `${compactLabel}: ${reason} • ${contextSummary}`
    : `${compactLabel} • ${contextSummary}`;
  enqueueSystemEvent(line, { sessionKey: params.sessionKey });
  return { shouldContinue: false, reply: { text: `⚙️ ${line}` } };
};
