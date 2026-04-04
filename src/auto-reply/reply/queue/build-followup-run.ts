import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { resolveDefaultModelForAgent } from "../../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../../agents/timeout.js";
import { loadConfig } from "../../../config/config.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveStorePath,
} from "../../../config/sessions.js";
import { logVerbose } from "../../../globals.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import type { FollowupRun } from "./types.js";

export type BuildFollowupRunParams = {
  sessionKey: string;
  prompt: string;
  agentId?: string;
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
  originatingChatType?: string;
  /** Override model for this turn */
  model?: string;
  /** Override provider for this turn */
  provider?: string;
  /** Extra system prompt injected for this turn */
  extraSystemPrompt?: string;
  /** Timeout in ms (default: agent config or 300_000) */
  timeoutMs?: number;
  /** Source attribution for logging */
  source?: string;
};

export async function buildFollowupRunForSession(
  params: BuildFollowupRunParams,
): Promise<FollowupRun | null> {
  const source = params.source ?? "plugin.followup";
  const agentId = params.agentId?.trim() || resolveAgentIdFromSessionKey(params.sessionKey);
  const cfg = loadConfig();
  const agentDir = resolveAgentDir(cfg, agentId);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const store = loadSessionStore(resolveStorePath(cfg.session?.store, { agentId }));
  const sessionEntry = store[params.sessionKey];

  if (!sessionEntry) {
    logVerbose(
      `[${source}] session not found for key "${params.sessionKey}"; skipping followup enqueue`,
    );
    return null;
  }

  const agentDefaults = resolveDefaultModelForAgent({ cfg, agentId });
  const provider =
    params.provider?.trim() ||
    sessionEntry.providerOverride?.trim() ||
    sessionEntry.modelProvider?.trim() ||
    agentDefaults.provider ||
    DEFAULT_PROVIDER;
  const model =
    params.model?.trim() ||
    sessionEntry.modelOverride?.trim() ||
    sessionEntry.model?.trim() ||
    agentDefaults.model ||
    DEFAULT_MODEL;
  const sessionFile =
    sessionEntry.sessionFile?.trim() ||
    resolveSessionFilePath(sessionEntry.sessionId, sessionEntry, { agentId });
  const timeoutMs = resolveAgentTimeoutMs({
    cfg,
    overrideMs: params.timeoutMs,
    minMs: 1,
  });

  logVerbose(
    `[${source}] building followup run for session "${params.sessionKey}" (agent=${agentId}, provider=${provider}, model=${model})`,
  );

  return {
    prompt: params.prompt,
    enqueuedAt: Date.now(),
    originatingChannel:
      (params.originatingChannel as FollowupRun["originatingChannel"] | undefined) ??
      sessionEntry.lastChannel,
    originatingTo: params.originatingTo ?? sessionEntry.lastTo,
    originatingAccountId: params.originatingAccountId ?? sessionEntry.lastAccountId,
    originatingThreadId: params.originatingThreadId ?? sessionEntry.lastThreadId,
    originatingChatType: params.originatingChatType ?? sessionEntry.chatType,
    run: {
      agentId,
      agentDir,
      sessionId: sessionEntry.sessionId,
      sessionKey: params.sessionKey,
      senderIsOwner: true,
      sessionFile,
      workspaceDir,
      config: cfg,
      provider,
      model,
      timeoutMs,
      blockReplyBreak: "text_end",
      authProfileId: sessionEntry.authProfileOverride?.trim() || undefined,
      authProfileIdSource: sessionEntry.authProfileOverrideSource,
      extraSystemPrompt: params.extraSystemPrompt,
      // Session runtime levels
      thinkLevel: (sessionEntry.thinkingLevel as FollowupRun["run"]["thinkLevel"]) ?? undefined,
      verboseLevel: (sessionEntry.verboseLevel as FollowupRun["run"]["verboseLevel"]) ?? undefined,
      reasoningLevel: (sessionEntry.reasoningLevel as FollowupRun["run"]["reasoningLevel"]) ?? undefined,
      elevatedLevel: (sessionEntry.elevatedLevel as FollowupRun["run"]["elevatedLevel"]) ?? undefined,
      // Exec overrides from session
      execOverrides: (sessionEntry.execHost || sessionEntry.execSecurity || sessionEntry.execAsk || sessionEntry.execNode)
        ? ({
            host: sessionEntry.execHost,
            security: sessionEntry.execSecurity,
            ask: sessionEntry.execAsk,
            node: sessionEntry.execNode,
          } as FollowupRun["run"]["execOverrides"])
        : undefined,
      // Message provider for reply routing
      messageProvider: sessionEntry.lastChannel ?? undefined,
      // Enforce final reasoning tag for providers that use tagged reasoning output
      ...(isReasoningTagProvider(provider, { config: cfg, workspaceDir, modelId: model })
        ? { enforceFinalTag: true }
        : {}),
    },
  };
}
