import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionCompanionExchange } from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  bindOperatorModelExecution,
  prepareSystemAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { buildBtwCliPrompt } from "../agents/btw-prompts.js";
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import type { InternalSessionEffectsTarget } from "../agents/internal-session-effects.js";
import { withSessionManagerWrite } from "../agents/sessions/session-manager-write-admission.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Message, Usage, ImageContent } from "../llm/types.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveChatAttachmentMaxBytes } from "./chat-attachment-policy.js";
import { parseMessageWithAttachments, type ChatAttachment } from "./chat-attachments.js";
import type { SessionCompanionContextReader } from "./session-companion-context.js";
import { SessionCompanionAskError } from "./session-companion-errors.js";
import {
  buildSessionCompanionSystemPrompt,
  resolveSessionCompanionModel,
  resolveSessionCompanionCliRuntime,
  assertSessionCompanionImageInput,
  SESSION_COMPANION_TOOLS,
} from "./session-companion-policy.js";
import {
  trimSessionCompanionExchanges,
  type SessionCompanionThread,
} from "./session-companion-state.js";
import type { SessionObserverCompanionSnapshot } from "./session-observer-contract.js";
import { sessionObserverScopeKey } from "./session-observer-model.js";

const companionLog = createSubsystemLogger("gateway/session-companion");

const ASK_TIMEOUT_MS = 60_000;
const ANSWER_MAX_CHARS = 1200;
const DELTA_MAX_BYTES = 4 * 1024;
const MAX_CONCURRENT_ASKS = 6;
const ASK_RATE_WINDOW_MS = 60_000;
const MAX_ASKS_PER_RATE_WINDOW = 12;
const MAX_ASKS_PER_CONNECTION_RATE_WINDOW = 4;

type SessionCompanionPromptMessage = {
  role: "user" | "assistant";
  content: string;
  ts: number;
};

type SessionCompanionRunParams = {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: string;
  sessionKey: string;
  workspaceDir: string;
  systemPrompt: string;
  messages: SessionCompanionPromptMessage[];
  images?: ImageContent[];
  operatorAuthority?: AdmittedRunOperatorAuthority;
  assertSourceCurrent?: () => void;
  signal: AbortSignal;
};

export type SessionCompanionAskDeps = {
  getConfig: () => OpenClawConfig;
  sessionObserver: {
    getCompanionSnapshot: (
      sessionKey: string,
      agentId?: string,
    ) => SessionObserverCompanionSnapshot;
  };
  resolveUtilityModelRef?: typeof resolveUtilityModelRefForAgent;
  contextReader: SessionCompanionContextReader;
  run?: (params: SessionCompanionRunParams) => Promise<string>;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

type SessionCompanionAskRuntimeParams = SessionCompanionAskDeps & {
  threads: Map<string, SessionCompanionThread>;
  now: () => number;
  isDisposed: () => boolean;
};

type SessionCompanionCancellationKind =
  | "backing-session-revoked"
  | "disposed"
  | "explicit-reset"
  | "request-aborted"
  | "timeout";

type SessionCompanionActiveAsk = {
  cancellation?: SessionCompanionCancellationKind;
  controller: AbortController;
};

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

async function defaultRun(params: SessionCompanionRunParams): Promise<string> {
  params.assertSourceCurrent?.();
  const selectedModel = resolveSessionCompanionModel({
    cfg: params.cfg,
    agentId: params.agentId,
    modelRef: params.modelRef,
    operatorAuthority: params.operatorAuthority,
  });
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
      const answer = await runSessionCompanionViaCliRuntime({
        ...params,
        cliRuntime,
        modelId: selectedModel.modelId,
        requesterModel: { provider: selectedModel.provider, model: selectedModel.modelId },
        authProfileId: selectedModel.profileId,
        target,
        preparedRunAdmission,
        runId,
        abortSignal,
      });
      modelExecution?.assertCurrent();
      return answer;
    }
    const [{ SessionManager }, { runEmbeddedAgent }] = await Promise.all([
      import("../agents/sessions/index.js"),
      import("../agents/embedded-agent.js"),
    ]);
    const sessionManager = await SessionManager.openAsync(
      target,
      undefined,
      undefined,
      params.signal,
    );
    params.signal.throwIfAborted();
    params.assertSourceCurrent?.();
    await withSessionManagerWrite(sessionManager, () => {
      abortSignal.throwIfAborted();
      params.assertSourceCurrent?.();
      const currentEntry = loadExactSessionEntry(target)?.entry;
      if (
        !currentEntry ||
        currentEntry.sessionId !== target.sessionId ||
        currentEntry.lifecycleRevision !== expectedSeedOwner.lifecycleRevision ||
        currentEntry.activeWriterRunId !== expectedSeedOwner.activeWriterRunId
      ) {
        throw new Error("Session companion identity changed before history persistence");
      }
      for (const message of params.messages.slice(0, -1)) {
        sessionManager.appendMessage(toRunnerHistoryMessage(message, selectedModel));
      }
    });
    abortSignal.throwIfAborted();
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
      modelFallbacksOverride: [],
      requestedRouteResolution: "resolved",
      agentHarnessRuntimeOverride: "openclaw",
      authProfileId: selectedModel.profileId,
      authProfileIdSource: selectedModel.profileId ? "user" : undefined,
      timeoutMs: ASK_TIMEOUT_MS,
      runTimeoutOverrideMs: ASK_TIMEOUT_MS,
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
      );
    } finally {
      modelExecution?.release();
    }
  }
}

/**
 * Subscription-backed CLI runtimes have no direct provider credential, so Side
 * chat runs as a tool-free, one-shot side question on the owning CLI backend.
 * The bounded reference context stands in for the read-only session tools,
 * which the CLI bridge cannot scope to the observed session.
 */
async function runSessionCompanionViaCliRuntime(
  params: SessionCompanionRunParams & {
    cliRuntime: string;
    modelId: string;
    requesterModel: { provider: string; model: string };
    authProfileId?: string;
    target: InternalSessionEffectsTarget;
    preparedRunAdmission: PreparedAgentRunAdmission;
    runId: string;
    abortSignal: AbortSignal;
  },
): Promise<string> {
  const [{ prepareCliRunContext }, { executePreparedCliRun }] = await Promise.all([
    import("../agents/cli-runner/prepare.runtime.js"),
    import("../agents/cli-runner/execute.runtime.js"),
  ]);
  const history = params.messages.slice(0, -1);
  const question = params.messages.at(-1)?.content ?? "";
  let prepared: PreparedCliRunContext | undefined;
  try {
    params.assertSourceCurrent?.();
    prepared = await prepareCliRunContext({
      preparedRunAdmission: params.preparedRunAdmission,
      sessionId: params.target.sessionId,
      sessionKey: params.target.sessionKey,
      sessionEntry: params.target.sessionEntry,
      sessionFile: params.target.sessionFile,
      agentId: params.agentId,
      trigger: "manual",
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      prompt: buildBtwCliPrompt({
        messages: history.map((message) =>
          toRunnerHistoryMessage(message, {
            provider: params.cliRuntime,
            modelId: params.modelId,
          }),
        ),
        question,
        imageCount: 0,
      }),
      extraSystemPrompt: params.systemPrompt,
      executionMode: "side-question",
      provider: params.cliRuntime,
      model: params.modelId,
      requesterModel: params.requesterModel,
      disableTools: true,
      timeoutMs: ASK_TIMEOUT_MS,
      runTimeoutOverrideMs: ASK_TIMEOUT_MS,
      runId: params.runId,
      authProfileId: params.authProfileId,
      abortSignal: params.abortSignal,
    });
    params.abortSignal.throwIfAborted();
    params.assertSourceCurrent?.();
    return (await executePreparedCliRun(prepared)).text;
  } finally {
    await prepared?.preparedBackend.cleanup?.();
  }
}

const PRIVATE_REFERENCE_BEGIN = "<private-session-reference>";
const PRIVATE_REFERENCE_END = "</private-session-reference>";

function escapeReferenceText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatObserverDigest(snapshot: SessionObserverCompanionSnapshot): string {
  const digest = snapshot.digest;
  if (!digest) {
    return "No observer status is available.";
  }
  return [
    `Status: ${digest.health}.`,
    `Headline: ${digest.headline}`,
    digest.assessment ? `Assessment: ${digest.assessment}` : "",
    digest.planProgress
      ? `Plan progress: ${digest.planProgress.completed} of ${digest.planProgress.total}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildReferenceContext(params: {
  thread: SessionCompanionThread;
  deltaNotes: Array<{ sequence: number; text: string }>;
}): string {
  const history =
    params.thread.context.messages.length === 0
      ? params.thread.context.empty
        ? "The selected session has no messages."
        : "No bounded user/assistant transcript text was available; use the permitted session tools when needed."
      : params.thread.context.messages
          .map((message) => {
            const label = message.role === "assistant" ? "Assistant" : "Operator";
            return `${label}: ${escapeReferenceText(message.text)}`;
          })
          .join("\n");
  const notes =
    params.deltaNotes.length === 0
      ? "No new observer notes."
      : params.deltaNotes.map((note) => `- ${escapeReferenceText(note.text)}`).join("\n");
  return [
    PRIVATE_REFERENCE_BEGIN,
    "Selected session transcript:",
    history,
    "Selected session status:",
    escapeReferenceText(params.thread.digestText),
    "New observer notes:",
    notes,
    PRIVATE_REFERENCE_END,
  ].join("\n");
}

function selectDeltaNotes(
  snapshot: SessionObserverCompanionSnapshot,
  afterSequence: number,
): {
  notes: Array<{ sequence: number; text: string }>;
  lastSequence: number;
} {
  const candidates = snapshot.notes
    .filter((note) => note.sequence > afterSequence)
    .toSorted((left, right) => left.sequence - right.sequence);
  const selected: Array<{ sequence: number; text: string }> = [];
  let bytes = 2;
  for (const note of candidates.toReversed()) {
    const noteBytes = Buffer.byteLength(JSON.stringify(note), "utf8") + 1;
    if (bytes + noteBytes > DELTA_MAX_BYTES) {
      break;
    }
    selected.unshift(note);
    bytes += noteBytes;
  }
  return {
    notes: selected,
    lastSequence: candidates.at(-1)?.sequence ?? afterSequence,
  };
}

function composePromptMessages(params: {
  thread: SessionCompanionThread;
  question: string;
  referenceContext: string;
  now: number;
}): SessionCompanionPromptMessage[] {
  const messages: SessionCompanionPromptMessage[] = [
    { role: "assistant", content: params.referenceContext, ts: params.now },
  ];
  for (const exchange of params.thread.exchanges) {
    messages.push({ role: "user", content: exchange.question, ts: exchange.ts });
    messages.push({ role: "assistant", content: exchange.answer, ts: exchange.ts });
  }
  messages.push({
    role: "user",
    content: params.question,
    ts: params.now,
  });
  return messages;
}

function isPrivateReferenceEcho(value: string): boolean {
  return value.includes(PRIVATE_REFERENCE_BEGIN) || value.includes(PRIVATE_REFERENCE_END);
}

function sanitizeAnswer(value: string): string {
  const redacted = redactToolPayloadText(value).trim();
  if (isPrivateReferenceEcho(redacted)) {
    return "";
  }
  return truncateUtf16Safe(redacted, ANSWER_MAX_CHARS);
}

function contextError(
  reason: "context-unavailable" | "session-missing",
  message: string,
): SessionCompanionAskError {
  return new SessionCompanionAskError(reason, message);
}

export function createSessionCompanionAskRuntime(params: SessionCompanionAskRuntimeParams) {
  const resolveUtilityModelRef = params.resolveUtilityModelRef ?? resolveUtilityModelRefForAgent;
  const contextReader = params.contextReader;
  const run = params.run ?? defaultRun;
  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  const activeAsks = new Map<string, SessionCompanionActiveAsk>();
  const admissions: Array<{ connId: string; admittedAt: number }> = [];

  const resolveTarget = (sessionKey: string, agentId: string) => {
    const cfg = params.getConfig();
    const observerSnapshot = params.sessionObserver.getCompanionSnapshot(sessionKey, agentId);
    return { agentId, cfg, observerSnapshot };
  };

  const currentSessionId = (sessionKey: string, agentId: string): string | undefined =>
    contextReader.currentSessionId({ agentId, sessionKey });

  const prepareThread = async (
    sessionKey: string,
    agentId: string,
    signal: AbortSignal,
    assertSourceCurrent?: () => void,
  ): Promise<SessionCompanionThread> => {
    const threadKey = sessionObserverScopeKey(sessionKey, agentId);
    const existing = params.threads.get(threadKey);
    const { observerSnapshot } = resolveTarget(sessionKey, agentId);
    if (signal.aborted) {
      throw new Error("session companion preparation was cancelled");
    }
    assertSourceCurrent?.();
    if (existing && currentSessionId(sessionKey, agentId) === existing.context.sessionId) {
      return existing;
    }
    if (existing) {
      params.threads.delete(threadKey);
    }
    const result = await contextReader.read({ agentId, sessionKey, signal });
    if (signal.aborted || params.isDisposed()) {
      throw new Error("session companion preparation was cancelled");
    }
    assertSourceCurrent?.();
    if (result.kind === "missing") {
      throw contextError("session-missing", "The selected session is no longer available.");
    }
    if (result.kind === "unavailable") {
      throw contextError(
        "context-unavailable",
        "The selected session history could not be loaded.",
      );
    }
    if (currentSessionId(sessionKey, agentId) !== result.context.sessionId) {
      throw contextError(
        "context-unavailable",
        "The selected session changed before its history was ready.",
      );
    }
    const thread: SessionCompanionThread = {
      context: result.context,
      digestText: formatObserverDigest(observerSnapshot),
      exchanges: [],
      lastNoteSequence: 0,
      busy: false,
      lastUsedAt: params.now(),
    };
    params.threads.set(threadKey, thread);
    return thread;
  };

  const ask = async (request: {
    agentId: string;
    sessionKey: string;
    question: string;
    attachments?: ChatAttachment[];
    connId: string;
    operatorAuthority?: AdmittedRunOperatorAuthority;
    assertSourceCurrent?: () => void;
    signal?: AbortSignal;
  }): Promise<{ answer: string; ts: number }> => {
    const sessionKey = request.sessionKey.trim();
    const agentId = request.agentId.trim();
    const question = request.question.trim();
    if (!sessionKey || !agentId || !question || params.isDisposed() || request.signal?.aborted) {
      throw new SessionCompanionAskError("unavailable", "Side chat is unavailable.");
    }
    const assertSourceCurrent = request.operatorAuthority
      ? () => {
          request.assertSourceCurrent?.();
          request.operatorAuthority?.assertCurrent();
        }
      : request.assertSourceCurrent;
    assertSourceCurrent?.();
    const requestSignal = request.operatorAuthority?.signal
      ? request.signal
        ? AbortSignal.any([request.signal, request.operatorAuthority.signal])
        : request.operatorAuthority.signal
      : request.signal;
    const threadKey = sessionObserverScopeKey(sessionKey, agentId);
    const existing = params.threads.get(threadKey);
    if (existing?.busy || activeAsks.has(threadKey)) {
      throw new SessionCompanionAskError("busy", "Side chat is answering another question.");
    }
    const admittedAt = params.now();
    const cutoff = admittedAt - ASK_RATE_WINDOW_MS;
    while ((admissions[0]?.admittedAt ?? admittedAt) < cutoff) {
      admissions.shift();
    }
    const connectionAdmissions = admissions.filter(
      (admission) => admission.connId === request.connId,
    );
    const globalRetryAfterMs =
      admissions.length >= MAX_ASKS_PER_RATE_WINDOW
        ? Math.max(1, (admissions[0]?.admittedAt ?? admittedAt) + ASK_RATE_WINDOW_MS - admittedAt)
        : 0;
    const connectionRetryAfterMs =
      connectionAdmissions.length >= MAX_ASKS_PER_CONNECTION_RATE_WINDOW
        ? Math.max(
            1,
            (connectionAdmissions[0]?.admittedAt ?? admittedAt) + ASK_RATE_WINDOW_MS - admittedAt,
          )
        : 0;
    if (
      activeAsks.size >= MAX_CONCURRENT_ASKS ||
      globalRetryAfterMs > 0 ||
      connectionRetryAfterMs > 0
    ) {
      throw new SessionCompanionAskError(
        "rate-limited",
        "Side chat has reached its question limit. Try again shortly.",
        Math.max(
          activeAsks.size >= MAX_CONCURRENT_ASKS ? ASK_TIMEOUT_MS : 0,
          globalRetryAfterMs,
          connectionRetryAfterMs,
        ),
      );
    }

    admissions.push({ connId: request.connId, admittedAt });
    const controller = new AbortController();
    const activeAsk: SessionCompanionActiveAsk = { controller };
    activeAsks.set(threadKey, activeAsk);
    const abort = (cancellation: SessionCompanionCancellationKind) => {
      if (activeAsks.get(threadKey) !== activeAsk || activeAsk.cancellation) {
        return;
      }
      activeAsk.cancellation = cancellation;
      controller.abort();
    };
    const abortRequest = () => abort("request-aborted");
    if (requestSignal?.aborted) {
      abortRequest();
    } else {
      requestSignal?.addEventListener("abort", abortRequest, { once: true });
    }
    const timeout = setTimeoutFn(() => abort("timeout"), ASK_TIMEOUT_MS);
    const aborted = createDeferredCore<never>();
    const onAbort = () =>
      aborted.reject(new Error("session companion ask timed out or was cancelled"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    let ownedThread: SessionCompanionThread | undefined;
    const discardOwnedThread = () => {
      if (ownedThread && params.threads.get(threadKey) === ownedThread) {
        params.threads.delete(threadKey);
      }
    };
    // Preparation shares the model's cancellation race. Late completions must
    // still pass the ownership checks before dispatching or committing an answer.
    const execute = async () => {
      const thread = await prepareThread(
        sessionKey,
        agentId,
        controller.signal,
        assertSourceCurrent,
      );
      ownedThread = thread;
      if (controller.signal.aborted) {
        throw new Error("session companion preparation was cancelled");
      }
      if (thread.busy) {
        throw new SessionCompanionAskError("busy", "Side chat is answering another question.");
      }
      thread.busy = true;
      thread.lastUsedAt = admittedAt;
      const { cfg } = resolveTarget(sessionKey, agentId);
      if (currentSessionId(sessionKey, agentId) !== thread.context.sessionId) {
        params.threads.delete(threadKey);
        throw contextError(
          "context-unavailable",
          "The selected session changed before Side chat could answer.",
        );
      }
      const utilityModelRef = resolveUtilityModelRef({ cfg, agentId });
      if (!utilityModelRef) {
        throw new SessionCompanionAskError(
          "utility-model-unavailable",
          "No utility model is configured for this session.",
        );
      }
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const currentSnapshot = params.sessionObserver.getCompanionSnapshot(sessionKey, agentId);
      thread.digestText = formatObserverDigest(currentSnapshot);
      const delta = selectDeltaNotes(currentSnapshot, thread.lastNoteSequence);
      const referenceContext = buildReferenceContext({
        thread,
        deltaNotes: delta.notes,
      });
      const messages = composePromptMessages({
        thread,
        question,
        referenceContext,
        now: admittedAt,
      });
      const input = await parseMessageWithAttachments(question, request.attachments, {
        maxBytes: resolveChatAttachmentMaxBytes(cfg),
        acceptNonImage: false,
        imageStorage: "inline",
      });
      controller.signal.throwIfAborted();
      assertSourceCurrent?.();
      const rawAnswer = await run({
        cfg,
        agentId,
        modelRef: utilityModelRef,
        sessionKey,
        workspaceDir,
        systemPrompt: buildSessionCompanionSystemPrompt(sessionKey),
        messages,
        ...(input.images.length ? { images: input.images } : {}),
        ...(request.operatorAuthority ? { operatorAuthority: request.operatorAuthority } : {}),
        assertSourceCurrent,
        signal: controller.signal,
      });
      if (activeAsk.cancellation || params.isDisposed()) {
        throw new Error("session companion ask was cancelled");
      }
      assertSourceCurrent?.();
      if (
        params.threads.get(threadKey) !== thread ||
        currentSessionId(sessionKey, agentId) !== thread.context.sessionId
      ) {
        discardOwnedThread();
        throw contextError(
          "context-unavailable",
          "The selected session changed before Side chat could answer.",
        );
      }
      const answer = sanitizeAnswer(rawAnswer);
      if (!answer) {
        throw new Error("session companion returned an empty answer");
      }
      const ts = params.now();
      const exchange: SessionCompanionExchange = { question, answer, ts };
      thread.exchanges.push(exchange);
      trimSessionCompanionExchanges(thread.exchanges);
      thread.lastNoteSequence = delta.lastSequence;
      thread.lastUsedAt = ts;
      return { answer, ts };
    };
    try {
      return await Promise.race([execute(), aborted.promise]);
    } catch (error) {
      if (error instanceof SessionCompanionAskError) {
        throw error;
      }
      if (activeAsk.cancellation === "backing-session-revoked") {
        discardOwnedThread();
        throw contextError(
          "context-unavailable",
          "The selected session changed before Side chat could answer.",
        );
      }
      companionLog.warn("session companion ask failed", { sessionKey, error });
      throw new SessionCompanionAskError(
        "unavailable",
        activeAsk.cancellation === "timeout"
          ? "Side chat timed out."
          : activeAsk.cancellation === "explicit-reset"
            ? "The Side chat request was cancelled."
            : "Side chat could not answer right now.",
      );
    } finally {
      clearTimeoutFn(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      requestSignal?.removeEventListener("abort", abortRequest);
      if (activeAsks.get(threadKey) === activeAsk) {
        activeAsks.delete(threadKey);
      }
      if (ownedThread && params.threads.get(threadKey) === ownedThread) {
        ownedThread.busy = false;
      }
    }
  };

  return {
    ask,
    cancel(
      sessionKey: string,
      agentId: string,
      cancellation: Extract<
        SessionCompanionCancellationKind,
        "backing-session-revoked" | "explicit-reset"
      >,
    ) {
      const activeAsk = activeAsks.get(sessionObserverScopeKey(sessionKey, agentId));
      if (!activeAsk || activeAsk.cancellation) {
        return;
      }
      activeAsk.cancellation = cancellation;
      activeAsk.controller.abort();
    },
    dispose() {
      for (const activeAsk of activeAsks.values()) {
        activeAsk.cancellation ??= "disposed";
        activeAsk.controller.abort();
      }
      activeAsks.clear();
      admissions.length = 0;
    },
  };
}
