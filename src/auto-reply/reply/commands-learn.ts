import fs from "node:fs/promises";
import path from "node:path";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import type { ThinkLevel } from "./directives.js";

const LEARN_SYSTEM_PROMPT = [
  "Learning turn.",
  "Analyze the session history and remember important insights in the specific way the user requests.",
].join(" ");

const LEARN_DEFAULT_PROMPT = [
  "Learning turn.",
  "Analyze the session history and remember important insights in the specific way the user requests.",
  "Focus on: problems identified, solutions discovered, methods that worked, patterns noticed, and any valuable context.",
  "IMPORTANT: Remember ONLY what is truly useful and worth retaining - filter out noise.",
].join(" ");

async function resolveSessionFileWithResetFallback(sessionFile: string): Promise<string> {
  // For pre-reset learning, the session file has been archived to .reset.*
  // so we need to look for the archived file directly
  try {
    const dir = path.dirname(sessionFile);
    const base = path.basename(sessionFile);
    const resetPrefix = `${base}.reset.`;
    const files = await fs.readdir(dir);
    const resetCandidates = files
      .filter((name) => name.startsWith(resetPrefix))
      .sort()
      .reverse();

    if (resetCandidates.length > 0) {
      const archivedPath = path.join(dir, resetCandidates[0]);
      logVerbose(`Learning: using archived session file ${archivedPath}`);
      return archivedPath;
    }
  } catch {
    // Fallback to original path
  }

  return sessionFile;
}

function extractLearnFocus(rawBody?: string): string | undefined {
  const trimmed = rawBody?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  const prefix = lowered.startsWith("/learn") ? "/learn" : null;
  if (!prefix) {
    return undefined;
  }
  let rest = trimmed.slice(prefix.length).trimStart();
  if (rest.startsWith(":")) {
    rest = rest.slice(1).trimStart();
  }
  return rest.length ? rest : undefined;
}

export async function runLearnForSession(params: {
  sessionId: string;
  sessionKey: string;
  messageChannel: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  spawnedBy?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  provider: string;
  model: string;
  thinkLevel?: ThinkLevel;
  customFocus?: string;
  senderIsOwner: boolean;
  ownerNumbers?: string[];
  lane?: string;
}): Promise<{ ok: boolean; message?: string }> {
  const prompt = params.customFocus
    ? `Focus area: ${params.customFocus}. ${LEARN_DEFAULT_PROMPT}`
    : LEARN_DEFAULT_PROMPT;

  // Resolve session file, falling back to archived .reset.* file if needed
  const resolvedSessionFile = await resolveSessionFileWithResetFallback(params.sessionFile);

  try {
    await runEmbeddedPiAgent({
      runId: crypto.randomUUID(),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: resolvedSessionFile,
      messageChannel: params.messageChannel,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.config,
      skillsSnapshot: params.skillsSnapshot,
      provider: params.provider,
      model: params.model,
      thinkLevel: params.thinkLevel ?? "medium",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      prompt,
      extraSystemPrompt: LEARN_SYSTEM_PROMPT,
      trigger: "memory",
      timeoutMs: 5 * 60 * 1000, // 5 minutes
      lane: params.lane,
      senderIsOwner: params.senderIsOwner,
      ownerNumbers: params.ownerNumbers,
    });

    return { ok: true, message: "Learning completed. Insights saved to memory." };
  } catch (err) {
    logVerbose(`Learning failed for session ${params.sessionKey}: ${String(err)}`);
    return { ok: false, message: String(err) };
  }
}

export const handleLearnCommand = async (
  params: import("./commands-types.js").HandleCommandsParams,
  allowTextCommands: boolean,
): Promise<import("./commands-types.js").CommandHandlerResult | null> => {
  const learnRequested =
    params.command.commandBodyNormalized === "/learn" ||
    params.command.commandBodyNormalized.startsWith("/learn ");
  if (!learnRequested) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /learn from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!params.sessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "Learning unavailable (missing session id)." },
    };
  }

  const sessionId = params.sessionEntry.sessionId;
  const customFocus = extractLearnFocus(params.command.commandBodyNormalized);

  if (!params.sessionEntry.sessionFile) {
    return {
      shouldContinue: false,
      reply: { text: "Learning unavailable (missing session file)." },
    };
  }

  const result = await runLearnForSession({
    sessionId,
    sessionKey: params.sessionKey,
    messageChannel: params.command.channel,
    groupId: params.sessionEntry.groupId,
    groupChannel: params.sessionEntry.groupChannel,
    groupSpace: params.sessionEntry.space,
    spawnedBy: params.sessionEntry.spawnedBy,
    sessionFile: params.sessionEntry.sessionFile,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: params.cfg,
    skillsSnapshot: params.sessionEntry.skillsSnapshot,
    provider: params.provider,
    model: params.model,
    thinkLevel: params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel()),
    customFocus,
    senderIsOwner: params.command.senderIsOwner,
    ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
  });

  return {
    shouldContinue: false,
    reply: { text: result.ok ? `📚 ${result.message}` : `⚠️ ${result.message}` },
  };
};
