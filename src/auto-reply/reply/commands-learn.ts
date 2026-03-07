import { compactEmbeddedPiSession } from "../../agents/pi-embedded.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";

const LEARN_SYSTEM_PROMPT = [
  "Learning turn.",
  "Analyze the session history and remember important insights.",
].join(" ");

const LEARN_DEFAULT_PROMPT = [
  "Learning turn.",
  "What important insights, lessons, or information should be remembered from this session?",
].join(" ");

function extractLearnFocus(params: {
  rawBody?: string;
  ctx: import("../templating.js").MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): string | undefined {
  const trimmed = params.rawBody?.trim() ?? "";
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
  skillsSnapshot?: Record<string, unknown>;
  provider: string;
  model: string;
  thinkLevel?: string;
  customFocus?: string;
  senderIsOwner: boolean;
  ownerNumbers?: string[];
}): Promise<{ ok: boolean; message?: string }> {
  const customInstructions = params.customFocus
    ? `Focus area: ${params.customFocus}. ${LEARN_DEFAULT_PROMPT}`
    : LEARN_DEFAULT_PROMPT;

  const result = await compactEmbeddedPiSession({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    messageChannel: params.messageChannel,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    sessionFile: params.sessionFile,
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
    customInstructions,
    extraSystemPrompt: LEARN_SYSTEM_PROMPT,
    trigger: "manual",
    senderIsOwner: params.senderIsOwner,
    ownerNumbers: params.ownerNumbers,
  });

  if (result.ok) {
    return { ok: true, message: "Learning completed. Insights saved to memory." };
  }
  return { ok: false, message: result.reason ?? "Learning failed" };
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
  const customFocus = extractLearnFocus({
    rawBody: params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body,
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    isGroup: params.isGroup,
  });

  const result = await runLearnForSession({
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
