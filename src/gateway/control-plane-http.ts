import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  ensureAgentWorkspace,
} from "../agents/workspace.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import {
  loadControlPlaneRuntimeState,
  mergeControlPlaneRuntimeState,
} from "./control-plane-runtime.js";
import type {
  ControlPlaneConversationView,
  ControlPlaneRuntimeAgent,
  ControlPlaneRuntimeRole,
} from "./control-plane-runtime.js";
import {
  getGlobalExecApprovalBroadcast,
  getGlobalExecApprovalForwarder,
  getGlobalExecApprovalManager,
} from "./exec-approval-context.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.js";
import { setSseHeaders, writeDone } from "./http-common.js";
import { resolveSessionStoreKey } from "./session-utils.js";

// AGENT_BOT_COMPAT: HTTP bridge used by agent-bot-task-a control-plane.

type JsonObject = Record<string, unknown>;
type PortalSessionMode = "chat" | "training";
type PortalCoreWriteMode = "candidate-core" | "forbidden";
type PortalMemoryWriteMode = "candidate-core" | "user-memory";
type PortalCandidateRiskLevel = "low" | "medium" | "high";

type PortalCandidateChange = {
  kind: string;
  title: string;
  summary: string;
  currentValue: string | null;
  proposedValue: string | null;
  diffText: string | null;
  riskLevel: PortalCandidateRiskLevel;
  metadata: JsonObject;
};

type PortalApprovalSummary = {
  id: string;
  kind: "exec";
  command: string;
  host?: string;
  cwd?: string;
  expiresAt?: string;
};

type PortalWritePolicy = {
  core: PortalCoreWriteMode;
  memory: PortalMemoryWriteMode;
};

/** Stable wire shape for agent-bot control-plane → RuntimeEventRecord ingestion */
type PortalRuntimeEventWire = {
  eventType: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  payload?: JsonObject;
  createdAt: string;
};

function buildPortalRuntimeEvent(params: {
  eventType: string;
  level: PortalRuntimeEventWire["level"];
  message: string;
  payload?: JsonObject;
  createdAt?: string;
}): PortalRuntimeEventWire {
  return {
    eventType: params.eventType,
    level: params.level,
    message: params.message,
    ...(params.payload ? { payload: params.payload } : {}),
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}

function isSseRequest(req: IncomingMessage): boolean {
  return String(req.headers.accept ?? "")
    .toLowerCase()
    .includes("text/event-stream");
}

function writePortalStreamEvent(res: ServerResponse, type: string, data: unknown): void {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
}

function buildPortalRuntimeEventFromAgentEvent(
  evt: AgentEventPayload,
): PortalRuntimeEventWire | null {
  const createdAt = new Date(evt.ts).toISOString();
  if (evt.stream === "tool") {
    const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
    const toolName = typeof evt.data?.name === "string" ? evt.data.name : "tool";
    const toolCallId = typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId : undefined;
    if (phase === "start") {
      return buildPortalRuntimeEvent({
        eventType: "tool.started",
        level: "info",
        message: `工具 ${toolName} 开始执行`,
        payload: {
          runId: evt.runId,
          stream: evt.stream,
          phase,
          name: toolName,
          toolCallId: toolCallId ?? null,
          seq: evt.seq,
          ts: evt.ts,
        },
        createdAt,
      });
    }
    if (phase === "result") {
      const isError = Boolean(evt.data?.isError);
      return buildPortalRuntimeEvent({
        eventType: isError ? "tool.failed" : "tool.completed",
        level: isError ? "error" : "info",
        message: isError ? `工具 ${toolName} 执行失败` : `工具 ${toolName} 执行完成`,
        payload: {
          runId: evt.runId,
          stream: evt.stream,
          phase,
          name: toolName,
          toolCallId: toolCallId ?? null,
          isError,
          meta:
            evt.data?.meta && typeof evt.data.meta === "object" && !Array.isArray(evt.data.meta)
              ? evt.data.meta
              : undefined,
          seq: evt.seq,
          ts: evt.ts,
        },
        createdAt,
      });
    }
    return null;
  }
  if (evt.stream === "lifecycle") {
    const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
    if (!phase) {
      return null;
    }
    const level = phase === "error" ? "error" : "info";
    return buildPortalRuntimeEvent({
      eventType: `lifecycle.${phase}`,
      level,
      message:
        phase === "start"
          ? "Agent 运行已开始"
          : phase === "end"
            ? "Agent 运行已结束"
            : typeof evt.data?.error === "string" && evt.data.error
              ? evt.data.error
              : "Agent 运行失败",
      payload: {
        runId: evt.runId,
        stream: evt.stream,
        phase,
        error: typeof evt.data?.error === "string" ? evt.data.error : null,
        stopReason: typeof evt.data?.stopReason === "string" ? evt.data.stopReason : null,
        seq: evt.seq,
        ts: evt.ts,
      },
      createdAt,
    });
  }
  if (evt.stream === "error") {
    return buildPortalRuntimeEvent({
      eventType: "stream.error",
      level: "error",
      message:
        typeof evt.data?.reason === "string" && evt.data.reason
          ? `事件流异常：${evt.data.reason}`
          : "事件流异常",
      payload: {
        runId: evt.runId,
        stream: evt.stream,
        seq: evt.seq,
        ts: evt.ts,
        ...evt.data,
      },
      createdAt,
    });
  }
  return null;
}

type PortalSessionRecord = {
  remoteAgentId: string;
  agentId: string;
  sessionKey: string;
  sessionRevision: number;
  turnCount: number;
  historySummary?: string;
  portalSessionId?: string;
  mode: PortalSessionMode;
  conversationView: ControlPlaneConversationView;
  runtimeRole?: ControlPlaneRuntimeRole;
  sessionViews: ControlPlaneConversationView[];
  writePolicy: PortalWritePolicy;
  traceId?: string;
  userContext?: JsonObject;
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
  agentVersionId?: string;
  skillSnapshotId?: string;
  releaseId?: string;
  releaseVersion?: string;
  releaseStatus?: string;
};

type PortalRunTimelineItem = {
  phase: "started" | "requires_approval" | "completed" | "failed" | "approval_applied";
  at: string;
  error?: string;
};

type PortalUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type PortalRunRecord = {
  runId: string;
  remoteSessionId: string;
  portalSessionId?: string;
  traceId?: string;
  status: "started" | "requires_approval" | "completed" | "failed" | "approval_applied";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  reply?: string;
  usage?: PortalUsage;
  error?: {
    message: string;
    code?: string;
  };
  candidateChanges?: PortalCandidateChange[];
  timeline: PortalRunTimelineItem[];
};

type ReleaseDescriptor = {
  releaseId?: string;
  releaseVersion?: string;
  releaseStatus?: string;
  releaseManifest?: JsonObject;
  releaseFiles: Array<{ name: string; content: string }>;
};

const PREFIX = "/__control-plane";
const RELEASE_EXPORT_ROOT_FILES = [
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
] as const;
const DEFAULT_PINNED_MEMORY_FILENAME = "memory/pinned.md";
const EMPTY_PORTAL_REPLY = "No response from OpenClaw.";
const PORTAL_HISTORY_SUMMARY_MAX_CHARS = 2_400;
const PORTAL_USER_CONTEXT_MAX_CHARS = 600;
const PORTAL_SESSION_ROLLOVER_TURN_LIMIT = 6;
const PORTAL_SESSION_ROLLOVER_TOKEN_LIMIT = 24_000;

const portalSessions = new Map<string, PortalSessionRecord>();
const portalRuns = new Map<string, PortalRunRecord>();

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOptionalString(body: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readOptionalObject(body: JsonObject, ...keys: string[]): JsonObject | undefined {
  for (const key of keys) {
    const value = body[key];
    if (isJsonObject(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizePortalMode(value: unknown): PortalSessionMode {
  return typeof value === "string" && value.trim().toLowerCase() === "training"
    ? "training"
    : "chat";
}

function normalizeRuntimeRole(value: unknown): ControlPlaneRuntimeRole | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "training" || normalized === "serving" ? normalized : undefined;
}

function normalizeRemoteAgentId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeWorkspaceRelativePath(value: string): string | undefined {
  const trimmed = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (!trimmed || trimmed.includes("\0")) {
    return undefined;
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:\//.test(trimmed)) {
    return undefined;
  }
  const normalized = path.posix.normalize(trimmed);
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

function resolveConversationView(mode: PortalSessionMode): ControlPlaneConversationView {
  return mode === "training" ? "training" : "serving";
}

function buildSessionViews(runtimeRole?: ControlPlaneRuntimeRole): ControlPlaneConversationView[] {
  if (runtimeRole === "training") {
    return ["training"];
  }
  if (runtimeRole === "serving") {
    return ["serving"];
  }
  return ["training", "serving"];
}

function buildPortalWritePolicy(conversationView: ControlPlaneConversationView): PortalWritePolicy {
  if (conversationView === "training") {
    return {
      core: "candidate-core",
      memory: "candidate-core",
    };
  }
  return {
    core: "forbidden",
    memory: "user-memory",
  };
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function stringifyJson(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function buildPortalSessionKey(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  remoteSessionId: string;
  conversationView: ControlPlaneConversationView;
  revision?: number;
}): string {
  const revision =
    typeof params.revision === "number" && Number.isFinite(params.revision) && params.revision > 0
      ? `:r${Math.floor(params.revision)}`
      : "";
  return resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: `agent:${normalizeAgentId(params.agentId)}:portal:${params.conversationView}:${params.remoteSessionId.toLowerCase()}${revision}`,
  });
}

function resolvePortalTargetAgent(
  remoteAgentId: string,
  preferredConversationView?: ControlPlaneConversationView,
  preferredLocalAgentKey?: string,
):
  | {
      cfg: ReturnType<typeof loadConfig>;
      agentId: string;
      runtimeState: ReturnType<typeof loadControlPlaneRuntimeState>;
      runtimeAgent?: ControlPlaneRuntimeAgent;
    }
  | undefined {
  const cfg = loadConfig();
  const configuredAgentIds = new Set(listAgentIds(cfg).map((agentId) => normalizeAgentId(agentId)));
  const runtimeState = loadControlPlaneRuntimeState();
  const normalizedRemoteAgentId = normalizeRemoteAgentId(remoteAgentId);

  const matchingAgents = (runtimeState.agents ?? []).filter(
    (entry) => normalizeRemoteAgentId(entry.remoteAgentId) === normalizedRemoteAgentId,
  );

  const preferredLocal = preferredLocalAgentKey ? normalizeAgentId(preferredLocalAgentKey) : "";
  const agentsForRemote = preferredLocal
    ? matchingAgents.filter((entry) => normalizeAgentId(entry.agentId) === preferredLocal)
    : matchingAgents;

  if (preferredLocal && matchingAgents.length > 0 && agentsForRemote.length === 0) {
    return undefined;
  }

  const pickRuntimeAgent = (): ControlPlaneRuntimeAgent | undefined => {
    const pool = agentsForRemote.length > 0 ? agentsForRemote : matchingAgents;
    if (pool.length === 0) {
      return undefined;
    }
    if (pool.length === 1) {
      return pool[0];
    }
    if (preferredConversationView) {
      const byView = pool.find((entry) =>
        (entry.sessionViews ?? buildSessionViews(entry.runtimeRole)).includes(
          preferredConversationView,
        ),
      );
      if (byView) {
        return byView;
      }
    }
    return pool[0];
  };

  const picked = pickRuntimeAgent();
  if (picked) {
    return {
      cfg,
      agentId: normalizeAgentId(picked.agentId),
      runtimeState,
      runtimeAgent: picked,
    };
  }

  if (preferredLocal) {
    return undefined;
  }

  const directAgentId = normalizeAgentId(remoteAgentId);
  if (configuredAgentIds.has(directAgentId)) {
    return { cfg, agentId: directAgentId, runtimeState };
  }

  if (normalizeRemoteAgentId(runtimeState.remoteAgentId) === normalizedRemoteAgentId) {
    return {
      cfg,
      agentId: resolveDefaultAgentId(cfg),
      runtimeState,
    };
  }

  return undefined;
}

function buildPortalExtraSystemPrompt(params: {
  remoteSessionId: string;
  session: PortalSessionRecord;
  traceId?: string;
  portalSessionId?: string;
}): string {
  const userContext = truncateText(
    stringifyJson(params.session.userContext),
    PORTAL_USER_CONTEXT_MAX_CHARS,
  );
  const lines = [
    "Portal control-plane session metadata (internal):",
    `- conversationView: ${params.session.conversationView}`,
    `- mode: ${params.session.mode}`,
    params.session.runtimeRole ? `- runtimeRole: ${params.session.runtimeRole}` : undefined,
    params.session.sessionRevision > 0
      ? `- sessionRevision: ${params.session.sessionRevision}`
      : undefined,
    `- writePolicy: core=${params.session.writePolicy.core}; memory=${params.session.writePolicy.memory}`,
    params.portalSessionId || params.session.portalSessionId
      ? `- portalSessionId: ${params.portalSessionId ?? params.session.portalSessionId}`
      : undefined,
    params.traceId || params.session.traceId
      ? `- traceId: ${params.traceId ?? params.session.traceId}`
      : undefined,
    `- remoteSessionId: ${params.remoteSessionId}`,
    params.session.agentVersionId
      ? `- agentVersionId: ${params.session.agentVersionId}`
      : undefined,
    params.session.skillSnapshotId
      ? `- skillSnapshotId: ${params.session.skillSnapshotId}`
      : undefined,
    params.session.releaseVersion
      ? `- releaseVersion: ${params.session.releaseVersion}`
      : undefined,
    params.session.releaseStatus ? `- releaseStatus: ${params.session.releaseStatus}` : undefined,
  ].filter((line): line is string => Boolean(line));

  if (userContext) {
    lines.push("", "## User Context", userContext);
  }
  if (params.session.historySummary) {
    lines.push("", "## Session Memory", params.session.historySummary);
  }
  if (params.session.conversationView === "training") {
    lines.push(
      "",
      "Training view is enabled. Candidate changes may be proposed as draft runtime state, but nothing is published until the control-plane explicitly approves and releases it.",
    );
  } else {
    lines.push(
      "",
      "Serving view is enabled. Never mutate published core instructions or release definitions from this conversation.",
    );
  }

  return lines.join("\n");
}

function resolvePortalReplyText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return EMPTY_PORTAL_REPLY;
  }
  const reply = payloads
    .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return reply || EMPTY_PORTAL_REPLY;
}

function extractPortalUsage(result: unknown): PortalUsage {
  const usage = ((result as { meta?: { agentMeta?: { usage?: unknown } } } | null)?.meta?.agentMeta
    ?.usage as
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined) ?? { total: 0 };
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const total = usage.total ?? input + output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return {
    inputTokens: Math.max(0, input),
    outputTokens: Math.max(0, output),
    totalTokens: Math.max(0, total),
  };
}

function inferCandidateRiskLevel(params: {
  message: string;
  reply: string;
  approval?: PortalApprovalSummary;
}): PortalCandidateRiskLevel {
  if (params.approval) {
    return "high";
  }
  const combined = `${params.message}\n${params.reply}`.toLowerCase();
  if (/(deploy|publish|release|exec|shell|command|delete|drop|shutdown|migrate)/.test(combined)) {
    return "high";
  }
  if (/(update|change|edit|modify|memory|policy|workflow|prompt|config)/.test(combined)) {
    return "medium";
  }
  return "low";
}

function buildCandidateDiff(
  currentValue: string | null,
  proposedValue: string | null,
): string | null {
  const parts: string[] = [];
  if (currentValue) {
    parts.push(`Current\n- ${currentValue}`);
  }
  if (proposedValue) {
    parts.push(`Proposed\n+ ${proposedValue}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function buildTrainingCandidateChanges(params: {
  session: PortalSessionRecord;
  message: string;
  reply: string;
  status: "completed" | "requires_approval";
  approval?: PortalApprovalSummary;
}): PortalCandidateChange[] | undefined {
  if (params.session.mode !== "training") {
    return undefined;
  }
  const currentValue = truncateText(params.message, 240) ?? null;
  const proposedValue =
    params.reply === EMPTY_PORTAL_REPLY ? null : (truncateText(params.reply, 320) ?? null);
  const changes: PortalCandidateChange[] = [
    {
      kind: "conversation-summary",
      title: "Training conversation summary",
      summary:
        params.status === "requires_approval"
          ? "Runtime paused the training flow because a command requires approval."
          : "Runtime generated a deterministic training summary from the portal exchange.",
      currentValue,
      proposedValue,
      diffText: buildCandidateDiff(currentValue, proposedValue),
      riskLevel: inferCandidateRiskLevel(params),
      metadata: {
        source: "control-plane-http",
        agentId: params.session.agentId,
        remoteAgentId: params.session.remoteAgentId,
        mode: params.session.mode,
        conversationView: params.session.conversationView,
        runtimeRole: params.session.runtimeRole ?? null,
        responseStatus: params.status,
      },
    },
  ];
  if (params.approval) {
    const approvalCommand = truncateText(params.approval.command, 240) ?? params.approval.command;
    changes.push({
      kind: "exec-approval",
      title: "Exec approval required",
      summary:
        "The runtime paused before executing a command requested during the training workflow.",
      currentValue: "Awaiting explicit control-plane approval.",
      proposedValue: approvalCommand,
      diffText: buildCandidateDiff("Awaiting explicit control-plane approval.", approvalCommand),
      riskLevel: "high",
      metadata: {
        source: "control-plane-http",
        approvalId: params.approval.id,
        approvalKind: params.approval.kind,
        host: params.approval.host ?? null,
        cwd: params.approval.cwd ?? null,
        expiresAt: params.approval.expiresAt ?? null,
      },
    });
  }
  return changes;
}

function appendPortalRunTimeline(
  existing: PortalRunRecord | undefined,
  item: PortalRunTimelineItem,
): PortalRunTimelineItem[] {
  return [...(existing?.timeline ?? []), item];
}

function savePortalRun(record: PortalRunRecord): PortalRunRecord {
  portalRuns.set(record.runId, record);
  return record;
}

function summarizePortalExchange(params: {
  message: string;
  reply: string;
  usage: PortalUsage;
}): string {
  const message = truncateText(params.message, 220) ?? "(empty)";
  const reply =
    params.reply === EMPTY_PORTAL_REPLY
      ? "No visible assistant reply."
      : (truncateText(params.reply, 320) ?? "No visible assistant reply.");
  return [
    `User: ${message}`,
    `Assistant: ${reply}`,
    `Usage: input=${params.usage.inputTokens}, output=${params.usage.outputTokens}, total=${params.usage.totalTokens}`,
  ].join("\n");
}

function appendHistorySummary(currentSummary: string | undefined, exchangeSummary: string): string {
  const merged = [currentSummary?.trim(), exchangeSummary.trim()].filter(Boolean).join("\n\n");
  if (merged.length <= PORTAL_HISTORY_SUMMARY_MAX_CHARS) {
    return merged;
  }
  return `...${merged.slice(-(PORTAL_HISTORY_SUMMARY_MAX_CHARS - 3)).trimStart()}`;
}

function shouldRolloverPortalSession(params: {
  session: PortalSessionRecord;
  usage: PortalUsage;
}): boolean {
  return (
    params.session.turnCount >= PORTAL_SESSION_ROLLOVER_TURN_LIMIT ||
    params.usage.totalTokens >= PORTAL_SESSION_ROLLOVER_TOKEN_LIMIT
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (!text) {
    return {};
  }
  const parsed = JSON.parse(text);
  return isJsonObject(parsed) ? parsed : {};
}

function authorizeBridge(req: IncomingMessage): boolean {
  const expected = process.env.OPENCLAW_BRIDGE_TOKEN?.trim();
  if (!expected) {
    return true;
  }
  const header = String(req.headers["x-openclaw-bridge-token"] ?? "").trim();
  return header === expected;
}

function ensureMethod(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: string | string[],
): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  const allowedList = Array.isArray(allowed) ? allowed : [allowed];
  if (allowedList.includes(method)) {
    return true;
  }
  res.statusCode = 405;
  res.setHeader("Allow", allowedList.join(", "));
  res.end("Method Not Allowed");
  return false;
}

function parseWorkspaceFilesFromValue(value: unknown): Array<{ name: string; content: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is { name?: unknown; content?: unknown } =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((item) => ({
      name: typeof item.name === "string" ? (normalizeWorkspaceRelativePath(item.name) ?? "") : "",
      content: typeof item.content === "string" ? item.content : "",
    }))
    .filter((item) => item.name && item.content);
}

function parseReleaseDescriptor(body: JsonObject): ReleaseDescriptor {
  const release = readOptionalObject(body, "release", "releaseBundle");
  const topLevelReleaseFiles = parseWorkspaceFilesFromValue(body.releaseFiles);
  const nestedReleaseFiles = parseWorkspaceFilesFromValue(release?.files);
  const artifacts = release ? readOptionalObject(release, "artifacts") : undefined;
  const artifactWorkspaceFiles = artifacts
    ? parseWorkspaceFilesFromValue(artifacts.workspaceFiles)
    : [];
  const releaseFiles =
    topLevelReleaseFiles.length > 0
      ? topLevelReleaseFiles
      : nestedReleaseFiles.length > 0
        ? nestedReleaseFiles
        : artifactWorkspaceFiles;
  return {
    releaseId:
      readOptionalString(body, "releaseId") ??
      (release ? readOptionalString(release, "releaseId", "id") : undefined),
    releaseVersion:
      readOptionalString(body, "releaseVersion") ??
      (release ? readOptionalString(release, "releaseVersion", "version") : undefined),
    releaseStatus:
      readOptionalString(body, "releaseStatus") ??
      (release ? readOptionalString(release, "releaseStatus", "status") : undefined),
    releaseManifest:
      readOptionalObject(body, "releaseManifest") ??
      (release ? readOptionalObject(release, "manifest") : undefined),
    releaseFiles,
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeTextFile(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(targetPath, `${content.trimEnd()}\n`, { encoding: "utf-8", mode: 0o600 });
}

async function copyFileIfMissing(sourcePath: string, targetPath: string): Promise<void> {
  if (!(await pathExists(sourcePath)) || (await pathExists(targetPath))) {
    return;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await fs.copyFile(sourcePath, targetPath);
  try {
    await fs.chmod(targetPath, 0o600);
  } catch {
    // best effort
  }
}

function buildDefaultWorkspaceFiles(params: {
  agentId: string;
  name?: string;
  description?: string;
  systemPrompt?: string;
  skillSnapshotId?: string;
}): Array<{ name: string; content: string }> {
  const identityLines = [
    "# IDENTITY.md - Agent Identity",
    "",
    `- Name: ${params.name || params.agentId}`,
    "- Creature:",
    "- Vibe:",
    "- Emoji:",
  ];
  const promptLines = [
    "# AGENTS.md - Synced Agent Instructions",
    "",
    `- Agent ID: ${params.agentId}`,
    params.name ? `- Name: ${params.name}` : undefined,
    params.description ? `- Description: ${params.description}` : undefined,
    params.skillSnapshotId ? `- Skill Snapshot: ${params.skillSnapshotId}` : undefined,
    "",
    params.systemPrompt ? "## System Prompt" : undefined,
    params.systemPrompt || undefined,
  ].filter((line): line is string => Boolean(line));
  const pinnedMemoryLines = [
    "# Pinned Memory",
    "",
    "## Agent Memory",
    `- Agent ID: ${params.agentId}`,
    params.name ? `- Name: ${params.name}` : undefined,
    params.description ? `- Stable role: ${truncateText(params.description, 320)}` : undefined,
    params.skillSnapshotId ? `- Skill Snapshot: ${params.skillSnapshotId}` : undefined,
    params.systemPrompt
      ? `- Stable operating guidance: ${truncateText(params.systemPrompt, 1_000)}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
  return [
    { name: DEFAULT_IDENTITY_FILENAME, content: identityLines.join("\n") },
    { name: DEFAULT_AGENTS_FILENAME, content: promptLines.join("\n") },
    { name: DEFAULT_PINNED_MEMORY_FILENAME, content: pinnedMemoryLines.join("\n") },
  ];
}

async function readTextFileIfExists(targetPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(targetPath, "utf-8");
  } catch {
    return undefined;
  }
}

function extractWorkspaceField(content: string | undefined, label: string): string | undefined {
  if (!content) {
    return undefined;
  }
  const match = content.match(new RegExp(`^- ${label}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() || undefined;
}

function extractWorkspaceSection(content: string | undefined, heading: string): string | undefined {
  if (!content) {
    return undefined;
  }
  const marker = `${heading}\n`;
  const startIndex = content.indexOf(marker);
  if (startIndex < 0) {
    return undefined;
  }
  const section = content.slice(startIndex + marker.length).trim();
  return section || undefined;
}

async function loadExistingWorkspaceMetadata(workspaceDir: string): Promise<{
  name?: string;
  description?: string;
  systemPrompt?: string;
  skillSnapshotId?: string;
}> {
  const [identityContent, agentsContent] = await Promise.all([
    readTextFileIfExists(path.join(workspaceDir, DEFAULT_IDENTITY_FILENAME)),
    readTextFileIfExists(path.join(workspaceDir, DEFAULT_AGENTS_FILENAME)),
  ]);
  return {
    name:
      extractWorkspaceField(agentsContent, "Name") ??
      extractWorkspaceField(identityContent, "Name"),
    description: extractWorkspaceField(agentsContent, "Description"),
    systemPrompt: extractWorkspaceSection(agentsContent, "## System Prompt"),
    skillSnapshotId: extractWorkspaceField(agentsContent, "Skill Snapshot"),
  };
}

async function collectMemoryMarkdownFiles(
  rootDir: string,
  relativeDir: string,
): Promise<Array<{ name: string; content: string }>> {
  const absDir = path.join(rootDir, relativeDir);
  if (!(await pathExists(absDir))) {
    return [];
  }
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const files: Array<{ name: string; content: string }> = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    if (!normalized) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectMemoryMarkdownFiles(rootDir, normalized)));
      continue;
    }
    if (!entry.isFile() || !normalized.endsWith(".md")) {
      continue;
    }
    const content = await readTextFileIfExists(path.join(rootDir, normalized));
    if (typeof content === "string") {
      files.push({ name: normalized, content });
    }
  }
  return files;
}

async function listExportableReleaseFiles(
  workspaceDir: string,
): Promise<Array<{ name: string; content: string }>> {
  const files: Array<{ name: string; content: string }> = [];
  for (const relativePath of RELEASE_EXPORT_ROOT_FILES) {
    const content = await readTextFileIfExists(path.join(workspaceDir, relativePath));
    if (typeof content === "string") {
      files.push({ name: relativePath, content });
    }
  }
  files.push(...(await collectMemoryMarkdownFiles(workspaceDir, "memory")));
  return files.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function ensureLocalAgentProvisioned(body: JsonObject): Promise<{
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  localAgentKey: string;
  workspaceKey: string;
}> {
  const requestedAgentId = normalizeAgentId(
    readOptionalString(body, "agentId", "localAgentKey", "localAgentId") || "",
  );
  if (!requestedAgentId) {
    throw new Error("missing or invalid agentId");
  }

  const currentCfg = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(currentCfg, requestedAgentId);
  const agentDir = resolveAgentDir(currentCfg, requestedAgentId);
  const existingEntries = [...listAgentEntries(currentCfg)];
  const existingIndex = existingEntries.findIndex(
    (entry) => normalizeAgentId(entry.id) === requestedAgentId,
  );
  const existingEntry = existingIndex >= 0 ? existingEntries[existingIndex] : undefined;
  const nextEntry = {
    ...existingEntry,
    id: requestedAgentId,
    name: readOptionalString(body, "name") ?? existingEntry?.name ?? requestedAgentId,
    workspace: workspaceDir,
    agentDir,
  };
  if (existingIndex >= 0) {
    existingEntries.splice(existingIndex, 1, nextEntry);
  } else {
    existingEntries.push(nextEntry);
  }

  await writeConfigFile({
    ...currentCfg,
    agents: {
      ...currentCfg.agents,
      list: existingEntries,
    },
  });

  const cfg = loadConfig();
  const sourceAgentId = resolveDefaultAgentId(cfg);
  const sourceAgentDir = resolveAgentDir(cfg, sourceAgentId);
  const targetAgentDir = resolveAgentDir(cfg, requestedAgentId);
  await fs.mkdir(targetAgentDir, { recursive: true, mode: 0o700 });
  if (sourceAgentId !== requestedAgentId) {
    await copyFileIfMissing(
      path.join(sourceAgentDir, "auth-profiles.json"),
      path.join(targetAgentDir, "auth-profiles.json"),
    );
    await copyFileIfMissing(
      path.join(sourceAgentDir, "models.json"),
      path.join(targetAgentDir, "models.json"),
    );
  }

  const workspace = await ensureAgentWorkspace({
    dir: resolveAgentWorkspaceDir(cfg, requestedAgentId),
    ensureBootstrapFiles: true,
  });
  const explicitWorkspaceFiles = parseWorkspaceFilesFromValue(body.workspaceFiles);
  const existingWorkspaceMetadata =
    explicitWorkspaceFiles.length > 0 ? {} : await loadExistingWorkspaceMetadata(workspace.dir);
  const workspaceFiles =
    explicitWorkspaceFiles.length > 0
      ? explicitWorkspaceFiles
      : buildDefaultWorkspaceFiles({
          agentId: requestedAgentId,
          name:
            readOptionalString(body, "name") ??
            existingEntry?.name ??
            existingWorkspaceMetadata.name,
          description:
            readOptionalString(body, "description") ?? existingWorkspaceMetadata.description,
          systemPrompt:
            readOptionalString(body, "systemPrompt") ?? existingWorkspaceMetadata.systemPrompt,
          skillSnapshotId:
            readOptionalString(body, "skillSnapshotId", "snapshotId") ??
            existingWorkspaceMetadata.skillSnapshotId,
        });
  for (const file of workspaceFiles) {
    await writeTextFile(path.join(workspace.dir, file.name), file.content);
  }

  return {
    cfg,
    agentId: requestedAgentId,
    localAgentKey: requestedAgentId,
    workspaceKey: path.basename(workspace.dir) || `workspace-${requestedAgentId}`,
  };
}

function mergeSyncedRuntimeAgents(params: {
  currentAgents: ControlPlaneRuntimeAgent[];
  nextEntry: ControlPlaneRuntimeAgent;
}): ControlPlaneRuntimeAgent[] {
  const nextAgentId = normalizeAgentId(params.nextEntry.agentId);
  const nextRemoteAgentId = normalizeRemoteAgentId(params.nextEntry.remoteAgentId);
  const nextRole = params.nextEntry.runtimeRole;

  const occupiesSameSlot = (entry: ControlPlaneRuntimeAgent): boolean => {
    if (normalizeRemoteAgentId(entry.remoteAgentId) !== nextRemoteAgentId) {
      return false;
    }
    if (nextRole && entry.runtimeRole) {
      return entry.runtimeRole === nextRole;
    }
    return normalizeAgentId(entry.agentId) === nextAgentId;
  };

  return [...params.currentAgents.filter((entry) => !occupiesSameSlot(entry)), params.nextEntry];
}

function resolvePrimaryRuntimeRemoteAgentId(params: {
  cfg: ReturnType<typeof loadConfig>;
  currentState: ReturnType<typeof loadControlPlaneRuntimeState>;
  agents: ControlPlaneRuntimeAgent[];
  fallbackRemoteAgentId: string;
}): string {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const defaultAgentEntry = params.agents.find(
    (entry) => normalizeAgentId(entry.agentId) === defaultAgentId && entry.remoteAgentId,
  );
  if (defaultAgentEntry?.remoteAgentId) {
    return defaultAgentEntry.remoteAgentId;
  }
  const currentRemoteAgentId = normalizeRemoteAgentId(params.currentState.remoteAgentId);
  const currentEntry = params.agents.find(
    (entry) => normalizeRemoteAgentId(entry.remoteAgentId) === currentRemoteAgentId,
  );
  if (currentEntry?.remoteAgentId) {
    return currentEntry.remoteAgentId;
  }
  return params.fallbackRemoteAgentId;
}

async function upsertRuntimeAgent(params: {
  body: JsonObject;
  deploymentSource: "sync" | "release";
  defaultRuntimeRole?: ControlPlaneRuntimeRole;
}): Promise<{
  agentId: string;
  localAgentKey: string;
  workspaceKey: string;
  remoteAgentId: string;
  runtimeRole?: ControlPlaneRuntimeRole;
  sessionViews: ControlPlaneConversationView[];
  agentVersionId?: string;
  skillSnapshotId?: string;
  releaseId?: string;
  releaseVersion?: string;
  releaseStatus?: string;
  releaseManifest?: JsonObject;
  releaseFileCount?: number;
  totalAgents: number;
}> {
  const release = parseReleaseDescriptor(params.body);
  const provisionBody =
    release.releaseFiles.length > 0
      ? { ...params.body, workspaceFiles: release.releaseFiles }
      : params.body;
  const provisioned = await ensureLocalAgentProvisioned(provisionBody);
  const agentId = provisioned.agentId;
  const remoteAgentId =
    typeof params.body.remoteAgentId === "string" && params.body.remoteAgentId.trim()
      ? params.body.remoteAgentId.trim()
      : `remote-${agentId || "agent"}`;
  const current = loadControlPlaneRuntimeState();
  const existingEntry = (current.agents ?? []).find(
    (item) => normalizeAgentId(item.agentId) === agentId,
  );
  const runtimeRole =
    normalizeRuntimeRole(
      readOptionalString(params.body, "runtimeRole", "targetRuntimeRole") ??
        readOptionalString(current as JsonObject, "runtimeRole"),
    ) ??
    params.defaultRuntimeRole ??
    existingEntry?.runtimeRole;
  const sessionViews = buildSessionViews(runtimeRole);
  const now = new Date().toISOString();
  const releaseStage = readOptionalString(params.body, "releaseStage");
  const releaseStatus =
    release.releaseStatus ??
    (releaseStage === "released" || releaseStage === "published" ? "released" : undefined) ??
    (params.deploymentSource === "release"
      ? "deployed"
      : runtimeRole === "training"
        ? (existingEntry?.releaseStatus ?? "draft")
        : existingEntry?.releaseStatus);
  const nextEntry: ControlPlaneRuntimeAgent = {
    ...existingEntry,
    agentId,
    name: readOptionalString(params.body, "name") ?? existingEntry?.name,
    remoteAgentId,
    localAgentKey: provisioned.localAgentKey,
    workspaceKey: provisioned.workspaceKey,
    agentVersionId:
      readOptionalString(params.body, "agentVersionId") ?? existingEntry?.agentVersionId,
    skillSnapshotId:
      readOptionalString(params.body, "skillSnapshotId", "snapshotId") ??
      existingEntry?.skillSnapshotId,
    runtimeRole,
    sessionViews,
    deploymentSource: params.deploymentSource,
    releaseId: release.releaseId ?? existingEntry?.releaseId,
    releaseVersion: release.releaseVersion ?? existingEntry?.releaseVersion,
    releaseStatus,
    releaseManifest: release.releaseManifest ?? existingEntry?.releaseManifest,
    releaseFileCount:
      release.releaseFiles.length > 0
        ? release.releaseFiles.length
        : existingEntry?.releaseFileCount,
    deployedAt: params.deploymentSource === "release" ? now : existingEntry?.deployedAt,
    status: "ready",
    updatedAt: now,
  };
  const agents = mergeSyncedRuntimeAgents({
    currentAgents: [...(current.agents ?? [])],
    nextEntry,
  });
  const state = mergeControlPlaneRuntimeState({
    runtimeRole: current.runtimeRole,
    sessionViews: buildSessionViews(current.runtimeRole),
    remoteAgentId: resolvePrimaryRuntimeRemoteAgentId({
      cfg: provisioned.cfg,
      currentState: current,
      agents,
      fallbackRemoteAgentId: remoteAgentId,
    }),
    agentVersion: readOptionalString(params.body, "agentVersionId") ?? current.agentVersion,
    skillSnapshotId:
      readOptionalString(params.body, "skillSnapshotId", "snapshotId") ?? current.skillSnapshotId,
    agents,
  });
  return {
    agentId,
    localAgentKey: provisioned.localAgentKey,
    workspaceKey: provisioned.workspaceKey,
    remoteAgentId,
    runtimeRole,
    sessionViews,
    agentVersionId: nextEntry.agentVersionId,
    skillSnapshotId: nextEntry.skillSnapshotId,
    releaseId: nextEntry.releaseId,
    releaseVersion: nextEntry.releaseVersion,
    releaseStatus: nextEntry.releaseStatus,
    releaseManifest: nextEntry.releaseManifest,
    releaseFileCount: nextEntry.releaseFileCount,
    totalAgents: state.agents?.length ?? 0,
  };
}

function buildReleaseExportPayload(params: {
  runtimeAgent: ControlPlaneRuntimeAgent;
  files: Array<{ name: string; content: string }>;
  release: ReleaseDescriptor;
  exportedAt: string;
}) {
  return {
    ok: true,
    remoteAgentId: params.runtimeAgent.remoteAgentId,
    agentId: params.runtimeAgent.agentId,
    runtimeRole: params.runtimeAgent.runtimeRole,
    release: {
      releaseId: params.release.releaseId ?? params.runtimeAgent.releaseId,
      releaseVersion:
        params.release.releaseVersion ??
        params.runtimeAgent.releaseVersion ??
        params.runtimeAgent.agentVersionId,
      releaseStatus:
        params.release.releaseStatus ?? params.runtimeAgent.releaseStatus ?? "released",
      exportedAt: params.exportedAt,
      agentVersionId: params.runtimeAgent.agentVersionId,
      skillSnapshotId: params.runtimeAgent.skillSnapshotId,
      manifest: params.release.releaseManifest ?? params.runtimeAgent.releaseManifest,
      files: params.files,
      fileCount: params.files.length,
    },
  };
}

async function deleteRuntimeAgentByRemoteAgentId(remoteAgentId: string): Promise<{
  status: number;
  body: JsonObject;
}> {
  const cfg = loadConfig();
  const current = loadControlPlaneRuntimeState();
  const runtimeAgent = (current.agents ?? []).find(
    (entry) =>
      normalizeRemoteAgentId(entry.remoteAgentId) === normalizeRemoteAgentId(remoteAgentId),
  );
  if (!runtimeAgent) {
    return {
      status: 404,
      body: {
        error: "remote agent is not synced to a local OpenClaw agent",
        remoteAgentId,
      },
    };
  }
  if (normalizeAgentId(runtimeAgent.agentId) === resolveDefaultAgentId(cfg)) {
    return {
      status: 409,
      body: {
        error: "refusing to delete the default runtime template agent",
        remoteAgentId,
        agentId: runtimeAgent.agentId,
      },
    };
  }

  const remainingConfigAgents = listAgentEntries(cfg).filter(
    (entry) => normalizeAgentId(entry.id) !== normalizeAgentId(runtimeAgent.agentId),
  );
  await writeConfigFile({
    ...cfg,
    agents: {
      ...cfg.agents,
      list: remainingConfigAgents,
    },
  });
  const nextCfg = loadConfig();
  await fs.rm(resolveAgentDir(nextCfg, runtimeAgent.agentId), {
    recursive: true,
    force: true,
  });
  await fs.rm(resolveAgentWorkspaceDir(nextCfg, runtimeAgent.agentId), {
    recursive: true,
    force: true,
  });
  const agents = (current.agents ?? []).filter(
    (entry) =>
      normalizeRemoteAgentId(entry.remoteAgentId) !== normalizeRemoteAgentId(remoteAgentId),
  );
  mergeControlPlaneRuntimeState({
    agents,
    remoteAgentId:
      agents.length > 0
        ? resolvePrimaryRuntimeRemoteAgentId({
            cfg: nextCfg,
            currentState: current,
            agents,
            fallbackRemoteAgentId: agents[0]?.remoteAgentId ?? "",
          })
        : undefined,
  });
  return {
    status: 200,
    body: {
      ok: true,
      remoteAgentId,
      agentId: runtimeAgent.agentId,
      localAgentKey: runtimeAgent.localAgentKey ?? runtimeAgent.agentId,
      workspaceKey: runtimeAgent.workspaceKey ?? null,
      status: "deleted",
      remainingAgents: agents.length,
    },
  };
}

function listPendingExecApprovalRecords(
  manager: NonNullable<ReturnType<typeof getGlobalExecApprovalManager>>,
): ExecApprovalRecord[] {
  const pending = (manager as unknown as { pending?: Map<string, { record: ExecApprovalRecord }> })
    .pending;
  if (!(pending instanceof Map)) {
    return [];
  }
  const records: ExecApprovalRecord[] = [];
  for (const entry of pending.values()) {
    if (entry.record.resolvedAtMs === undefined) {
      records.push(entry.record);
    }
  }
  return records;
}

export async function handleControlPlaneHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(PREFIX)) {
    return false;
  }
  if (!authorizeBridge(req)) {
    sendJson(res, 401, { error: "unauthorized bridge token" });
    return true;
  }

  if (url.pathname === `${PREFIX}/runtime-context`) {
    if (!ensureMethod(req, res, "GET")) {
      return true;
    }
    sendJson(res, 200, loadControlPlaneRuntimeState());
    return true;
  }

  if (url.pathname === `${PREFIX}/bootstrap`) {
    if (!ensureMethod(req, res, "POST")) {
      return true;
    }
    const body = await readBody(req);
    const current = loadControlPlaneRuntimeState();
    const runtimeRole =
      normalizeRuntimeRole(readOptionalString(body, "runtimeRole", "instanceRole")) ??
      current.runtimeRole;
    const state = mergeControlPlaneRuntimeState({
      workgroupId: readOptionalString(body, "workgroupId"),
      workgroupName: readOptionalString(body, "workgroupName"),
      instanceKey: readOptionalString(body, "instanceKey"),
      machineName: readOptionalString(body, "machineName"),
      runtimeRole,
      sessionViews: buildSessionViews(runtimeRole),
      bundleDir: readOptionalString(body, "bundleDir"),
      manifestPath: readOptionalString(body, "manifestPath"),
      skillSnapshotId: readOptionalString(body, "snapshotId", "skillSnapshotId"),
      traceContext: readOptionalString(body, "traceId", "traceContext"),
      instanceId:
        typeof body.instanceId === "string"
          ? body.instanceId
          : typeof body.instanceKey === "string"
            ? body.instanceKey
            : undefined,
    });
    sendJson(res, 200, { ok: true, state });
    return true;
  }

  if (url.pathname === `${PREFIX}/skills/snapshot/apply`) {
    if (!ensureMethod(req, res, "POST")) {
      return true;
    }
    const body = await readBody(req);
    const snapshotId = readOptionalString(body, "snapshotId", "skillSnapshotId") ?? "";
    const packages = Array.isArray(body.packages)
      ? body.packages
          .filter(
            (item): item is JsonObject =>
              Boolean(item) && typeof item === "object" && !Array.isArray(item),
          )
          .map((item) => ({
            skillKey: typeof item.skillKey === "string" ? item.skillKey : "",
            type: typeof item.type === "string" ? item.type : undefined,
            status: typeof item.status === "string" ? item.status : undefined,
            remoteSkillKey:
              typeof item.remoteSkillKey === "string" ? item.remoteSkillKey : undefined,
          }))
          .filter((item) => item.skillKey)
      : [];
    const current = loadControlPlaneRuntimeState();
    const state = mergeControlPlaneRuntimeState({
      skillSnapshotId: snapshotId || current.skillSnapshotId,
      skillSnapshot: snapshotId
        ? {
            snapshotId,
            appliedAt: new Date().toISOString(),
            packages,
          }
        : current.skillSnapshot,
    });
    sendJson(res, 200, {
      ok: true,
      snapshotId: state.skillSnapshotId,
      packagesApplied: packages.length,
    });
    return true;
  }

  if (url.pathname === `${PREFIX}/agents/sync`) {
    if (!ensureMethod(req, res, "POST")) {
      return true;
    }
    const body = await readBody(req);
    try {
      const synced = await upsertRuntimeAgent({
        body,
        deploymentSource: "sync",
      });
      sendJson(res, 200, {
        ok: true,
        agentId: synced.agentId,
        localAgentKey: synced.localAgentKey,
        workspaceKey: synced.workspaceKey,
        remoteAgentId: synced.remoteAgentId,
        runtimeRole: synced.runtimeRole,
        sessionViews: synced.sessionViews,
        agentVersionId: synced.agentVersionId,
        skillSnapshotId: synced.skillSnapshotId,
        releaseId: synced.releaseId,
        releaseVersion: synced.releaseVersion,
        releaseStatus: synced.releaseStatus,
        releaseFileCount: synced.releaseFileCount,
        status: "ready",
        totalAgents: synced.totalAgents,
      });
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (url.pathname === `${PREFIX}/agents/deploy`) {
    if (!ensureMethod(req, res, "POST")) {
      return true;
    }
    const body = await readBody(req);
    try {
      const deployed = await upsertRuntimeAgent({
        body,
        deploymentSource: "release",
        defaultRuntimeRole: "serving",
      });
      sendJson(res, 200, {
        ok: true,
        agentId: deployed.agentId,
        localAgentKey: deployed.localAgentKey,
        workspaceKey: deployed.workspaceKey,
        remoteAgentId: deployed.remoteAgentId,
        runtimeRole: deployed.runtimeRole,
        sessionViews: deployed.sessionViews,
        agentVersionId: deployed.agentVersionId,
        skillSnapshotId: deployed.skillSnapshotId,
        releaseId: deployed.releaseId,
        releaseVersion: deployed.releaseVersion,
        releaseStatus: deployed.releaseStatus,
        releaseFileCount: deployed.releaseFileCount,
        status: "deployed",
        totalAgents: deployed.totalAgents,
      });
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  const releaseExportMatch = url.pathname.match(
    new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/agents/([^/]+)/release/export$`),
  );
  if (releaseExportMatch) {
    if (!ensureMethod(req, res, "POST")) {
      return true;
    }
    const remoteAgentId = releaseExportMatch[1] ?? "";
    const body = await readBody(req);
    const current = loadControlPlaneRuntimeState();
    const runtimeAgent = (current.agents ?? []).find(
      (entry) =>
        normalizeRemoteAgentId(entry.remoteAgentId) === normalizeRemoteAgentId(remoteAgentId),
    );
    if (!runtimeAgent) {
      sendJson(res, 404, {
        error: "remote agent is not synced to a local OpenClaw agent",
        remoteAgentId,
      });
      return true;
    }
    const cfg = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, runtimeAgent.agentId);
    const files = await listExportableReleaseFiles(workspaceDir);
    const release = parseReleaseDescriptor(body);
    const exportedAt = new Date().toISOString();
    const nextAgent: ControlPlaneRuntimeAgent = {
      ...runtimeAgent,
      releaseId:
        release.releaseId ??
        runtimeAgent.releaseId ??
        `rel-${normalizeAgentId(runtimeAgent.agentId)}-${Date.now().toString(36)}`,
      releaseVersion:
        release.releaseVersion ?? runtimeAgent.releaseVersion ?? runtimeAgent.agentVersionId,
      releaseStatus: release.releaseStatus ?? runtimeAgent.releaseStatus ?? "released",
      releaseManifest: release.releaseManifest ?? runtimeAgent.releaseManifest,
      releaseFileCount: files.length,
      exportedAt,
      updatedAt: exportedAt,
    };
    mergeControlPlaneRuntimeState({
      agents: (current.agents ?? []).map((entry) =>
        normalizeRemoteAgentId(entry.remoteAgentId) === normalizeRemoteAgentId(remoteAgentId)
          ? nextAgent
          : entry,
      ),
    });
    sendJson(
      res,
      200,
      buildReleaseExportPayload({
        runtimeAgent: nextAgent,
        files,
        release,
        exportedAt,
      }),
    );
    return true;
  }

  const undeployMatch = url.pathname.match(
    new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/agents/([^/]+)/undeploy$`),
  );
  if (undeployMatch) {
    if (!ensureMethod(req, res, "POST")) {
      return true;
    }
    const remoteAgentId = undeployMatch[1] ?? "";
    const result = await deleteRuntimeAgentByRemoteAgentId(remoteAgentId);
    sendJson(res, result.status, {
      ...result.body,
      status: result.status === 200 ? "undeployed" : result.body.status,
    });
    return true;
  }

  const deleteAgentMatch = url.pathname.match(
    new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/agents/([^/]+)$`),
  );
  if (deleteAgentMatch) {
    if (!ensureMethod(req, res, "DELETE")) {
      return true;
    }
    const remoteAgentId = deleteAgentMatch[1] ?? "";
    const result = await deleteRuntimeAgentByRemoteAgentId(remoteAgentId);
    sendJson(res, result.status, result.body);
    return true;
  }

  if (url.pathname === `${PREFIX}/agents/delete`) {
    if (!ensureMethod(req, res, "POST")) {
      return true;
    }
    const body = await readBody(req);
    const remoteAgentId =
      typeof body.remoteAgentId === "string" && body.remoteAgentId.trim()
        ? body.remoteAgentId.trim()
        : "";
    if (!remoteAgentId) {
      sendJson(res, 400, { error: "missing or invalid remoteAgentId" });
      return true;
    }
    const result = await deleteRuntimeAgentByRemoteAgentId(remoteAgentId);
    sendJson(res, result.status, result.body);
    return true;
  }

  if (url.pathname === `${PREFIX}/portal/sessions`) {
    if (!ensureMethod(req, res, "POST")) {
      return true;
    }
    const body = await readBody(req);
    const remoteAgentId =
      typeof body.remoteAgentId === "string" && body.remoteAgentId.trim()
        ? body.remoteAgentId.trim()
        : undefined;
    if (!remoteAgentId) {
      sendJson(res, 400, { error: "missing or invalid remoteAgentId" });
      return true;
    }
    const mode = normalizePortalMode(body.mode);
    const conversationView = resolveConversationView(mode);
    const preferredLocalAgentKey = readOptionalString(body, "localAgentKey", "agentId");
    const resolvedTarget = resolvePortalTargetAgent(
      remoteAgentId,
      conversationView,
      preferredLocalAgentKey,
    );
    if (!resolvedTarget) {
      sendJson(res, 404, {
        error: preferredLocalAgentKey
          ? "remote agent is not synced to this localAgentKey on the runtime"
          : "remote agent is not synced to a local OpenClaw agent",
        remoteAgentId,
        ...(preferredLocalAgentKey ? { localAgentKey: preferredLocalAgentKey } : {}),
      });
      return true;
    }
    const runtimeRole =
      resolvedTarget.runtimeAgent?.runtimeRole ?? resolvedTarget.runtimeState.runtimeRole;
    const sessionViews =
      resolvedTarget.runtimeAgent?.sessionViews ?? buildSessionViews(runtimeRole);
    if (!sessionViews.includes(conversationView)) {
      sendJson(res, 409, {
        error: "requested conversation view is not supported on this runtime agent",
        code: "SESSION_VIEW_NOT_SUPPORTED",
        remoteAgentId,
        conversationView,
        runtimeRole,
        sessionViews,
      });
      return true;
    }
    const traceId = readOptionalString(body, "traceId");
    const portalSessionId = readOptionalString(body, "portalSessionId");
    const userContext = isJsonObject(body.userContext) ? body.userContext : undefined;
    const now = new Date().toISOString();
    const remoteSessionId = `rs_${randomUUID().replace(/-/g, "")}`;
    const sessionKey = buildPortalSessionKey({
      cfg: resolvedTarget.cfg,
      agentId: resolvedTarget.agentId,
      remoteSessionId,
      conversationView,
      revision: 0,
    });
    const writePolicy = buildPortalWritePolicy(conversationView);
    portalSessions.set(remoteSessionId, {
      remoteAgentId,
      agentId: resolvedTarget.agentId,
      sessionKey,
      sessionRevision: 0,
      turnCount: 0,
      portalSessionId,
      mode,
      conversationView,
      runtimeRole,
      sessionViews,
      writePolicy,
      traceId,
      userContext,
      createdAt: now,
      updatedAt: now,
      agentVersionId: resolvedTarget.runtimeAgent?.agentVersionId,
      skillSnapshotId: resolvedTarget.runtimeAgent?.skillSnapshotId,
      releaseId: resolvedTarget.runtimeAgent?.releaseId,
      releaseVersion: resolvedTarget.runtimeAgent?.releaseVersion,
      releaseStatus: resolvedTarget.runtimeAgent?.releaseStatus,
    });
    const sessionCreatedEvent = buildPortalRuntimeEvent({
      eventType: "session.created",
      level: "info",
      message: "Portal session created on runtime",
      payload: {
        remoteSessionId,
        remoteAgentId,
        agentId: resolvedTarget.agentId,
        mode,
        conversationView,
        traceId: traceId ?? null,
        portalSessionId: portalSessionId ?? null,
      },
      createdAt: now,
    });
    sendJson(res, 200, {
      ok: true,
      remoteSessionId,
      remoteAgentId,
      agentId: resolvedTarget.agentId,
      localAgentKey: resolvedTarget.runtimeAgent?.localAgentKey ?? resolvedTarget.agentId,
      workspaceKey: resolvedTarget.runtimeAgent?.workspaceKey,
      mode,
      conversationView,
      runtimeRole,
      sessionViews,
      writePolicy,
      agentVersionId: resolvedTarget.runtimeAgent?.agentVersionId,
      releaseId: resolvedTarget.runtimeAgent?.releaseId,
      releaseVersion: resolvedTarget.runtimeAgent?.releaseVersion,
      releaseStatus: resolvedTarget.runtimeAgent?.releaseStatus,
      status: "ready",
      runtimeEvents: [sessionCreatedEvent],
    });
    return true;
  }

  const portalMessagesMatch = url.pathname.match(
    new RegExp(
      `^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/portal/sessions/([^/]+)/messages$`,
    ),
  );
  if (portalMessagesMatch) {
    if (!ensureMethod(req, res, "POST")) {
      return true;
    }
    const remoteSessionId = portalMessagesMatch[1];
    const session = portalSessions.get(remoteSessionId);
    if (!session) {
      sendJson(res, 404, { error: "session not found", remoteSessionId });
      return true;
    }
    const body = await readBody(req);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      sendJson(res, 400, { error: "missing or invalid message" });
      return true;
    }
    const traceId = readOptionalString(body, "traceId");
    const portalSessionId = readOptionalString(body, "portalSessionId");
    const runId = `run_${randomUUID().replace(/-/g, "")}`;
    const runStartedAt = new Date().toISOString();
    const runStartedEvent = buildPortalRuntimeEvent({
      eventType: "run.started",
      level: "info",
      message: `Portal run ${runId} started`,
      payload: {
        runId,
        remoteSessionId,
        portalSessionId: portalSessionId ?? session.portalSessionId ?? null,
        traceId: traceId ?? session.traceId ?? null,
        agentId: session.agentId,
        mode: session.mode,
      },
      createdAt: runStartedAt,
    });
    const nextSession: PortalSessionRecord = {
      ...session,
      portalSessionId: portalSessionId ?? session.portalSessionId,
      traceId: traceId ?? session.traceId,
      updatedAt: new Date().toISOString(),
      lastRunId: runId,
    };
    portalSessions.set(remoteSessionId, nextSession);
    savePortalRun({
      runId,
      remoteSessionId,
      portalSessionId: portalSessionId ?? session.portalSessionId,
      traceId: traceId ?? session.traceId,
      status: "started",
      startedAt: runStartedAt,
      timeline: [{ phase: "started", at: runStartedAt }],
    });
    if (isSseRequest(req)) {
      setSseHeaders(res);
      let streamClosed = false;
      let sawAssistantDelta = false;
      let unsubscribe = () => {};
      const closeStream = () => {
        if (streamClosed) {
          return;
        }
        streamClosed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      };
      unsubscribe = onAgentEvent((evt) => {
        if (streamClosed || evt.runId !== runId) {
          return;
        }
        if (evt.stream === "assistant") {
          const delta = resolveAssistantStreamDeltaText(evt);
          if (!delta) {
            return;
          }
          sawAssistantDelta = true;
          writePortalStreamEvent(res, "assistant.delta", {
            runId,
            traceId: traceId ?? nextSession.traceId ?? null,
            delta,
            seq: evt.seq,
            createdAt: new Date(evt.ts).toISOString(),
          });
          return;
        }
        const runtimeEvent = buildPortalRuntimeEventFromAgentEvent(evt);
        if (!runtimeEvent) {
          return;
        }
        writePortalStreamEvent(res, "runtime.event", runtimeEvent);
      });
      req.on("close", () => {
        if (streamClosed) {
          return;
        }
        streamClosed = true;
        unsubscribe();
      });

      writePortalStreamEvent(res, "message.start", {
        runId,
        traceId: traceId ?? nextSession.traceId ?? null,
        portalSessionId: portalSessionId ?? nextSession.portalSessionId ?? null,
        remoteSessionId,
        mode: nextSession.mode,
        conversationView: nextSession.conversationView,
        runtimeRole: nextSession.runtimeRole,
        agentVersionId: nextSession.agentVersionId ?? null,
        releaseId: nextSession.releaseId ?? null,
        releaseVersion: nextSession.releaseVersion ?? null,
        releaseStatus: nextSession.releaseStatus ?? null,
        startedAt: runStartedAt,
      });
      writePortalStreamEvent(res, "runtime.event", runStartedEvent);

      void (async () => {
        try {
          const cfg = loadConfig();
          const result = await agentCommandFromIngress(
            {
              message,
              sessionKey: nextSession.sessionKey,
              runId,
              deliver: false,
              messageChannel: "webchat",
              bestEffortDeliver: false,
              senderIsOwner: true,
              allowModelOverride: false,
              thinking: "off",
              extraSystemPrompt: buildPortalExtraSystemPrompt({
                remoteSessionId,
                session: nextSession,
                traceId,
                portalSessionId,
              }),
            },
            defaultRuntime,
            createDefaultDeps(),
          );
          const reply = resolvePortalReplyText(result);
          const usage = extractPortalUsage(result);
          if (reply === EMPTY_PORTAL_REPLY) {
            defaultRuntime.log(
              `[control-plane] portal session produced no visible reply (runId=${runId}, traceId=${traceId}, remoteSessionId=${remoteSessionId}, agentId=${nextSession.agentId})`,
            );
          }
          let approval: PortalApprovalSummary | undefined;
          if (nextSession.mode === "training") {
            const manager = getGlobalExecApprovalManager();
            if (manager) {
              const pendingForSession = listPendingExecApprovalRecords(manager).filter(
                (record: ExecApprovalRecord) => {
                  const requestSessionKey =
                    record.request.sessionKey ??
                    record.request.systemRunBinding?.sessionKey ??
                    null;
                  return requestSessionKey === nextSession.sessionKey;
                },
              );
              if (pendingForSession.length > 0) {
                let latest = pendingForSession[0];
                for (const current of pendingForSession.slice(1)) {
                  if (current.createdAtMs > latest.createdAtMs) {
                    latest = current;
                  }
                }
                approval = {
                  id: latest.id,
                  kind: "exec",
                  command: latest.request.command,
                  host: latest.request.host ?? undefined,
                  cwd: latest.request.cwd ?? undefined,
                  expiresAt: new Date(latest.expiresAtMs).toISOString(),
                };
              }
            }
          }
          const candidateChanges = buildTrainingCandidateChanges({
            session: nextSession,
            message,
            reply,
            status: approval ? "requires_approval" : "completed",
            approval,
          });
          const updatedHistorySummary = appendHistorySummary(
            nextSession.historySummary,
            summarizePortalExchange({
              message,
              reply,
              usage,
            }),
          );

          if (!streamClosed && !sawAssistantDelta && reply && reply !== EMPTY_PORTAL_REPLY) {
            sawAssistantDelta = true;
            writePortalStreamEvent(res, "assistant.delta", {
              runId,
              traceId: traceId ?? nextSession.traceId ?? null,
              delta: reply,
              createdAt: new Date().toISOString(),
            });
          }

          if (approval) {
            portalSessions.set(remoteSessionId, {
              ...nextSession,
              turnCount: nextSession.turnCount + 1,
              historySummary: updatedHistorySummary,
            });
            const approvalTime = new Date().toISOString();
            const runRecord = savePortalRun({
              runId,
              remoteSessionId,
              portalSessionId: portalSessionId ?? nextSession.portalSessionId,
              traceId: traceId ?? nextSession.traceId,
              status: "requires_approval",
              startedAt: runStartedAt,
              endedAt: approvalTime,
              durationMs: Math.max(0, Date.parse(approvalTime) - Date.parse(runStartedAt)),
              reply,
              usage,
              candidateChanges,
              timeline: appendPortalRunTimeline(portalRuns.get(runId), {
                phase: "requires_approval",
                at: approvalTime,
              }),
            });
            const approvalRequiredEvent = buildPortalRuntimeEvent({
              eventType: "approval.required",
              level: "warn",
              message: "Exec approval required before continuing",
              payload: {
                runId,
                approvalId: approval.id,
                kind: approval.kind,
                command: approval.command,
                host: approval.host ?? null,
                cwd: approval.cwd ?? null,
                expiresAt: approval.expiresAt ?? null,
              },
              createdAt: approvalTime,
            });
            if (!streamClosed) {
              writePortalStreamEvent(res, "runtime.event", approvalRequiredEvent);
              writePortalStreamEvent(res, "message.complete", {
                ok: true,
                status: "requires_approval",
                runId,
                traceId: traceId ?? nextSession.traceId,
                portalSessionId: portalSessionId ?? nextSession.portalSessionId,
                remoteSessionId,
                startedAt: runRecord.startedAt,
                endedAt: runRecord.endedAt,
                durationMs: runRecord.durationMs,
                reply,
                usage,
                mode: nextSession.mode,
                conversationView: nextSession.conversationView,
                runtimeRole: nextSession.runtimeRole,
                writePolicy: nextSession.writePolicy,
                agentVersionId: nextSession.agentVersionId,
                releaseId: nextSession.releaseId,
                releaseVersion: nextSession.releaseVersion,
                releaseStatus: nextSession.releaseStatus,
                timeline: runRecord.timeline,
                approval,
                candidateChanges,
                runtimeEvents: [runStartedEvent, approvalRequiredEvent],
              });
            }
          } else {
            let persistedSession: PortalSessionRecord = {
              ...nextSession,
              turnCount: nextSession.turnCount + 1,
              historySummary: updatedHistorySummary,
            };
            if (shouldRolloverPortalSession({ session: persistedSession, usage })) {
              const nextRevision = persistedSession.sessionRevision + 1;
              persistedSession = {
                ...persistedSession,
                sessionRevision: nextRevision,
                sessionKey: buildPortalSessionKey({
                  cfg,
                  agentId: persistedSession.agentId,
                  remoteSessionId,
                  conversationView: persistedSession.conversationView,
                  revision: nextRevision,
                }),
                turnCount: 0,
              };
            }
            portalSessions.set(remoteSessionId, persistedSession);
            const completedAt = new Date().toISOString();
            const runRecord = savePortalRun({
              runId,
              remoteSessionId,
              portalSessionId: portalSessionId ?? nextSession.portalSessionId,
              traceId: traceId ?? nextSession.traceId,
              status: "completed",
              startedAt: runStartedAt,
              endedAt: completedAt,
              durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(runStartedAt)),
              reply,
              usage,
              candidateChanges,
              timeline: appendPortalRunTimeline(portalRuns.get(runId), {
                phase: "completed",
                at: completedAt,
              }),
            });
            const runCompletedEvent = buildPortalRuntimeEvent({
              eventType: "run.completed",
              level: "info",
              message: `Portal run ${runId} completed`,
              payload: {
                runId,
                status: "completed",
                usage: usage ?? null,
              },
              createdAt: completedAt,
            });
            if (!streamClosed) {
              writePortalStreamEvent(res, "runtime.event", runCompletedEvent);
              writePortalStreamEvent(res, "message.complete", {
                ok: true,
                status: "completed",
                runId,
                traceId: traceId ?? nextSession.traceId,
                portalSessionId: portalSessionId ?? nextSession.portalSessionId,
                remoteSessionId,
                startedAt: runRecord.startedAt,
                endedAt: runRecord.endedAt,
                durationMs: runRecord.durationMs,
                reply,
                usage,
                mode: nextSession.mode,
                conversationView: nextSession.conversationView,
                runtimeRole: nextSession.runtimeRole,
                writePolicy: nextSession.writePolicy,
                agentVersionId: nextSession.agentVersionId,
                releaseId: nextSession.releaseId,
                releaseVersion: nextSession.releaseVersion,
                releaseStatus: nextSession.releaseStatus,
                timeline: runRecord.timeline,
                candidateChanges,
                runtimeEvents: [runStartedEvent, runCompletedEvent],
              });
            }
          }
        } catch (error) {
          const failedAt = new Date().toISOString();
          const message = error instanceof Error ? error.message : String(error);
          const runRecord = savePortalRun({
            runId,
            remoteSessionId,
            portalSessionId: portalSessionId ?? nextSession.portalSessionId,
            traceId: traceId ?? nextSession.traceId,
            status: "failed",
            startedAt: runStartedAt,
            endedAt: failedAt,
            durationMs: Math.max(0, Date.parse(failedAt) - Date.parse(runStartedAt)),
            error: {
              message,
            },
            timeline: appendPortalRunTimeline(portalRuns.get(runId), {
              phase: "failed",
              at: failedAt,
              error: message,
            }),
          });
          const runFailedEvent = buildPortalRuntimeEvent({
            eventType: "run.failed",
            level: "error",
            message: `Portal run ${runId} failed`,
            payload: {
              runId,
              code: "PORTAL_RUN_FAILED",
              error: message,
            },
            createdAt: failedAt,
          });
          if (!streamClosed) {
            writePortalStreamEvent(res, "runtime.event", runFailedEvent);
            writePortalStreamEvent(res, "message.error", {
              code: "PORTAL_RUN_FAILED",
              message,
              status: 500,
              runId,
              traceId: traceId ?? nextSession.traceId,
              portalSessionId: portalSessionId ?? nextSession.portalSessionId,
              remoteSessionId,
              startedAt: runRecord.startedAt,
              endedAt: runRecord.endedAt,
              durationMs: runRecord.durationMs,
              timeline: runRecord.timeline,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              runtimeEvents: [runStartedEvent, runFailedEvent],
            });
          }
        } finally {
          if (!streamClosed) {
            closeStream();
          }
        }
      })();
      return true;
    }
    try {
      const cfg = loadConfig();
      const result = await agentCommandFromIngress(
        {
          message,
          sessionKey: nextSession.sessionKey,
          runId,
          deliver: false,
          messageChannel: "webchat",
          bestEffortDeliver: false,
          senderIsOwner: true,
          allowModelOverride: false,
          thinking: "off",
          extraSystemPrompt: buildPortalExtraSystemPrompt({
            remoteSessionId,
            session: nextSession,
            traceId,
            portalSessionId,
          }),
        },
        defaultRuntime,
        createDefaultDeps(),
      );
      const reply = resolvePortalReplyText(result);
      const usage = extractPortalUsage(result);
      if (reply === EMPTY_PORTAL_REPLY) {
        defaultRuntime.log(
          `[control-plane] portal session produced no visible reply (runId=${runId}, traceId=${traceId}, remoteSessionId=${remoteSessionId}, agentId=${nextSession.agentId})`,
        );
      }
      let approval: PortalApprovalSummary | undefined;
      if (nextSession.mode === "training") {
        const manager = getGlobalExecApprovalManager();
        if (manager) {
          const pendingForSession = listPendingExecApprovalRecords(manager).filter(
            (record: ExecApprovalRecord) => {
              const requestSessionKey =
                record.request.sessionKey ?? record.request.systemRunBinding?.sessionKey ?? null;
              return requestSessionKey === nextSession.sessionKey;
            },
          );
          if (pendingForSession.length > 0) {
            let latest = pendingForSession[0];
            for (const current of pendingForSession.slice(1)) {
              if (current.createdAtMs > latest.createdAtMs) {
                latest = current;
              }
            }
            approval = {
              id: latest.id,
              kind: "exec",
              command: latest.request.command,
              host: latest.request.host ?? undefined,
              cwd: latest.request.cwd ?? undefined,
              expiresAt: new Date(latest.expiresAtMs).toISOString(),
            };
          }
        }
      }
      const candidateChanges = buildTrainingCandidateChanges({
        session: nextSession,
        message,
        reply,
        status: approval ? "requires_approval" : "completed",
        approval,
      });
      const updatedHistorySummary = appendHistorySummary(
        nextSession.historySummary,
        summarizePortalExchange({
          message,
          reply,
          usage,
        }),
      );
      if (approval) {
        portalSessions.set(remoteSessionId, {
          ...nextSession,
          turnCount: nextSession.turnCount + 1,
          historySummary: updatedHistorySummary,
        });
        const approvalTime = new Date().toISOString();
        const runRecord = savePortalRun({
          runId,
          remoteSessionId,
          portalSessionId: portalSessionId ?? nextSession.portalSessionId,
          traceId: traceId ?? nextSession.traceId,
          status: "requires_approval",
          startedAt: runStartedAt,
          endedAt: approvalTime,
          durationMs: Math.max(0, Date.parse(approvalTime) - Date.parse(runStartedAt)),
          reply,
          usage,
          candidateChanges,
          timeline: appendPortalRunTimeline(portalRuns.get(runId), {
            phase: "requires_approval",
            at: approvalTime,
          }),
        });
        const approvalRequiredEvent = buildPortalRuntimeEvent({
          eventType: "approval.required",
          level: "warn",
          message: "Exec approval required before continuing",
          payload: {
            runId,
            approvalId: approval.id,
            kind: approval.kind,
            command: approval.command,
            host: approval.host ?? null,
            cwd: approval.cwd ?? null,
            expiresAt: approval.expiresAt ?? null,
          },
          createdAt: approvalTime,
        });
        sendJson(res, 200, {
          ok: true,
          status: "requires_approval",
          runId,
          traceId: traceId ?? nextSession.traceId,
          portalSessionId: portalSessionId ?? nextSession.portalSessionId,
          remoteSessionId,
          startedAt: runRecord.startedAt,
          endedAt: runRecord.endedAt,
          durationMs: runRecord.durationMs,
          reply,
          usage,
          mode: nextSession.mode,
          conversationView: nextSession.conversationView,
          runtimeRole: nextSession.runtimeRole,
          writePolicy: nextSession.writePolicy,
          agentVersionId: nextSession.agentVersionId,
          releaseId: nextSession.releaseId,
          releaseVersion: nextSession.releaseVersion,
          releaseStatus: nextSession.releaseStatus,
          timeline: runRecord.timeline,
          approval,
          candidateChanges,
          runtimeEvents: [runStartedEvent, approvalRequiredEvent],
        });
      } else {
        let persistedSession: PortalSessionRecord = {
          ...nextSession,
          turnCount: nextSession.turnCount + 1,
          historySummary: updatedHistorySummary,
        };
        if (shouldRolloverPortalSession({ session: persistedSession, usage })) {
          const nextRevision = persistedSession.sessionRevision + 1;
          persistedSession = {
            ...persistedSession,
            sessionRevision: nextRevision,
            sessionKey: buildPortalSessionKey({
              cfg,
              agentId: persistedSession.agentId,
              remoteSessionId,
              conversationView: persistedSession.conversationView,
              revision: nextRevision,
            }),
            turnCount: 0,
          };
        }
        portalSessions.set(remoteSessionId, persistedSession);
        const completedAt = new Date().toISOString();
        const runRecord = savePortalRun({
          runId,
          remoteSessionId,
          portalSessionId: portalSessionId ?? nextSession.portalSessionId,
          traceId: traceId ?? nextSession.traceId,
          status: "completed",
          startedAt: runStartedAt,
          endedAt: completedAt,
          durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(runStartedAt)),
          reply,
          usage,
          candidateChanges,
          timeline: appendPortalRunTimeline(portalRuns.get(runId), {
            phase: "completed",
            at: completedAt,
          }),
        });
        const runCompletedEvent = buildPortalRuntimeEvent({
          eventType: "run.completed",
          level: "info",
          message: `Portal run ${runId} completed`,
          payload: {
            runId,
            status: "completed",
            usage: usage ?? null,
          },
          createdAt: completedAt,
        });
        sendJson(res, 200, {
          ok: true,
          status: "completed",
          runId,
          traceId: traceId ?? nextSession.traceId,
          portalSessionId: portalSessionId ?? nextSession.portalSessionId,
          remoteSessionId,
          startedAt: runRecord.startedAt,
          endedAt: runRecord.endedAt,
          durationMs: runRecord.durationMs,
          reply,
          usage,
          mode: nextSession.mode,
          conversationView: nextSession.conversationView,
          runtimeRole: nextSession.runtimeRole,
          writePolicy: nextSession.writePolicy,
          agentVersionId: nextSession.agentVersionId,
          releaseId: nextSession.releaseId,
          releaseVersion: nextSession.releaseVersion,
          releaseStatus: nextSession.releaseStatus,
          timeline: runRecord.timeline,
          candidateChanges,
          runtimeEvents: [runStartedEvent, runCompletedEvent],
        });
      }
    } catch (error) {
      const failedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const runRecord = savePortalRun({
        runId,
        remoteSessionId,
        portalSessionId: portalSessionId ?? nextSession.portalSessionId,
        traceId: traceId ?? nextSession.traceId,
        status: "failed",
        startedAt: runStartedAt,
        endedAt: failedAt,
        durationMs: Math.max(0, Date.parse(failedAt) - Date.parse(runStartedAt)),
        error: {
          message,
        },
        timeline: appendPortalRunTimeline(portalRuns.get(runId), {
          phase: "failed",
          at: failedAt,
          error: message,
        }),
      });
      const runFailedEvent = buildPortalRuntimeEvent({
        eventType: "run.failed",
        level: "error",
        message: `Portal run ${runId} failed`,
        payload: {
          runId,
          code: "PORTAL_RUN_FAILED",
          error: message,
        },
        createdAt: failedAt,
      });
      sendJson(res, 500, {
        ok: false,
        error: message,
        code: "PORTAL_RUN_FAILED",
        status: "failed",
        runId,
        traceId: traceId ?? nextSession.traceId,
        portalSessionId: portalSessionId ?? nextSession.portalSessionId,
        remoteSessionId,
        startedAt: runRecord.startedAt,
        endedAt: runRecord.endedAt,
        durationMs: runRecord.durationMs,
        timeline: runRecord.timeline,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        runtimeEvents: [runStartedEvent, runFailedEvent],
      });
    }
    return true;
  }

  const portalRunMatch = url.pathname.match(
    new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/portal/runs/([^/]+)$`),
  );
  if (portalRunMatch) {
    if (!ensureMethod(req, res, "GET")) {
      return true;
    }
    const runId = portalRunMatch[1] ?? "";
    const run = portalRuns.get(runId);
    if (!run) {
      sendJson(res, 404, { ok: false, error: "run not found", runId });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      ...run,
    });
    return true;
  }

  const portalApprovalDecisionMatch = url.pathname.match(
    new RegExp(
      `^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/portal/sessions/([^/]+)/approvals/([^/]+)/decision$`,
    ),
  );
  if (portalApprovalDecisionMatch) {
    if (!ensureMethod(req, res, "POST")) {
      return true;
    }
    const remoteSessionId = portalApprovalDecisionMatch[1];
    const approvalId = portalApprovalDecisionMatch[2];
    const session = portalSessions.get(remoteSessionId);
    if (!session) {
      sendJson(res, 404, {
        ok: false,
        error: "session not found",
        remoteSessionId,
      });
      return true;
    }
    if (session.mode !== "training") {
      sendJson(res, 403, {
        ok: false,
        error: "exec approvals can only be resolved for training-mode portal sessions",
        mode: session.mode,
      });
      return true;
    }
    const body = await readBody(req);
    const decisionRaw = typeof body.decision === "string" ? body.decision.trim().toLowerCase() : "";
    if (decisionRaw !== "allow-once" && decisionRaw !== "allow-always" && decisionRaw !== "deny") {
      sendJson(res, 400, { ok: false, error: "invalid decision" });
      return true;
    }
    const manager = getGlobalExecApprovalManager();
    if (!manager) {
      sendJson(res, 503, { ok: false, error: "exec approvals unavailable" });
      return true;
    }
    const snapshot = manager.getSnapshot(approvalId);
    if (!snapshot) {
      sendJson(res, 400, { ok: false, error: "approval expired" });
      return true;
    }
    const requestSessionKey =
      snapshot.request.sessionKey ?? snapshot.request.systemRunBinding?.sessionKey ?? null;
    if (requestSessionKey && requestSessionKey !== session.sessionKey) {
      sendJson(res, 403, {
        ok: false,
        error: "approval does not belong to this portal session",
      });
      return true;
    }
    if (snapshot.resolvedAtMs !== undefined) {
      sendJson(res, 400, { ok: false, error: "approval expired" });
      return true;
    }
    const resolvedBy = "portal.control-plane";
    const okResolve = manager.resolve(approvalId, decisionRaw as ExecApprovalDecision, resolvedBy);
    if (!okResolve) {
      sendJson(res, 400, { ok: false, error: "approval expired" });
      return true;
    }
    const broadcast = getGlobalExecApprovalBroadcast();
    const forwarder = getGlobalExecApprovalForwarder();
    const ts = Date.now();
    const lastRunId = session.lastRunId;
    const existingRun = lastRunId ? portalRuns.get(lastRunId) : undefined;
    const resolvedAt = new Date(ts).toISOString();
    const updatedRun =
      lastRunId && existingRun
        ? savePortalRun({
            ...existingRun,
            status: "approval_applied",
            timeline: appendPortalRunTimeline(existingRun, {
              phase: "approval_applied",
              at: resolvedAt,
            }),
          })
        : undefined;
    const approvalAppliedEvent = buildPortalRuntimeEvent({
      eventType: "approval.applied",
      level: decisionRaw === "deny" ? "warn" : "info",
      message: `审批已处理：${decisionRaw}`,
      payload: {
        runId: lastRunId ?? null,
        approvalId,
        decision: decisionRaw,
      },
      createdAt: resolvedAt,
    });
    if (isSseRequest(req)) {
      setSseHeaders(res);
      let streamClosed = false;
      let unsubscribe = () => {};
      const streamedRuntimeEvents: PortalRuntimeEventWire[] = [approvalAppliedEvent];
      const bufferedDeltas: string[] = [];
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };
      const finishStream = (kind: "complete" | "error", override?: Record<string, unknown>) => {
        if (streamClosed) {
          return;
        }
        streamClosed = true;
        clearIdleTimer();
        unsubscribe();
        const currentRun = lastRunId ? (portalRuns.get(lastRunId) ?? updatedRun) : updatedRun;
        const continuedReply = bufferedDeltas.join("");
        const priorReply = currentRun?.reply ?? existingRun?.reply ?? "";
        const combinedReply =
          continuedReply.trim().length > 0
            ? [priorReply, continuedReply].filter(Boolean).join("\n\n").trim()
            : priorReply || undefined;
        const payload = {
          decision: decisionRaw,
          status:
            override?.status ??
            (kind === "error"
              ? "failed"
              : combinedReply || currentRun?.status === "completed"
                ? "completed"
                : "applied"),
          runId: lastRunId ?? null,
          traceId: session.traceId,
          remoteSessionId,
          portalSessionId: session.portalSessionId ?? null,
          startedAt: currentRun?.startedAt,
          endedAt: currentRun?.endedAt ?? resolvedAt,
          durationMs: currentRun?.durationMs,
          reply: combinedReply ?? "",
          usage: currentRun?.usage,
          timeline: currentRun?.timeline,
          runtimeEvents: streamedRuntimeEvents,
          ...override,
        };
        writePortalStreamEvent(
          res,
          kind === "error" ? "message.error" : "message.complete",
          payload,
        );
        writeDone(res);
        res.end();
      };
      const touchIdleTimer = () => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          finishStream("complete");
        }, 15000);
      };
      req.on("close", () => {
        streamClosed = true;
        clearIdleTimer();
        unsubscribe();
      });
      if (lastRunId) {
        unsubscribe = onAgentEvent((evt) => {
          if (streamClosed || evt.runId !== lastRunId) {
            return;
          }
          touchIdleTimer();
          if (evt.stream === "assistant") {
            const delta = resolveAssistantStreamDeltaText(evt);
            if (!delta) {
              return;
            }
            bufferedDeltas.push(delta);
            writePortalStreamEvent(res, "assistant.delta", {
              runId: lastRunId,
              traceId: session.traceId ?? null,
              delta,
              seq: evt.seq,
              createdAt: new Date(evt.ts).toISOString(),
            });
            return;
          }
          const runtimeEvent = buildPortalRuntimeEventFromAgentEvent(evt);
          if (runtimeEvent) {
            streamedRuntimeEvents.push(runtimeEvent);
            writePortalStreamEvent(res, "runtime.event", runtimeEvent);
          }
          if (evt.stream === "lifecycle" && typeof evt.data?.phase === "string") {
            const lifecyclePhase = evt.data.phase;
            if (lifecyclePhase === "end" || lifecyclePhase === "error") {
              const current = portalRuns.get(lastRunId) ?? updatedRun ?? existingRun;
              if (current) {
                const endedAt = new Date(evt.ts).toISOString();
                const nextRun = savePortalRun({
                  ...current,
                  status: lifecyclePhase === "error" ? "failed" : "completed",
                  endedAt,
                  durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(current.startedAt)),
                  reply:
                    [current.reply, bufferedDeltas.join("")]
                      .filter((part) => typeof part === "string" && part.trim().length > 0)
                      .join("\n\n") || current.reply,
                  timeline: appendPortalRunTimeline(current, {
                    phase: lifecyclePhase === "error" ? "failed" : "completed",
                    at: endedAt,
                    error:
                      lifecyclePhase === "error" && typeof evt.data?.error === "string"
                        ? evt.data.error
                        : undefined,
                  }),
                });
                portalRuns.set(lastRunId, nextRun);
              }
              finishStream(
                lifecyclePhase === "error" ? "error" : "complete",
                lifecyclePhase === "error"
                  ? {
                      code: "PORTAL_RUN_FAILED",
                      message:
                        typeof evt.data?.error === "string" ? evt.data.error : "审批后续执行失败",
                    }
                  : undefined,
              );
            }
          }
        });
      }
      writePortalStreamEvent(res, "runtime.event", approvalAppliedEvent);
      if (decisionRaw === "deny" || !lastRunId) {
        finishStream("complete", {
          status: decisionRaw === "deny" ? "denied" : "applied",
          timeline: updatedRun?.timeline,
        });
      } else {
        touchIdleTimer();
      }
    }
    if (broadcast) {
      broadcast(
        "exec.approval.resolved",
        {
          id: approvalId,
          decision: decisionRaw,
          resolvedBy,
          ts,
          request: snapshot.request,
        },
        { dropIfSlow: true },
      );
    }
    if (forwarder) {
      void forwarder
        .handleResolved({
          id: approvalId,
          decision: decisionRaw as ExecApprovalDecision,
          resolvedBy,
          ts,
          request: snapshot.request,
        })
        .catch((err) => {
          defaultRuntime.log(
            `[control-plane] exec approvals: forward resolve failed: ${String(err)}`,
          );
        });
    }
    if (isSseRequest(req)) {
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      runId: lastRunId,
      traceId: session.traceId,
      remoteSessionId,
      portalSessionId: session.portalSessionId,
      status: "applied",
      timeline: updatedRun?.timeline,
    });
    return true;
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}
