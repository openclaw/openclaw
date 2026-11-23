import { randomUUID } from "node:crypto";
import { SESSION_COMPANION_MAX_MS } from "../../packages/gateway-protocol/src/session-companion-contract.js";
import {
  bindOperatorModelExecution,
  prepareSystemAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { buildBtwCliPrompt } from "../agents/btw-prompts.js";
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import { withSessionManagerWrite } from "../agents/sessions/session-manager-write-admission.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import type { SessionEntryCreateWithTranscriptOptions } from "../config/sessions/session-accessor.js";
import { withSessionTranscriptHydrationCaller } from "../config/sessions/session-transcript-hydration-caller.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Message, ImageContent } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { SessionCompanionAskError } from "./session-companion-errors.js";
import {
  resolveSessionCompanionModel,
  type SessionCompanionRunControls,
  resolveSessionCompanionCliRuntime,
  assertSessionCompanionImageInput,
  SESSION_COMPANION_TOOLS,
} from "./session-companion-policy.js";
import type { SessionCompanionPromptMessage } from "./session-companion-prompt.js";

const companionLog = createSubsystemLogger("gateway/session-companion");

export type SessionCompanionRunParams = {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: string;
  controls?: SessionCompanionRunControls;
  sessionKey: string;
  workspaceDir: string;
  systemPrompt: string;
  messages: SessionCompanionPromptMessage[];
  images?: ImageContent[];
  operatorAuthority?: AdmittedRunOperatorAuthority;
  assertSourceCurrent?: () => void;
  followRegistration?: SessionEntryCreateWithTranscriptOptions["followRegistration"];
  assertInputCurrent?: () => void;
  signal: AbortSignal;
  onExecutionStarted: () => void;
};

const EMPTY_USAGE = makeZeroUsageSnapshot();

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

export async function runSessionCompanionModel(params: SessionCompanionRunParams): Promise<string> {
  params.assertSourceCurrent?.();
  params.assertInputCurrent?.();
  const selectedModel = resolveSessionCompanionModel(params);
  const current = params.messages.at(-1);
  if (!current || current.role !== "user") {
    throw new Error("Session companion has no current question.");
  }
  const cliRuntime = await resolveSessionCompanionCliRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    selection: selectedModel,
  });
  if (cliRuntime && params.images?.length) {
    throw new SessionCompanionAskError(
      "image-input-unsupported",
      "Side chat on a CLI runtime cannot read images. Choose an image-capable utility model and retry.",
    );
  }
  const runId = `session-companion-${randomUUID()}`;
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const { prepareInternalSessionEffectsSession, removeInternalSessionEffectsSession } =
    await import("../agents/internal-session-effects.js");
  const target = await prepareInternalSessionEffectsSession({
    agentId: params.agentId,
    cwd: params.workspaceDir,
    runId,
    storePath,
    followRegistration: params.followRegistration,
  });
  const expectedSeedOwner = {
    lifecycleRevision: target.sessionEntry.lifecycleRevision,
    activeWriterRunId: target.sessionEntry.activeWriterRunId,
  };
  let executionStarted = false;
  let preparedRunAdmission: PreparedAgentRunAdmission | undefined;
  let modelExecution: ReturnType<typeof bindOperatorModelExecution>;
  try {
    modelExecution = bindOperatorModelExecution(params.operatorAuthority, {
      provider: selectedModel.provider,
      model: selectedModel.modelId,
    });
    const abortSignal = modelExecution
      ? AbortSignal.any([params.signal, modelExecution.signal])
      : params.signal;
    preparedRunAdmission = prepareSystemAgentRunAdmission(
      params.cfg,
      runId,
      params.agentId,
      "session-companion.ask",
      params.assertSourceCurrent,
      params.operatorAuthority,
    );
    if (cliRuntime) {
      executionStarted = true;
      // Subscription-backed CLI runtimes have no direct provider credential. Their
      // tool-free side question uses bounded context because the CLI bridge cannot
      // scope read-only session tools to the observed session.
      const [{ prepareCliRunContext }, { executePreparedCliRun }] = await Promise.all([
        import("../agents/cli-runner/prepare.runtime.js"),
        import("../agents/cli-runner/execute.runtime.js"),
      ]);
      let prepared: PreparedCliRunContext | undefined;
      let answer: string;
      try {
        params.assertSourceCurrent?.();
        prepared = await prepareCliRunContext({
          preparedRunAdmission,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          sessionEntry: target.sessionEntry,
          sessionFile: target.sessionFile,
          agentId: params.agentId,
          trigger: "manual",
          workspaceDir: params.workspaceDir,
          config: params.cfg,
          prompt: buildBtwCliPrompt({
            messages: params.messages.slice(0, -1).map((message) =>
              toRunnerHistoryMessage(message, {
                provider: cliRuntime,
                modelId: selectedModel.modelId,
              }),
            ),
            question: current.content,
            imageCount: 0,
          }),
          extraSystemPrompt: params.systemPrompt,
          executionMode: "side-question",
          provider: cliRuntime,
          model: selectedModel.modelId,
          ...(params.controls?.thinkLevel ? { thinkLevel: params.controls.thinkLevel } : {}),
          requesterModel: { provider: selectedModel.provider, model: selectedModel.modelId },
          disableTools: true,
          timeoutMs: SESSION_COMPANION_MAX_MS,
          runTimeoutOverrideMs: SESSION_COMPANION_MAX_MS,
          runId,
          authProfileId: selectedModel.profileId,
          abortSignal,
        });
        abortSignal.throwIfAborted();
        params.assertSourceCurrent?.();
        params.onExecutionStarted();
        answer = (await executePreparedCliRun(prepared)).text;
      } finally {
        try {
          await prepared?.preparedBackend.cleanup?.();
        } catch (error) {
          companionLog.warn("Side chat backend cleanup failed", { error });
        }
      }
      modelExecution?.assertCurrent();
      return answer;
    }
    const [{ SessionManager }, { runEmbeddedAgent }] = await Promise.all([
      import("../agents/sessions/index.js"),
      import("../agents/embedded-agent.js"),
    ]);
    const sessionManager = await withSessionTranscriptHydrationCaller("companion", () =>
      SessionManager.openAsync(target, undefined, undefined, params.signal),
    );
    params.signal.throwIfAborted();
    params.assertSourceCurrent?.();
    const assertSeedCurrent = () => {
      abortSignal.throwIfAborted();
      params.assertSourceCurrent?.();
    };
    await withSessionTranscriptWriteAssertion(
      { ...target, expectedOwner: expectedSeedOwner },
      assertSeedCurrent,
      () =>
        withSessionManagerWrite(sessionManager, async () => {
          assertSeedCurrent();
          for (const message of params.messages.slice(0, -1)) {
            assertSeedCurrent();
            await sessionManager.appendMessageAsync(toRunnerHistoryMessage(message, selectedModel));
          }
        }),
    );
    abortSignal.throwIfAborted();
    params.assertInputCurrent?.();
    executionStarted = true;
    const result = await runEmbeddedAgent({
      preparedRunAdmission,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      sandboxSessionKey: params.sessionKey,
      agentId: params.agentId,
      trigger: "manual",
      workspaceDir: params.workspaceDir,
      cwd: params.workspaceDir,
      config: params.cfg,
      // Invocation restrictions survive configured-runtime admission and reload.
      // The internal execution session must not become the session-read target.
      disableToolSearch: true,
      requireWorkspaceOnly: true,
      sessionReadScopeKey: params.sessionKey,
      codeModeOverride: false,
      prompt: current.content,
      images: params.images,
      assertModelInput: params.images?.length ? assertSessionCompanionImageInput : undefined,
      provider: selectedModel.runtimeProvider ?? selectedModel.provider,
      model: selectedModel.modelId,
      ...params.controls,
      modelFallbacksOverride: [],
      requestedRouteResolution: "resolved",
      agentHarnessRuntimeOverride: "openclaw",
      authProfileId: selectedModel.profileId,
      authProfileIdSource: selectedModel.profileId ? "user" : undefined,
      onExecutionStarted: params.onExecutionStarted,
      timeoutMs: SESSION_COMPANION_MAX_MS,
      runTimeoutOverrideMs: SESSION_COMPANION_MAX_MS,
      runId,
      abortSignal,
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
    modelExecution?.assertCurrent();
    if (
      result.meta.timeoutPhase ||
      result.meta.modelFallbackStopReason === "idle_timeout_circuit_breaker" ||
      result.meta.modelFallbackStopReason === "agent_run_terminal_timeout"
    ) {
      throw new SessionCompanionAskError("timeout", "Side chat timed out. Try again.");
    }
    return (
      result.meta.finalAssistantVisibleText ??
      result.payloads
        ?.filter((payload) => payload.isReasoning !== true && typeof payload.text === "string")
        .map((payload) => payload.text)
        .join("") ??
      ""
    );
  } finally {
    try {
      preparedRunAdmission?.close();
      await removeInternalSessionEffectsSession(
        target,
        executionStarted ? undefined : expectedSeedOwner,
      ).catch((error: unknown) => {
        // Cleanup must not replace a completed answer or replay it through fallback.
        companionLog.warn("Side chat internal session cleanup failed", { error });
      });
    } finally {
      modelExecution?.release();
    }
  }
}
