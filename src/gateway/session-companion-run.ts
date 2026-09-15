import { randomUUID } from "node:crypto";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { resolveSimpleCompletionSelectionForAgent } from "../agents/simple-completion-runtime.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Message, Usage } from "../llm/types.js";
import {
  buildSessionCompanionRunConfig,
  SESSION_COMPANION_TOOLS,
} from "./session-companion-policy.js";

export const SESSION_COMPANION_ASK_TIMEOUT_MS = 60_000;

export type SessionCompanionPromptMessage = {
  role: "user" | "assistant";
  content: string;
  ts: number;
};

export type SessionCompanionRunParams = {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: string;
  sessionKey: string;
  workspaceDir: string;
  systemPrompt: string;
  messages: SessionCompanionPromptMessage[];
  authorize?: () => boolean;
  signal: AbortSignal;
};

type SessionCompanionAskErrorReason =
  | "busy"
  | "context-unavailable"
  | "rate-limited"
  | "session-missing"
  | "utility-model-unavailable"
  | "unavailable";

export class SessionCompanionAskError extends Error {
  constructor(
    readonly reason: SessionCompanionAskErrorReason,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SessionCompanionAskError";
  }
}

function assertReadAuthorized(authorize?: () => boolean): void {
  if (authorize?.() === false) {
    throw new SessionCompanionAskError("session-missing", "Side chat is unavailable.");
  }
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toRunnerHistoryMessage(
  message: SessionCompanionPromptMessage,
  selection: { provider: string; modelId: string },
): Message {
  if (message.role === "user") {
    return { role: "user", content: message.content, timestamp: message.ts };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: "openai-responses",
    provider: selection.provider,
    model: selection.modelId,
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp: message.ts,
  };
}

export async function runSessionCompanionDefault(
  params: SessionCompanionRunParams,
): Promise<string> {
  assertReadAuthorized(params.authorize);
  const selection = resolveSimpleCompletionSelectionForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    modelRef: params.modelRef,
    useUtilityModel: true,
  });
  if (!selection) {
    throw new Error("No utility model is configured for this session.");
  }
  const current = params.messages.at(-1);
  if (!current || current.role !== "user") {
    throw new Error("Session companion has no current question.");
  }
  const runId = `session-companion-${randomUUID()}`;
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const { prepareInternalSessionEffectsSession, removeInternalSessionEffectsSession } =
    await import("../agents/internal-session-effects.js");
  assertReadAuthorized(params.authorize);
  let target: Awaited<ReturnType<typeof prepareInternalSessionEffectsSession>> | undefined;
  let preparedRunAdmission: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
  try {
    target = await prepareInternalSessionEffectsSession({
      agentId: params.agentId,
      cwd: params.workspaceDir,
      runId,
      storePath,
    });
    assertReadAuthorized(params.authorize);
    preparedRunAdmission = prepareSystemAgentRunAdmission(
      params.cfg,
      runId,
      params.agentId,
      "session-companion.ask",
    );
    const [{ SessionManager }, { runEmbeddedAgent }] = await Promise.all([
      import("../agents/sessions/index.js"),
      import("../agents/embedded-agent.js"),
    ]);
    assertReadAuthorized(params.authorize);
    const sessionManager = SessionManager.open(target);
    for (const message of params.messages.slice(0, -1)) {
      assertReadAuthorized(params.authorize);
      sessionManager.appendMessage(toRunnerHistoryMessage(message, selection));
    }
    assertReadAuthorized(params.authorize);
    const result = await runEmbeddedAgent({
      preparedRunAdmission,
      assertRunAuthorization: () => assertReadAuthorized(params.authorize),
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      sandboxSessionKey: params.sessionKey,
      agentId: params.agentId,
      trigger: "manual",
      workspaceDir: params.workspaceDir,
      cwd: params.workspaceDir,
      config: buildSessionCompanionRunConfig(params.cfg),
      codeModeOverride: false,
      prompt: current.content,
      provider: selection.runtimeProvider ?? selection.provider,
      model: selection.modelId,
      modelFallbacksOverride: [],
      requestedRouteResolution: "resolved",
      agentHarnessRuntimeOverride: "openclaw",
      authProfileId: selection.profileId,
      authProfileIdSource: selection.profileId ? "user" : undefined,
      timeoutMs: SESSION_COMPANION_ASK_TIMEOUT_MS,
      runTimeoutOverrideMs: SESSION_COMPANION_ASK_TIMEOUT_MS,
      runId,
      abortSignal: params.signal,
      extraSystemPrompt: params.systemPrompt,
      promptMode: "minimal",
      bootstrapContextMode: "lightweight",
      toolsAllow: [...SESSION_COMPANION_TOOLS],
      disableMessageTool: true,
      disableTrajectory: true,
      suppressLiveStreamOutput: true,
      cleanupBundleMcpOnRunEnd: true,
      oneShotCliRun: true,
      inputProvenance: { kind: "internal_system", sourceTool: "session-companion" },
    });
    assertReadAuthorized(params.authorize);
    return (
      result.meta.finalAssistantVisibleText ??
      result.payloads
        ?.filter((payload) => payload.isReasoning !== true && typeof payload.text === "string")
        .map((payload) => payload.text)
        .join("") ??
      ""
    );
  } finally {
    preparedRunAdmission?.close();
    await removeInternalSessionEffectsSession(target);
  }
}
