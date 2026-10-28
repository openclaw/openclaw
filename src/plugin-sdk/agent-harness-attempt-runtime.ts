import path from "node:path";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { projectChatErrorDetail } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
} from "../agents/embedded-agent-error-observation.js";
import { renderUserFacingText } from "../agents/embedded-agent-helpers/user-facing-text.js";
import { log as embeddedAgentLog } from "../agents/embedded-agent-runner/logger.js";
import type { EmbeddedRunAttemptParams } from "../agents/embedded-agent-runner/run/types.js";
import { classifyFailoverReason } from "../agents/failover/classify.js";
import type { AgentHarnessAttemptParamsV2 } from "../agents/harness/types.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import type { NormalizedUsage } from "../agents/usage.js";
import type { SessionModelContextLimits } from "../config/sessions/session-accessor.sqlite-model-context.js";
import type { OpenClawConfig } from "../config/types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { AssistantMessage, ToolResultMessage, Usage } from "../llm/types.js";

/** Own cancellation admission without interpreting a backend's native stop receipt. */
export function createAgentHarnessAttemptCancellation(params: {
  upstreamSignal?: AbortSignal;
  onAttemptAbort?: () => void;
  state: AgentHarnessAttemptCancellationState;
}) {
  const controller = new AbortController();
  let attemptAbortNotified = false;
  const notifyAttemptAbort = () => {
    if (attemptAbortNotified) {
      return;
    }
    attemptAbortNotified = true;
    params.onAttemptAbort?.();
  };
  const abortExplicitly = (reason: unknown) => {
    if (params.state.terminalOutcomeFrozen) {
      if (params.state.sharedAbortAllowedAfterTerminalOutcome) {
        notifyAttemptAbort();
      }
      return;
    }
    // A controller can call the native cancel hook before this signal's listener.
    // Keep the upstream cause, especially a hard timeout, in either callback order.
    const abortReason = params.upstreamSignal?.aborted ? params.upstreamSignal.reason : reason;
    notifyAttemptAbort();
    params.state.explicitCancellationObserved = true;
    params.state.explicitCancellationReason ??= abortReason;
    controller.abort(abortReason);
  };
  const abortFromUpstream = () => {
    abortExplicitly(params.upstreamSignal?.reason ?? "upstream_abort");
  };
  const dispose = () => {
    params.upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  };
  const freezeTerminalOutcome = () => {
    if (params.state.terminalOutcomeFrozen) {
      return;
    }
    params.state.terminalOutcomeFrozen = true;
    dispose();
  };
  if (params.upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }
  return { controller, abortExplicitly, freezeTerminalOutcome, dispose };
}

export type AgentHarnessAttemptCancellationState = {
  explicitCancellationObserved: boolean;
  explicitCancellationReason?: unknown;
  terminalOutcomeFrozen: boolean;
  sharedAbortAllowedAfterTerminalOutcome: boolean;
};

export type AgentHarnessAttemptTimeout = {
  kind: "execution" | "settlement";
  elapsedMs: number;
  timeoutMs: number;
};

type Deadline = {
  kind: AgentHarnessAttemptTimeout["kind"];
  startedAtMs: number;
  timeoutMs: number;
};

/** Tracks execution and local settlement against their original absolute deadlines. */
export function createAgentHarnessAttemptDeadlineController(params: {
  startedAtMs: number;
  /**
   * Captured alongside startedAtMs, before asynchronous attempt preparation.
   * Official runtime plugins released before 2026.10.6 omit it.
   */
  startedAtMonotonicMs?: number;
  timeoutMs: number;
  settlementTimeoutMs: number;
  signal: AbortSignal;
  onDeadlineChanged?: (
    deadline: { kind: "bounded"; deadlineAtMs: number } | { kind: "unlimited" },
  ) => void;
  onTimeout: (timeout: AgentHarnessAttemptTimeout) => void;
}) {
  // Older version-bound plugins still pass only the epoch start; anchor it to the
  // monotonic clock once so their admitted budget survives instead of becoming NaN.
  const providedMonotonicMs = params.startedAtMonotonicMs;
  const startedAtMonotonicMs =
    providedMonotonicMs !== undefined && Number.isFinite(providedMonotonicMs)
      ? providedMonotonicMs
      : performance.now() - Math.max(0, Date.now() - params.startedAtMs);
  let deadline: Deadline | { kind: "unlimited" } | { kind: "closed" } = { kind: "closed" };
  let timer: ReturnType<typeof setTimeout> | undefined;

  const armDeadline = (next: Deadline) => {
    clearTimeout(timer);
    deadline = next;
    // Queue receipts remain epoch-based; only execution elapsed time is monotonic.
    const deadlineAtMs = next.startedAtMs + next.timeoutMs;
    params.onDeadlineChanged?.({ kind: "bounded", deadlineAtMs });
    const nowMs = next.kind === "execution" ? performance.now() : Date.now();
    const startedMs = next.kind === "execution" ? startedAtMonotonicMs : next.startedAtMs;
    const remainingMs = next.timeoutMs - (nowMs - startedMs);
    timer = setTimeout(
      () => {
        if (deadline !== next || params.signal.aborted) {
          return;
        }
        deadline = { kind: "closed" };
        const firedNowMs = next.kind === "execution" ? performance.now() : Date.now();
        params.onTimeout({
          kind: next.kind,
          elapsedMs: Math.max(0, firedNowMs - startedMs),
          timeoutMs: next.timeoutMs,
        });
      },
      resolveTimerTimeoutMs(Math.max(1, remainingMs), 1),
    );
    timer.unref();
  };
  const dispose = () => {
    deadline = { kind: "closed" };
    clearTimeout(timer);
    params.signal.removeEventListener("abort", dispose);
  };
  if (!params.signal.aborted) {
    params.signal.addEventListener("abort", dispose, { once: true });
    if (params.timeoutMs >= MAX_TIMER_TIMEOUT_MS) {
      deadline = { kind: "unlimited" };
      params.onDeadlineChanged?.({ kind: "unlimited" });
    } else {
      armDeadline({
        kind: "execution",
        startedAtMs: params.startedAtMs,
        timeoutMs: params.timeoutMs,
      });
    }
  }

  return {
    ownsExecutionWait: () =>
      deadline.kind === "unlimited" ||
      (deadline.kind === "execution" &&
        performance.now() < startedAtMonotonicMs + deadline.timeoutMs),
    beginSettlement: (startedAtMs: number) => {
      if (deadline.kind === "closed" || deadline.kind === "settlement") {
        return;
      }
      // Native receipt or an explicit local terminal result ends execution, not
      // projection. The first boundary owns the absolute settlement deadline.
      armDeadline({
        kind: "settlement",
        startedAtMs,
        timeoutMs: params.settlementTimeoutMs,
      });
    },
    dispose,
  };
}

/** Observer failures cannot interrupt the authoritative native attempt. */
export async function emitAgentHarnessAttemptEvent(
  attempt: Pick<EmbeddedRunAttemptParams, "runId" | "sessionKey" | "onAgentEvent">,
  event: AgentHarnessAttemptEvent,
  diagnostics: {
    label: string;
    log: { debug: (message: string, details: { error: unknown }) => void };
  },
): Promise<void> {
  try {
    emitAgentEvent({
      runId: attempt.runId,
      stream: event.stream,
      data: event.data,
      ...(attempt.sessionKey ? { sessionKey: attempt.sessionKey } : {}),
    });
  } catch (error) {
    diagnostics.log.debug(`${diagnostics.label} global agent event emit failed`, { error });
  }
  try {
    await attempt.onAgentEvent?.(event);
  } catch (error) {
    diagnostics.log.debug(`${diagnostics.label} agent event handler threw`, { error });
  }
}

/** Share event bookkeeping while the backend decides whether a native handoff suppresses it. */
export function createAgentHarnessAttemptLifecycle(params: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "provider" | "modelId" | "onExecutionPhase" | "deferTerminalLifecycle"
  >;
  backend: string;
  startedAtMs: number;
  state: { lifecycleStarted: boolean; lifecycleTerminalEmitted: boolean };
  emitEvent: (event: AgentHarnessAttemptEvent) => Promise<void>;
  shouldSuppressTerminal?: () => boolean;
}) {
  const emitLifecycleStart = (model: { provider: string; model: string }) => {
    void params.emitEvent({
      stream: "lifecycle",
      data: { phase: "start", startedAt: params.startedAtMs },
    });
    void params.emitEvent({ stream: "lifecycle", data: { phase: "model", ...model } });
    params.state.lifecycleStarted = true;
  };
  const emitLifecycleTerminal = (data: Record<string, unknown> & { phase: "end" | "error" }) => {
    if (
      !params.state.lifecycleStarted ||
      params.state.lifecycleTerminalEmitted ||
      params.shouldSuppressTerminal?.()
    ) {
      return;
    }
    let terminalData = data;
    if (data.error) {
      const { provider, modelId: model } = params.attempt;
      const rawError = formatErrorMessage(data.error);
      const observed = buildApiErrorObservationFields(rawError, { provider });
      terminalData = {
        ...terminalData,
        error: buildTextObservationFields(renderUserFacingText(rawError, { errorContext: true }), {
          provider,
        }).textPreview,
        errorObservation: projectChatErrorDetail({
          ...observed,
          provider,
          model,
          failoverReason: classifyFailoverReason(rawError, { provider }),
          httpStatus: observed.httpCode ? Number(observed.httpCode) : undefined,
        }),
      };
    }
    void params.emitEvent({
      stream: "lifecycle",
      data: {
        startedAt: params.startedAtMs,
        endedAt: Date.now(),
        ...terminalData,
        ...(params.attempt.deferTerminalLifecycle ? { phase: "finishing" } : {}),
      },
    });
    params.state.lifecycleTerminalEmitted = true;
  };
  const executionPhaseKeys = new Set<string>();
  const emitExecutionPhaseOnce = (key: string, info: AgentHarnessAttemptExecutionPhase) => {
    if (executionPhaseKeys.has(key)) {
      return;
    }
    executionPhaseKeys.add(key);
    params.attempt.onExecutionPhase?.({
      provider: params.attempt.provider,
      model: params.attempt.modelId,
      backend: params.backend,
      ...info,
    });
  };
  return { emitLifecycleStart, emitLifecycleTerminal, emitExecutionPhaseOnce };
}

type AgentHarnessAttemptEvent = Parameters<
  NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>
>[0];
type AgentHarnessAttemptExecutionPhase = Parameters<
  NonNullable<EmbeddedRunAttemptParams["onExecutionPhase"]>
>[0];

/** Preserve a supported effort, otherwise prefer the next higher effort. */
export function selectSupportedReasoningEffort<TEffort extends string>(params: {
  requested: TEffort;
  supportedEfforts: readonly string[];
  effortOrder: readonly TEffort[];
}): TEffort | undefined {
  const declared = new Set(params.supportedEfforts);
  const supported = params.effortOrder.filter((effort) => declared.has(effort));
  if (supported.includes(params.requested)) {
    return params.requested;
  }
  const requestedRank = params.effortOrder.indexOf(params.requested);
  return (
    supported.find((effort) => params.effortOrder.indexOf(effort) >= requestedRank) ??
    supported.at(-1)
  );
}

/** Bound transcript reads to the model budget while preserving owned tool frames. */
export function resolveAgentHarnessHistoryLimits(
  contextTokenBudget?: number,
): SessionModelContextLimits {
  return {
    maxBytes: Math.min(
      64 * 1024 * 1024,
      Math.max(1024, Math.floor((contextTokenBudget ?? 128_000) * 8)),
    ),
    maxEvents: 10_000,
    toolResultOverflow: "omit",
  };
}

export function shouldIncludeAgentHarnessRuntimeContext(
  params: Pick<AgentHarnessAttemptParamsV2, "bootstrapContextMode" | "bootstrapContextRunKind">,
): boolean {
  // Lightweight cron runs can be exact commands; preserve their user input byte-for-byte.
  return !(
    params.bootstrapContextMode === "lightweight" && params.bootstrapContextRunKind === "cron"
  );
}

/** The backend selects the prompt workspace and supplies its admitted tool names. */
export function resolveAgentWorkspaceMemoryRouting(params: {
  config: OpenClawConfig | undefined;
  agentId: string | undefined;
  workspaceDir: string;
  toolNames: ReadonlySet<string>;
}): { memoryToolNames: string[]; memoryToolRouted: boolean } {
  const memoryToolNames = ["memory_search", "memory_get"].filter((name) =>
    params.toolNames.has(name),
  );
  return {
    memoryToolNames,
    memoryToolRouted:
      memoryToolNames.length > 0 &&
      params.config !== undefined &&
      params.agentId !== undefined &&
      path.resolve(resolveAgentWorkspaceDir(params.config, params.agentId)) ===
        path.resolve(params.workspaceDir),
  };
}

export type AgentHarnessMessageAttribution = {
  api: AssistantMessage["api"];
  provider: string;
  modelId: string;
};

export type AgentHarnessAssistantMessageOptions = {
  tokenUsage?: NormalizedUsage;
  aborted: boolean;
  promptError?: unknown;
  errorMessage?: string;
  diagnostics?: AssistantMessage["diagnostics"];
  timestamp?: number;
  content?: AssistantMessage["content"];
};

export function createAgentHarnessAssistantMessage(
  attribution: AgentHarnessMessageAttribution,
  text: string,
  options: AgentHarnessAssistantMessageOptions,
): AssistantMessage {
  return {
    role: "assistant",
    content: options.content ?? [{ type: "text", text }],
    api: attribution.api,
    provider: attribution.provider,
    model: attribution.modelId,
    usage: createAgentHarnessMessageUsage(options.tokenUsage),
    stopReason: options.aborted
      ? "aborted"
      : options.promptError || options.errorMessage
        ? "error"
        : "stop",
    errorMessage:
      options.errorMessage ??
      (options.promptError ? formatErrorMessage(options.promptError) : undefined),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    timestamp: options.timestamp ?? Date.now(),
  };
}

export function createAgentHarnessToolCallMessage(
  attribution: AgentHarnessMessageAttribution,
  input: { id: string; name: string; arguments?: unknown },
  timestamp: number,
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: input.id,
        name: input.name,
        arguments: asNonArrayRecord(input.arguments),
      },
    ],
    api: attribution.api,
    provider: attribution.provider,
    model: attribution.modelId,
    usage: makeZeroUsageSnapshot(),
    stopReason: "toolUse",
    timestamp,
  };
}

export function createAgentHarnessToolResultMessage(
  input: {
    id: string;
    name: string;
    text?: string;
    content?: ToolResultMessage["content"];
    isError: boolean;
    details?: unknown;
  },
  timestamp: number,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: input.id,
    toolName: input.name,
    isError: input.isError,
    content: input.content ?? [
      {
        type: "text",
        text: input.text ?? `${input.name} ${input.isError ? "failed" : "completed"}`,
      },
    ],
    ...(input.details !== undefined ? { details: input.details } : {}),
    timestamp,
  };
}

function createAgentHarnessMessageUsage(usage: NormalizedUsage | undefined): Usage {
  const zero = makeZeroUsageSnapshot();
  return usage
    ? {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage.contextUsage ? { contextUsage: usage.contextUsage } : {}),
        totalTokens:
          usage.total ??
          (usage.input ?? 0) +
            (usage.output ?? 0) +
            (usage.cacheRead ?? 0) +
            (usage.cacheWrite ?? 0),
        cost: zero.cost,
      }
    : zero;
}

type PresentationStage =
  | "onAssistantMessageStart"
  | "onPartialReply"
  | "onReasoningStream"
  | "onReasoningEnd";

export class AgentHarnessProjectionSettlement<
  TParams extends AgentHarnessAttemptParamsV2 = AgentHarnessAttemptParamsV2,
> {
  readonly params: TParams;
  private stage: string | undefined;
  private readonly pending = new Map<Promise<void>, PresentationStage>();

  constructor(params: TParams, isActive: () => boolean, options: { label: string }) {
    const detach = <Args extends unknown[]>(
      stage: PresentationStage,
      callback: ((...args: Args) => unknown) | undefined,
    ): ((...args: Args) => void) | undefined =>
      callback
        ? (...args) => {
            if (!isActive()) {
              return;
            }
            // Presentation callbacks do not synchronously drain their own invocation.
            const completion = (async () => {
              try {
                await callback(...args);
              } catch (error) {
                embeddedAgentLog.warn(
                  `${options.label} ${stage} callback failed: ${String(error)}`,
                );
              }
            })().finally(() => {
              this.pending.delete(completion);
            });
            this.pending.set(completion, stage);
          }
        : undefined;
    this.params = {
      ...params,
      onAssistantMessageStart: detach("onAssistantMessageStart", params.onAssistantMessageStart),
      onPartialReply: detach("onPartialReply", params.onPartialReply),
      onReasoningStream: detach("onReasoningStream", params.onReasoningStream),
      onReasoningEnd: detach("onReasoningEnd", params.onReasoningEnd),
    };
  }

  get pendingStage(): string | undefined {
    return this.stage ?? this.pending.values().next().value;
  }

  async project<T>(stage: string, project: () => Promise<T>): Promise<T> {
    const previous = this.stage;
    this.stage = stage;
    try {
      return await project();
    } finally {
      this.stage = previous;
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending.keys());
    }
  }
}

/** Production-private attempt lifecycle mechanics for official harness plugins. */
export { buildCurrentInboundPrompt } from "../agents/embedded-agent-runner/run/runtime-context-prompt.js";

export {
  NativeToolOutputAccumulator,
  formatNativeToolOutput,
  formatNativeToolSummary,
  MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM,
  TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS,
  truncateNativeToolTranscriptText,
} from "../agents/harness/projection-tool-output.js";
export { makeZeroUsageSnapshot } from "../agents/usage.js";
export { resolveStoredSessionPermissionPolicy } from "../agents/tool-fs-policy.js";
export { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
