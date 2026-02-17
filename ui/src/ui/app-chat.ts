import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { scheduleChatScroll } from "./app-scroll.ts";
import { setLastActiveSessionKey } from "./app-settings.ts";
import { resetToolStream } from "./app-tool-stream.ts";
import type { OpenClawApp } from "./app.ts";
import { abortChatRun, loadChatHistory, sendChatMessage } from "./controllers/chat.ts";
import { loadSessions } from "./controllers/sessions.ts";
import type { GatewayHelloOk } from "./gateway.ts";
import { normalizeBasePath } from "./navigation.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";

export type ChatHost = {
  connected: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  sessionKey: string;
  basePath: string;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
  refreshSessionsAfterChat: Set<string>;
};

export const CHAT_SESSIONS_ACTIVE_MINUTES = 120;

export type SubagentCleanupMode = "keep" | "delete";
export type AgenticTemplateId =
  | "researcher"
  | "coder"
  | "reviewer"
  | "bug-triager"
  | "reproducer"
  | "test-builder"
  | "profiler"
  | "security-researcher";

export const AGENTIC_TEMPLATE_OPTIONS: Array<{ id: AgenticTemplateId; label: string }> = [
  { id: "researcher", label: "Researcher" },
  { id: "coder", label: "Coder" },
  { id: "reviewer", label: "Reviewer" },
  { id: "bug-triager", label: "Bug Triager" },
  { id: "reproducer", label: "Reproducer" },
  { id: "test-builder", label: "Test Builder" },
  { id: "profiler", label: "Profiler" },
  { id: "security-researcher", label: "Security Researcher" },
];

export type AgenticWorkflowId =
  | "research-code-review"
  | "bug-triage"
  | "refactor-safety"
  | "test-gap"
  | "performance-optimization"
  | "security-patch";

type AgenticWorkflowStep = {
  template: AgenticTemplateId;
  labelSuffix: string;
  task: (goal: string) => string;
};

type AgenticWorkflowDefinition = {
  id: AgenticWorkflowId;
  label: string;
  steps: AgenticWorkflowStep[];
};

const AGENTIC_WORKFLOW_DEFINITIONS: AgenticWorkflowDefinition[] = [
  {
    id: "research-code-review",
    label: "Research -> Code -> Review",
    steps: [
      {
        template: "researcher",
        labelSuffix: "research",
        task: (goal) =>
          `Investigate the goal, gather evidence, list risks/tradeoffs, and produce a concise implementation plan with citations. Goal: ${goal}`,
      },
      {
        template: "coder",
        labelSuffix: "code",
        task: (goal) =>
          `Using Step 1 findings, implement the best approach for the goal and run targeted validation. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "review",
        task: (goal) =>
          `Review Step 2 result for bugs/regressions/test gaps and return prioritized findings with severity. Goal: ${goal}`,
      },
    ],
  },
  {
    id: "bug-triage",
    label: "Bug Triage Flow",
    steps: [
      {
        template: "bug-triager",
        labelSuffix: "triage",
        task: (goal) =>
          `Triage this bug report, define impact and likely root causes, and propose the fastest safe fix strategy. Goal: ${goal}`,
      },
      {
        template: "reproducer",
        labelSuffix: "repro",
        task: (goal) =>
          `Create deterministic reproduction steps and, if possible, a minimal failing test for the bug. Goal: ${goal}`,
      },
      {
        template: "coder",
        labelSuffix: "fix",
        task: (goal) =>
          `Implement the smallest correct fix using triage + repro evidence, then run focused validation. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "verify",
        task: (goal) =>
          `Verify fix quality, regression risk, and test coverage; return prioritized findings. Goal: ${goal}`,
      },
    ],
  },
  {
    id: "refactor-safety",
    label: "Refactor Safety Flow",
    steps: [
      {
        template: "researcher",
        labelSuffix: "scope",
        task: (goal) =>
          `Map current behavior/contracts and identify refactor safety constraints and edge cases. Goal: ${goal}`,
      },
      {
        template: "coder",
        labelSuffix: "refactor",
        task: (goal) =>
          `Perform the refactor with minimal behavioral change and clear commit-ready diffs. Goal: ${goal}`,
      },
      {
        template: "test-builder",
        labelSuffix: "tests",
        task: (goal) =>
          `Add or improve regression tests that lock in pre-refactor behavior. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "review",
        task: (goal) =>
          `Review refactor + tests for hidden regressions, missing coverage, and maintainability risks. Goal: ${goal}`,
      },
    ],
  },
  {
    id: "test-gap",
    label: "Test Gap Flow",
    steps: [
      {
        template: "researcher",
        labelSuffix: "analysis",
        task: (goal) =>
          `Analyze the target area and list the highest-risk behaviors not currently covered by tests. Goal: ${goal}`,
      },
      {
        template: "test-builder",
        labelSuffix: "tests",
        task: (goal) =>
          `Implement focused tests for the identified gaps and keep them deterministic. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "verify",
        task: (goal) =>
          `Review new tests for relevance, flakiness risk, and missing edge cases. Goal: ${goal}`,
      },
    ],
  },
  {
    id: "performance-optimization",
    label: "Performance Optimization Flow",
    steps: [
      {
        template: "profiler",
        labelSuffix: "profile",
        task: (goal) =>
          `Profile the target path, identify bottlenecks, and provide baseline metrics. Goal: ${goal}`,
      },
      {
        template: "coder",
        labelSuffix: "optimize",
        task: (goal) =>
          `Implement the most impactful low-risk optimizations and run benchmark checks. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "review",
        task: (goal) =>
          `Review optimization changes for correctness tradeoffs, regressions, and measurement quality. Goal: ${goal}`,
      },
    ],
  },
  {
    id: "security-patch",
    label: "Security Patch Flow",
    steps: [
      {
        template: "security-researcher",
        labelSuffix: "security",
        task: (goal) =>
          `Perform threat-focused analysis, identify exploitable paths, and prioritize remediation. Goal: ${goal}`,
      },
      {
        template: "coder",
        labelSuffix: "patch",
        task: (goal) =>
          `Implement the highest-priority security remediation with minimal blast radius and targeted validation. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "review",
        task: (goal) =>
          `Review the patch for security completeness, regressions, and remaining residual risk. Goal: ${goal}`,
      },
    ],
  },
];

export const AGENTIC_WORKFLOW_OPTIONS: Array<{ id: AgenticWorkflowId; label: string }> =
  AGENTIC_WORKFLOW_DEFINITIONS.map((flow) => ({ id: flow.id, label: flow.label }));

export type SubagentSpawnDraft = {
  task: string;
  templateId?: AgenticTemplateId;
  label?: string;
  agentId?: string;
  runTimeoutSeconds?: string | number;
  cleanup?: SubagentCleanupMode;
};

function normalizeRunTimeoutSeconds(raw: string | number | undefined): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.floor(parsed));
}

export function buildSubagentSpawnPrompt(draft: SubagentSpawnDraft): string {
  const task = draft.task.trim();
  if (!task) {
    return "";
  }

  const args: Record<string, unknown> = { task };
  const templateId = draft.templateId?.trim();
  if (templateId) {
    args.template = templateId;
  }
  const label = draft.label?.trim();
  if (label) {
    args.label = label;
  }
  const agentId = draft.agentId?.trim();
  if (agentId) {
    args.agentId = agentId;
  }
  const runTimeoutSeconds = normalizeRunTimeoutSeconds(draft.runTimeoutSeconds);
  if (runTimeoutSeconds !== null) {
    args.runTimeoutSeconds = runTimeoutSeconds;
  }
  if (draft.cleanup === "delete") {
    args.cleanup = "delete";
  }

  return [
    "Run the `sessions_spawn` tool now with exactly these arguments:",
    "```json",
    JSON.stringify(args, null, 2),
    "```",
    "Then reply with one short confirmation that includes `runId` and `childSessionKey`.",
  ].join("\n");
}

export type AgenticWorkflowDraft = {
  goal: string;
  workflowId?: AgenticWorkflowId;
  label?: string;
  agentId?: string;
  runTimeoutSeconds?: string | number;
  cleanup?: SubagentCleanupMode;
};

export function resolveAgenticWorkflowDefinition(raw: unknown): AgenticWorkflowDefinition {
  const normalized = typeof raw === "string" ? raw.trim() : "";
  return (
    AGENTIC_WORKFLOW_DEFINITIONS.find((entry) => entry.id === normalized) ??
    AGENTIC_WORKFLOW_DEFINITIONS[0]
  );
}

export function buildAgenticEngineeringWorkflowPrompt(draft: AgenticWorkflowDraft): string {
  const goal = draft.goal.trim();
  if (!goal) {
    return "";
  }
  const suffixParts: string[] = [];
  const runTimeoutSeconds = normalizeRunTimeoutSeconds(draft.runTimeoutSeconds);
  if (runTimeoutSeconds !== null) {
    suffixParts.push(`runTimeoutSeconds: ${runTimeoutSeconds}`);
  }
  if (draft.cleanup === "delete") {
    suffixParts.push(`cleanup: "delete"`);
  }
  const agentId = draft.agentId?.trim();
  if (agentId) {
    suffixParts.push(`agentId: "${agentId}"`);
  }
  const label = draft.label?.trim();
  const suffix = suffixParts.length > 0 ? ` plus ${suffixParts.join(", ")}` : "";
  const workflow = resolveAgenticWorkflowDefinition(draft.workflowId);
  const baseLabel = label ? `${label}-` : `${workflow.id}-`;
  const lines = [
    `Run the "${workflow.label}" Agentic Engineering workflow by calling \`sessions_spawn\` exactly ${workflow.steps.length} times in order.`,
    "Wait for each run to complete before starting the next one, and carry outputs forward.",
    "",
    `Goal: ${goal}`,
    "",
  ];

  workflow.steps.forEach((step, index) => {
    const stepNumber = index + 1;
    lines.push(`Step ${stepNumber} template: ${step.template}`);
    lines.push(`Step ${stepNumber} task: ${step.task(goal)}`);
    lines.push(`Step ${stepNumber} args extras: label: "${baseLabel}${step.labelSuffix}"${suffix}`);
    lines.push("");
  });

  lines.push("After all steps complete, reply with:");
  lines.push("1) runId + childSessionKey for each step");
  lines.push("2) final recommendation in 3-6 bullets");
  return lines.join("\n");
}

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/stop") {
    return true;
  }
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

function isChatResetCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/new" || normalized === "/reset") {
    return true;
  }
  return normalized.startsWith("/new ") || normalized.startsWith("/reset ");
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.connected) {
    return;
  }
  host.chatMessage = "";
  await abortChatRun(host as unknown as OpenClawApp);
}

function enqueueChatMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      attachments: hasAttachments ? attachments?.map((att) => ({ ...att })) : undefined,
      refreshSessions,
    },
  ];
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
  },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  const runId = await sendChatMessage(host as unknown as OpenClawApp, message, opts?.attachments);
  const ok = Boolean(runId);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
  }
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (ok && opts?.restoreAttachments && opts.previousAttachments?.length) {
    host.chatAttachments = opts.previousAttachments;
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  if (ok && !host.chatRunId) {
    void flushChatQueue(host);
  }
  if (ok && opts?.refreshSessions && runId) {
    host.refreshSessionsAfterChat.add(runId);
  }
  return ok;
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) {
    return;
  }
  const [next, ...rest] = host.chatQueue;
  if (!next) {
    return;
  }
  host.chatQueue = rest;
  const ok = await sendChatMessageNow(host, next.text, {
    attachments: next.attachments,
    refreshSessions: next.refreshSessions,
  });
  if (!ok) {
    host.chatQueue = [next, ...host.chatQueue];
  }
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: { restoreDraft?: boolean },
) {
  if (!host.connected) {
    return;
  }
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? attachments : [];
  const hasAttachments = attachmentsToSend.length > 0;

  // Allow sending with just attachments (no message text required)
  if (!message && !hasAttachments) {
    return;
  }

  if (isChatStopCommand(message)) {
    await handleAbortChat(host);
    return;
  }

  const refreshSessions = isChatResetCommand(message);
  if (messageOverride == null) {
    host.chatMessage = "";
    // Clear attachments when sending
    host.chatAttachments = [];
  }

  if (isChatBusy(host)) {
    enqueueChatMessage(host, message, attachmentsToSend, refreshSessions);
    return;
  }

  await sendChatMessageNow(host, message, {
    previousDraft: messageOverride == null ? previousDraft : undefined,
    restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    attachments: hasAttachments ? attachmentsToSend : undefined,
    previousAttachments: messageOverride == null ? attachments : undefined,
    restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
    refreshSessions,
  });
}

export async function refreshChat(host: ChatHost, opts?: { scheduleScroll?: boolean }) {
  await Promise.all([
    loadChatHistory(host as unknown as OpenClawApp),
    loadSessions(host as unknown as OpenClawApp, {
      activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
    }),
    refreshChatAvatar(host),
  ]);
  if (opts?.scheduleScroll !== false) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
}

export const flushChatQueueForEvent = flushChatQueue;

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

export async function refreshChatAvatar(host: ChatHost) {
  if (!host.connected) {
    host.chatAvatarUrl = null;
    return;
  }
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    host.chatAvatarUrl = null;
    return;
  }
  host.chatAvatarUrl = null;
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      host.chatAvatarUrl = null;
      return;
    }
    const data = (await res.json()) as { avatarUrl?: unknown };
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    host.chatAvatarUrl = avatarUrl || null;
  } catch {
    host.chatAvatarUrl = null;
  }
}
