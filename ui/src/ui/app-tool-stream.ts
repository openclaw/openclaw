import { formatUnknownText, truncateText } from "./format.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

const TOOL_STREAM_LIMIT = 50;
const TOOL_STREAM_THROTTLE_MS = 80;
const TOOL_OUTPUT_CHAR_LIMIT = 120_000;

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
};

export type ToolStreamEntry = {
  toolCallId: string;
  runId: string;
  sessionKey?: string;
  name: string;
  args?: unknown;
  output?: string;
  startedAt: number;
  updatedAt: number;
  message: Record<string, unknown>;
};

type ToolStreamHost = {
  sessionKey: string;
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatStreamSegments: Array<{ text: string; ts: number }>;
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  chatToolMessages: Record<string, unknown>[];
  toolStreamSyncTimer: number | null;
};

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveModelLabel(provider: unknown, model: unknown): string | null {
  const modelValue = toTrimmedString(model);
  if (!modelValue) {
    return null;
  }
  const providerValue = toTrimmedString(provider);
  if (providerValue) {
    const prefix = `${providerValue}/`;
    if (
      normalizeLowercaseStringOrEmpty(modelValue).startsWith(
        normalizeLowercaseStringOrEmpty(prefix),
      )
    ) {
      const trimmedModel = modelValue.slice(prefix.length).trim();
      if (trimmedModel) {
        return `${providerValue}/${trimmedModel}`;
      }
    }
    return `${providerValue}/${modelValue}`;
  }
  const slashIndex = modelValue.indexOf("/");
  if (slashIndex > 0) {
    const p = modelValue.slice(0, slashIndex).trim();
    const m = modelValue.slice(slashIndex + 1).trim();
    if (p && m) {
      return `${p}/${m}`;
    }
  }
  return modelValue;
}

type FallbackAttempt = {
  provider: string;
  model: string;
  reason: string;
};

function parseFallbackAttemptSummaries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => toTrimmedString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function parseFallbackAttempts(value: unknown): FallbackAttempt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: FallbackAttempt[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const provider = toTrimmedString(item.provider);
    const model = toTrimmedString(item.model);
    if (!provider || !model) {
      continue;
    }
    const reason =
      toTrimmedString(item.reason)?.replace(/_/g, " ") ??
      toTrimmedString(item.code) ??
      (typeof item.status === "number" ? `HTTP ${item.status}` : null) ??
      toTrimmedString(item.error) ??
      "error";
    out.push({ provider, model, reason });
  }
  return out;
}

function extractToolOutputText(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = record.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const entry = item as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") {
        return entry.text;
      }
      return null;
    })
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function formatToolOutput(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const contentText = extractToolOutputText(value);
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (contentText) {
    text = contentText;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = formatUnknownText(value);
    }
  }
  const truncated = truncateText(text, TOOL_OUTPUT_CHAR_LIMIT);
  if (!truncated.truncated) {
    return truncated.text;
  }
  return `${truncated.text}\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`;
}

function buildToolStreamMessage(entry: ToolStreamEntry): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  content.push({
    type: "toolcall",
    name: entry.name,
    arguments: entry.args ?? {},
  });
  if (entry.output) {
    content.push({
      type: "toolresult",
      name: entry.name,
      text: entry.output,
    });
  }
  return {
    role: "assistant",
    toolCallId: entry.toolCallId,
    runId: entry.runId,
    content,
    timestamp: entry.startedAt,
  };
}

function trimToolStream(host: ToolStreamHost) {
  if (host.toolStreamOrder.length <= TOOL_STREAM_LIMIT) {
    return;
  }
  const overflow = host.toolStreamOrder.length - TOOL_STREAM_LIMIT;
  const removed = host.toolStreamOrder.splice(0, overflow);
  for (const id of removed) {
    host.toolStreamById.delete(id);
  }
}

function syncToolStreamMessages(host: ToolStreamHost) {
  host.chatToolMessages = host.toolStreamOrder
    .map((id) => host.toolStreamById.get(id)?.message)
    .filter((msg): msg is Record<string, unknown> => Boolean(msg));
}

export function flushToolStreamSync(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
  syncToolStreamMessages(host);
}

export function scheduleToolStreamSync(host: ToolStreamHost, force = false) {
  if (force) {
    flushToolStreamSync(host);
    return;
  }
  if (host.toolStreamSyncTimer != null) {
    return;
  }
  host.toolStreamSyncTimer = window.setTimeout(
    () => flushToolStreamSync(host),
    TOOL_STREAM_THROTTLE_MS,
  );
}

export function resetToolStream(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
  host.toolStreamById.clear();
  host.toolStreamOrder = [];
  host.chatToolMessages = [];
  host.chatStreamSegments = [];
}

export type CompactionStatus = {
  phase: "active" | "retrying" | "complete";
  runId: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

export type FallbackStatus = {
  phase?: "active" | "cleared";
  selected: string;
  active: string;
  previous?: string;
  reason?: string;
  attempts: string[];
  occurredAt: number;
};

type CompactionHost = ToolStreamHost & {
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
};

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;

function clearCompactionTimer(host: CompactionHost) {
  if (host.compactionClearTimer != null) {
    window.clearTimeout(host.compactionClearTimer);
    host.compactionClearTimer = null;
  }
}

function scheduleCompactionClear(host: CompactionHost) {
  host.compactionClearTimer = window.setTimeout(() => {
    host.compactionStatus = null;
    host.compactionClearTimer = null;
  }, COMPACTION_TOAST_DURATION_MS);
}

function setCompactionComplete(host: CompactionHost, runId: string) {
  host.compactionStatus = {
    phase: "complete",
    runId,
    startedAt: host.compactionStatus?.startedAt ?? null,
    completedAt: Date.now(),
  };
  scheduleCompactionClear(host);
}

export function handleCompactionEvent(host: CompactionHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = typeof data.phase === "string" ? data.phase : "";
  const completed = data.completed === true;

  clearCompactionTimer(host);

  if (phase === "start") {
    host.compactionStatus = {
      phase: "active",
      runId: payload.runId,
      startedAt: Date.now(),
      completedAt: null,
    };
    return;
  }
  if (phase === "end") {
    if (data.willRetry === true && completed) {
      // Compaction already succeeded, but the run is still retrying.
      // Keep that distinct state until the matching lifecycle end arrives.
      host.compactionStatus = {
        phase: "retrying",
        runId: payload.runId,
        startedAt: host.compactionStatus?.startedAt ?? Date.now(),
        completedAt: null,
      };
      return;
    }
    if (completed) {
      setCompactionComplete(host, payload.runId);
      return;
    }
    host.compactionStatus = null;
  }
}

function handleLifecycleCompactionEvent(host: CompactionHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = toTrimmedString(data.phase);
  if (phase !== "end" && phase !== "error") {
    return;
  }

  // We scope lifecycle cleanup to the visible chat session first, then
  // use runId only to match the specific compaction retry we started tracking.
  const accepted = resolveAcceptedSession(host, payload, { allowSessionScopedWhenIdle: true });
  if (!accepted.accepted) {
    return;
  }
  if (host.compactionStatus?.phase !== "retrying") {
    return;
  }
  if (host.compactionStatus.runId && host.compactionStatus.runId !== payload.runId) {
    return;
  }

  setCompactionComplete(host, payload.runId);
}

function resolveAcceptedSession(
  host: ToolStreamHost,
  payload: AgentEventPayload,
  options?: {
    allowSessionScopedWhenIdle?: boolean;
  },
): { accepted: boolean; sessionKey?: string } {
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && sessionKey !== host.sessionKey) {
    return { accepted: false };
  }
  if (!host.chatRunId && options?.allowSessionScopedWhenIdle && sessionKey) {
    return { accepted: true, sessionKey };
  }
  // Fallback: only accept session-less events for the active run.
  if (!sessionKey && host.chatRunId && payload.runId !== host.chatRunId) {
    return { accepted: false };
  }
  if (host.chatRunId && payload.runId !== host.chatRunId) {
    return { accepted: false };
  }
  if (!host.chatRunId) {
    return { accepted: false };
  }
  return { accepted: true, sessionKey };
}

function handleLifecycleFallbackEvent(host: CompactionHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = payload.stream === "fallback" ? "fallback" : toTrimmedString(data.phase);
  if (payload.stream === "lifecycle" && phase !== "fallback" && phase !== "fallback_cleared") {
    return;
  }

  const accepted = resolveAcceptedSession(host, payload, { allowSessionScopedWhenIdle: true });
  if (!accepted.accepted) {
    return;
  }

  const selected =
    resolveModelLabel(data.selectedProvider, data.selectedModel) ??
    resolveModelLabel(data.fromProvider, data.fromModel);
  const active =
    resolveModelLabel(data.activeProvider, data.activeModel) ??
    resolveModelLabel(data.toProvider, data.toModel);
  const previous =
    resolveModelLabel(data.previousActiveProvider, data.previousActiveModel) ??
    toTrimmedString(data.previousActiveModel);
  if (!selected || !active) {
    return;
  }
  if (phase === "fallback" && selected === active) {
    return;
  }

  const reason = toTrimmedString(data.reasonSummary) ?? toTrimmedString(data.reason);
  const attempts = (() => {
    const summaries = parseFallbackAttemptSummaries(data.attemptSummaries);
    if (summaries.length > 0) {
      return summaries;
    }
    return parseFallbackAttempts(data.attempts).map((attempt) => {
      const modelRef = resolveModelLabel(attempt.provider, attempt.model);
      return `${modelRef ?? `${attempt.provider}/${attempt.model}`}: ${attempt.reason}`;
    });
  })();

  if (host.fallbackClearTimer != null) {
    window.clearTimeout(host.fallbackClearTimer);
    host.fallbackClearTimer = null;
  }
  host.fallbackStatus = {
    phase: phase === "fallback_cleared" ? "cleared" : "active",
    selected,
    active: phase === "fallback_cleared" ? selected : active,
    previous:
      phase === "fallback_cleared"
        ? (previous ?? (active !== selected ? active : undefined))
        : undefined,
    reason: reason ?? undefined,
    attempts,
    occurredAt: Date.now(),
  };
  host.fallbackClearTimer = window.setTimeout(() => {
    host.fallbackStatus = null;
    host.fallbackClearTimer = null;
  }, FALLBACK_TOAST_DURATION_MS);
}

/**
 * PR-8 / #67721: plan approval request emitted from the runtime when
 * the agent calls `exit_plan_mode`. Stored on the host so the chat
 * view can render an Approve/Reject/Edit overlay tied to the active
 * session.
 */
export type PlanApprovalRequest = {
  approvalId: string;
  sessionKey: string;
  toolCallId?: string;
  title: string;
  summary?: string;
  plan: Array<{ step: string; status: string; activeForm?: string }>;
  receivedAt: number;
  // PR-10 plan-archetype fields. All optional and additive — the
  // approval card / sidebar render them when present.
  analysis?: string;
  assumptions?: string[];
  risks?: Array<{ risk: string; mitigation: string }>;
  verification?: string[];
  references?: string[];
  /**
   * PR-10 AskUserQuestion: when present, this approval is a question
   * (not a plan submission). The plan-approval card renders a question
   * prompt + one button per option instead of the standard
   * Approve/Revise/Reject triad.
   */
  question?: {
    prompt: string;
    options: string[];
    allowFreetext?: boolean;
    questionId?: string;
  };
};

type PlanApprovalHost = ToolStreamHost & {
  planApprovalRequest: PlanApprovalRequest | null;
  /**
   * Optional auto-open hook — when the runtime emits a fresh plan
   * approval, also pop the full plan into the right sidebar so the
   * user doesn't have to click "Open plan" first.
   */
  openPlanInSidebar?: (request: PlanApprovalRequest) => void;
  /**
   * Optional live-plan hook — fires every time the agent calls
   * update_plan. The host re-renders the sidebar content with the
   * current plan state so the user always sees the latest checklist
   * (boxes ticking off as the agent steps through after approval).
   */
  refreshLivePlanSidebar?: (plan: PlanApprovalRequest["plan"], summary?: string) => void;
};

/**
 * Detect update_plan tool calls in the live tool-event stream and
 * emit the parsed plan steps. We listen on the start phase (when
 * args are present) since that's when the plan payload is freshest.
 */
function maybeForwardLivePlanUpdate(host: PlanApprovalHost, payload: AgentEventPayload): void {
  const data = payload.data ?? {};
  if (data.name !== "update_plan") {
    return;
  }
  if (data.phase !== "start" && data.phase !== "result") {
    return;
  }
  const args = (data.args ?? data.params) as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") {
    return;
  }
  const rawPlan = (args as { plan?: unknown }).plan;
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    return;
  }
  const plan: PlanApprovalRequest["plan"] = [];
  for (const entry of rawPlan) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const step = (entry as Record<string, unknown>).step;
    const status = (entry as Record<string, unknown>).status;
    const activeForm = (entry as Record<string, unknown>).activeForm;
    if (typeof step !== "string" || typeof status !== "string") {
      continue;
    }
    plan.push({
      step,
      status,
      ...(typeof activeForm === "string" && activeForm.trim() ? { activeForm } : {}),
    });
  }
  if (plan.length === 0) {
    return;
  }
  try {
    host.refreshLivePlanSidebar?.(plan, undefined);
  } catch {
    // ignore — sidebar refresh is best-effort
  }
}

function handlePlanApprovalEvent(host: PlanApprovalHost, payload: AgentEventPayload): void {
  const data = payload.data ?? {};
  if (data.kind !== "plugin" || data.phase !== "requested") {
    return;
  }
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (!sessionKey || sessionKey !== host.sessionKey) {
    return;
  }
  // PR-10 AskUserQuestion: question approvals carry `question` but
  // emit with `plan: []` (questions don't have plan steps). Detect this
  // BEFORE the plan-empty early-return so the question card renders.
  // Without this guard, both ask_user_question and the future
  // mode-state-transition events would be dropped silently.
  const isQuestionEvent = data.question != null && typeof data.question === "object";
  const rawPlan = data.plan;
  if (!isQuestionEvent && (!Array.isArray(rawPlan) || rawPlan.length === 0)) {
    return;
  }
  const plan: PlanApprovalRequest["plan"] = [];
  if (Array.isArray(rawPlan)) {
    for (const entry of rawPlan) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const step = (entry as Record<string, unknown>).step;
      const status = (entry as Record<string, unknown>).status;
      const activeForm = (entry as Record<string, unknown>).activeForm;
      if (typeof step !== "string" || typeof status !== "string") {
        continue;
      }
      plan.push({
        step,
        status,
        ...(typeof activeForm === "string" && activeForm.trim() ? { activeForm } : {}),
      });
    }
  }
  // For non-question events, an empty parsed plan still means "drop
  // the event" — a malformed step list is worse than no card. Question
  // events bypass this gate (their plan IS expected to be empty).
  if (!isQuestionEvent && plan.length === 0) {
    return;
  }
  const approvalId =
    typeof data.approvalId === "string" && data.approvalId.trim() ? data.approvalId : "";
  if (!approvalId) {
    return;
  }
  const title = typeof data.title === "string" && data.title.trim() ? data.title : "Plan approval";
  const summary =
    typeof data.summary === "string" && data.summary.trim() ? data.summary : undefined;
  const toolCallId =
    typeof data.toolCallId === "string" && data.toolCallId.trim() ? data.toolCallId : undefined;
  // PR-10 archetype fields. Defensive-parsed (drop blanks).
  const cleanStrArr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) {
      return undefined;
    }
    const c = v
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
    return c.length > 0 ? c : undefined;
  };
  const analysis =
    typeof data.analysis === "string" && data.analysis.trim() ? data.analysis.trim() : undefined;
  const assumptions = cleanStrArr(data.assumptions);
  const verification = cleanStrArr(data.verification);
  const references = cleanStrArr(data.references);
  let risks: PlanApprovalRequest["risks"];
  if (Array.isArray(data.risks)) {
    const c: NonNullable<PlanApprovalRequest["risks"]> = [];
    for (const e of data.risks) {
      if (!e || typeof e !== "object") {
        continue;
      }
      const r = (e as Record<string, unknown>).risk;
      const m = (e as Record<string, unknown>).mitigation;
      if (typeof r === "string" && typeof m === "string" && r.trim() && m.trim()) {
        c.push({ risk: r.trim(), mitigation: m.trim() });
      }
    }
    if (c.length > 0) {
      risks = c;
    }
  }
  // PR-10 AskUserQuestion: if data.question is present, this approval
  // is a clarifying question (not a plan submission). The card UI
  // detects question and renders one button per option instead of
  // the standard Approve/Revise/Reject triad.
  let question: PlanApprovalRequest["question"];
  if (data.question && typeof data.question === "object") {
    const q = data.question as Record<string, unknown>;
    const promptText = typeof q.prompt === "string" ? q.prompt.trim() : "";
    const opts = cleanStrArr(q.options);
    if (promptText && opts && opts.length > 0) {
      question = {
        prompt: promptText,
        options: opts,
        ...(typeof q.allowFreetext === "boolean" ? { allowFreetext: q.allowFreetext } : {}),
        ...(typeof q.questionId === "string" && q.questionId.trim()
          ? { questionId: q.questionId.trim() }
          : {}),
      };
    }
  }
  const next: PlanApprovalRequest = {
    approvalId,
    sessionKey,
    title,
    plan,
    receivedAt: Date.now(),
    ...(summary ? { summary } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(analysis ? { analysis } : {}),
    ...(assumptions ? { assumptions } : {}),
    ...(risks ? { risks } : {}),
    ...(verification ? { verification } : {}),
    ...(references ? { references } : {}),
    ...(question ? { question } : {}),
  };
  host.planApprovalRequest = next;
  // Auto-open the full plan in the right sidebar so the user can read
  // it without clicking "Open plan" first. The card itself surfaces
  // Accept/Edit/Reject; the sidebar shows the full markdown.
  //
  // PR-10 deep-dive review: skip the auto-open for question events
  // (request.question present) — there's no plan to render, and
  // popping an empty sidebar with just a header is a confusing UX.
  if (!isQuestionEvent) {
    try {
      host.openPlanInSidebar?.(next);
    } catch {
      // ignore — sidebar open is a best-effort affordance
    }
  }
}

export function handleAgentEvent(host: ToolStreamHost, payload?: AgentEventPayload) {
  if (!payload) {
    return;
  }

  // Handle compaction events
  if (payload.stream === "compaction") {
    handleCompactionEvent(host as CompactionHost, payload);
    return;
  }

  if (payload.stream === "lifecycle") {
    handleLifecycleCompactionEvent(host as CompactionHost, payload);
    handleLifecycleFallbackEvent(host as CompactionHost, payload);
    return;
  }

  if (payload.stream === "fallback") {
    handleLifecycleFallbackEvent(host as CompactionHost, payload);
    return;
  }

  if (payload.stream === "approval") {
    handlePlanApprovalEvent(host as PlanApprovalHost, payload);
    return;
  }

  if (payload.stream !== "tool") {
    return;
  }

  // Filter by session only. Don't check chatRunId because the client sets it
  // to a client-generated UUID (via generateUUID in sendChatMessage), while
  // tool events arrive with the server's engine runId — they can never match.
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && sessionKey !== host.sessionKey) {
    return;
  }

  // PR-8 follow-up: forward live update_plan calls to the sidebar
  // refresh hook so the user always sees the current plan state
  // (boxes ticking off as the agent steps through after approval).
  // Runs alongside the normal tool-stream path; doesn't replace it.
  maybeForwardLivePlanUpdate(host as PlanApprovalHost, payload);

  const data = payload.data ?? {};
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
  if (!toolCallId) {
    return;
  }
  const name = typeof data.name === "string" ? data.name : "tool";
  const phase = typeof data.phase === "string" ? data.phase : "";
  const args = phase === "start" ? data.args : undefined;
  const output =
    phase === "update"
      ? formatToolOutput(data.partialResult)
      : phase === "result"
        ? formatToolOutput(data.result)
        : undefined;

  const now = Date.now();
  let entry = host.toolStreamById.get(toolCallId);
  if (!entry) {
    // Commit any in-progress streaming text as a segment so it renders
    // above the tool card instead of below it.
    if (host.chatStream && host.chatStream.trim().length > 0) {
      host.chatStreamSegments = [...host.chatStreamSegments, { text: host.chatStream, ts: now }];
      host.chatStream = null;
      host.chatStreamStartedAt = null;
    }
    entry = {
      toolCallId,
      runId: payload.runId,
      sessionKey,
      name,
      args,
      output: output || undefined,
      startedAt: typeof payload.ts === "number" ? payload.ts : now,
      updatedAt: now,
      message: {},
    };
    host.toolStreamById.set(toolCallId, entry);
    host.toolStreamOrder.push(toolCallId);
  } else {
    entry.name = name;
    if (args !== undefined) {
      entry.args = args;
    }
    if (output !== undefined) {
      entry.output = output || undefined;
    }
    entry.updatedAt = now;
  }

  entry.message = buildToolStreamMessage(entry);
  trimToolStream(host);
  scheduleToolStreamSync(host, phase === "result");
}
