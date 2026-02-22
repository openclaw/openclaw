import crypto from "node:crypto";
import { resolveAgentDir, resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isEmbeddedPiRunActive, runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { resolveMemoryFlushPromptForRun, resolveMemoryFlushSettings } from "./memory-flush.js";

const SAVE_PROMPT = [
  "Manual memory save requested by user.",
  "Store important context, decisions, and learnings to memory files (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  "IMPORTANT: If the file already exists, APPEND new content only and do not overwrite existing entries.",
  `If nothing worth saving, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

const SAVE_SYSTEM_PROMPT = [
  "Manual memory save turn.",
  "The user explicitly requested a memory save. Capture durable memories to disk.",
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

const RESET_FLUSH_PROMPT = [
  "Session is being reset. Save any important context to memory files now (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  "IMPORTANT: If the file already exists, APPEND new content only and do not overwrite existing entries.",
  `Reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

const RESET_FLUSH_SYSTEM_PROMPT = [
  "Pre-reset memory flush turn.",
  "The user triggered /new or /reset. Write durable notes before the session is cleared.",
  `You must reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

/**
 * Run a memory save/flush turn using the embedded agent.
 * Shared between /save command and pre-reset flush.
 */
export async function runMemorySave(params: {
  cfg: HandleCommandsParams["cfg"];
  sessionEntry: HandleCommandsParams["sessionEntry"];
  sessionKey: HandleCommandsParams["sessionKey"];
  storePath: HandleCommandsParams["storePath"];
  agentId: HandleCommandsParams["agentId"];
  workspaceDir: HandleCommandsParams["workspaceDir"];
  provider: HandleCommandsParams["provider"];
  model: HandleCommandsParams["model"];
  resolvedThinkLevel: HandleCommandsParams["resolvedThinkLevel"];
  resolvedVerboseLevel: HandleCommandsParams["resolvedVerboseLevel"];
  resolvedReasoningLevel: HandleCommandsParams["resolvedReasoningLevel"];
  ownerNumbers?: string[];
  /** Override the default save prompt */
  prompt?: string;
  /** Override the default system prompt */
  systemPrompt?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const sessionId = params.sessionEntry?.sessionId;
  if (!sessionId) {
    return { ok: false, error: "missing session id" };
  }
  if (isEmbeddedPiRunActive(sessionId)) {
    return { ok: false, error: "agent is currently running" };
  }

  const memoryFlushSettings = resolveMemoryFlushSettings(params.cfg);
  const prompt = resolveMemoryFlushPromptForRun({
    prompt: params.prompt ?? memoryFlushSettings?.prompt ?? SAVE_PROMPT,
    cfg: params.cfg,
  });
  const systemPrompt =
    params.systemPrompt ?? memoryFlushSettings?.systemPrompt ?? SAVE_SYSTEM_PROMPT;

  const runId = crypto.randomUUID();
  registerAgentRunContext(runId, {
    sessionKey: params.sessionKey,
    verboseLevel: params.resolvedVerboseLevel,
  });

  try {
    const sessionFile = resolveSessionFilePath(
      sessionId,
      params.sessionEntry,
      resolveSessionFilePathOptions({
        agentId: params.agentId,
        storePath: params.storePath,
      }),
    );

    const agentDir = resolveAgentDir(params.cfg, params.agentId ?? "main");

    await runWithModelFallback({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      agentDir,
      fallbacksOverride: resolveAgentModelFallbacksOverride(params.cfg, params.agentId ?? "main"),
      run: async (provider, model) => {
        return runEmbeddedPiAgent({
          sessionId,
          sessionKey: params.sessionKey,
          sessionFile,
          workspaceDir: params.workspaceDir,
          agentDir,
          config: params.cfg,
          skillsSnapshot: params.sessionEntry?.skillsSnapshot,
          prompt,
          extraSystemPrompt: systemPrompt,
          ownerNumbers: params.ownerNumbers,
          enforceFinalTag: false,
          provider,
          model,
          thinkLevel: params.resolvedThinkLevel,
          verboseLevel: params.resolvedVerboseLevel,
          reasoningLevel: params.resolvedReasoningLevel,
          execOverrides: undefined,
          bashElevated: {
            enabled: false,
            allowed: false,
            defaultLevel: "off",
          },
          timeoutMs: 60_000,
          runId,
        });
      },
    });

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logVerbose(`memory save failed: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Run a pre-reset memory flush. Uses a reset-specific prompt.
 */
export async function runPreResetMemoryFlush(
  params: Parameters<typeof runMemorySave>[0],
): Promise<{ ok: boolean; error?: string }> {
  return runMemorySave({
    ...params,
    prompt: RESET_FLUSH_PROMPT,
    systemPrompt: RESET_FLUSH_SYSTEM_PROMPT,
  });
}

export const handleSaveCommand: CommandHandler = async (params) => {
  const saveRequested =
    params.command.commandBodyNormalized === "/save" ||
    params.command.commandBodyNormalized.startsWith("/save ");
  if (!saveRequested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /save from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const result = await runMemorySave({
    cfg: params.cfg,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    provider: params.provider,
    model: params.model,
    resolvedThinkLevel: params.resolvedThinkLevel,
    resolvedVerboseLevel: params.resolvedVerboseLevel,
    resolvedReasoningLevel: params.resolvedReasoningLevel,
    ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
  });

  if (!result.ok) {
    return {
      shouldContinue: false,
      reply: { text: `💾 Save unavailable (${result.error}).` },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: "💾 Memory saved." },
  };
};
