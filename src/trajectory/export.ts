import fsp from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeDiagnosticPayload } from "../agents/payload-redaction.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import {
  isSessionFileEntry,
  parseSessionFileEntriesWithWarnings,
} from "../agents/sessions/session-file-parser.js";
import type { FileEntry, SessionEntry, SessionHeader } from "../agents/sessions/session-manager.js";
import { resolveStateDir } from "../config/paths.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import {
  isCanonicalSessionTranscriptEntry,
  scanSessionTranscriptTree,
} from "../config/sessions/transcript-tree.js";
import {
  jsonSupportBundleFile,
  jsonlSupportBundleFile,
  supportBundleContents,
  textSupportBundleFile,
  writeSupportBundleDirectory,
  type DiagnosticSupportBundleFile,
} from "../logging/diagnostic-support-bundle.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { redactSecrets, redactToolPayloadText } from "../logging/redact.js";
import {
  hasMeaningfulRetiredMediaCarrier,
  PERSISTED_LEGACY_MEDIA_KEYS,
} from "../media/media-facts.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { TRAJECTORY_RUNTIME_FILE_MAX_BYTES, safeTrajectorySessionFileName } from "./paths.js";
import { loadSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import type {
  TrajectoryBundleManifest,
  TrajectoryBundleWarning,
  TrajectoryEvent,
  TrajectoryToolDefinition,
} from "./types.js";

// Trajectory bundle exporter: joins persisted session JSONL with runtime
// trace JSONL, redacts local/support-sensitive data, and writes a portable
// support bundle for debugging agent behavior.
type BuildTrajectoryBundleParams = {
  outputDir: string;
  sessionFile?: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  systemPrompt?: string;
  tools?: TrajectoryToolDefinition[];
  maxTotalEvents?: number;
};

type JsonRecord = Record<string, unknown>;
type TrajectoryExportRedaction = SupportRedactionContext & {
  workspaceDir: string;
};

type JsonlParseWarning = Omit<TrajectoryBundleWarning, "count" | "rows"> & {
  row: number;
};

const MAX_TRAJECTORY_RUNTIME_EVENTS = 200_000;
const MAX_TRAJECTORY_TOTAL_EVENTS = 250_000;
const MAX_TRAJECTORY_SESSION_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TRAJECTORY_WARNING_ROWS = 20;

function normalizeCompleteSessionTarget(
  target: SessionTranscriptRuntimeTarget | undefined,
): SessionTranscriptRuntimeTarget | undefined {
  if (!target) {
    return undefined;
  }
  const agentId = normalizeOptionalString(target.agentId);
  const sessionId = normalizeOptionalString(target.sessionId);
  const sessionKey = normalizeOptionalString(target.sessionKey);
  const storePath = normalizeOptionalString(target.storePath);
  return agentId && sessionId && sessionKey && storePath
    ? { agentId, sessionId, sessionKey, storePath }
    : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatSessionParseWarnings(
  warnings: ReturnType<typeof parseSessionFileEntriesWithWarnings>["warnings"],
): JsonlParseWarning[] {
  return warnings.map((warning) => ({
    source: "session",
    code: warning.code,
    row: warning.row,
    message:
      warning.code === "invalid-session-json"
        ? "Skipped a session JSONL row that is not valid JSON."
        : "Skipped a session JSONL row that is not a session entry object.",
  }));
}

function collectSessionEntries(rows: readonly unknown[]) {
  const entries: FileEntry[] = [];
  const warnings: JsonlParseWarning[] = [];
  const rowByEntry = new Map<FileEntry, number>();
  for (const [index, value] of rows.entries()) {
    if (!isSessionFileEntry(value)) {
      warnings.push({
        source: "session",
        code: "invalid-session-row",
        row: index + 1,
        message: "Skipped a session JSONL row that is not a session entry object.",
      });
      continue;
    }
    entries.push(value);
    rowByEntry.set(value, index + 1);
  }
  return { entries, warnings, rowByEntry };
}

async function readSessionEntries(params: {
  sessionFile?: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  sessionId: string;
  sessionKey?: string;
}) {
  const completeTarget = normalizeCompleteSessionTarget(params.sessionTarget);
  if (completeTarget) {
    const targetKeyAgentId = parseAgentSessionKey(completeTarget.sessionKey)?.agentId;
    const targetKeyEntry = loadSessionEntryReadOnly({
      agentId: completeTarget.agentId,
      sessionKey: completeTarget.sessionKey,
      storePath: completeTarget.storePath,
    });
    // Export remains available after the session index row is pruned. A row
    // that still exists must agree with the artifact's complete target.
    if (
      completeTarget.sessionId !== params.sessionId ||
      (params.sessionKey !== undefined && completeTarget.sessionKey !== params.sessionKey) ||
      (targetKeyAgentId && targetKeyAgentId !== completeTarget.agentId) ||
      (targetKeyEntry && targetKeyEntry.sessionId !== completeTarget.sessionId)
    ) {
      throw new Error("Trajectory export transcript target does not match the requested session");
    }
    const events = await loadTranscriptEvents({
      agentId: completeTarget.agentId,
      sessionId: completeTarget.sessionId,
      sessionKey: completeTarget.sessionKey,
      storePath: completeTarget.storePath,
      maxEventBytes: MAX_TRAJECTORY_SESSION_FILE_BYTES,
    });
    return collectSessionEntries(events);
  }
  const incompleteTarget = params.sessionTarget
    ? {
        agentId: normalizeOptionalString(params.sessionTarget.agentId),
        sessionId: normalizeOptionalString(params.sessionTarget.sessionId),
        sessionKey: normalizeOptionalString(params.sessionTarget.sessionKey),
        storePath: normalizeOptionalString(params.sessionTarget.storePath),
      }
    : undefined;
  if (!params.sessionFile) {
    throw new Error("Trajectory export requires a transcript identity or artifact file");
  }
  const marker = parseSqliteSessionFileMarker(params.sessionFile);
  if (!marker) {
    const { entries, warnings, rowByEntry } = parseSessionFileEntriesWithWarnings(
      await fsp.readFile(params.sessionFile, "utf8"),
    );
    return {
      entries,
      warnings: formatSessionParseWarnings(warnings),
      rowByEntry,
    };
  }
  if (marker.sessionId !== params.sessionId) {
    throw new Error("Trajectory export legacy marker does not match the requested session");
  }
  const targetKeyAgentId = parseAgentSessionKey(incompleteTarget?.sessionKey)?.agentId;
  const targetKeyEntry = incompleteTarget?.sessionKey
    ? loadSessionEntryReadOnly({
        agentId: marker.agentId,
        sessionKey: incompleteTarget.sessionKey,
        storePath: marker.storePath,
      })
    : undefined;
  if (
    incompleteTarget &&
    ((incompleteTarget.agentId && incompleteTarget.agentId !== marker.agentId) ||
      (incompleteTarget.sessionId && incompleteTarget.sessionId !== marker.sessionId) ||
      (targetKeyAgentId && targetKeyAgentId !== marker.agentId) ||
      (incompleteTarget.sessionKey && targetKeyEntry?.sessionId !== marker.sessionId) ||
      (incompleteTarget.storePath &&
        path.resolve(incompleteTarget.storePath) !== path.resolve(marker.storePath)))
  ) {
    throw new Error("Trajectory export transcript target conflicts with the legacy marker");
  }
  const suppliedKeyEntry = params.sessionKey
    ? loadSessionEntryReadOnly({
        agentId: marker.agentId,
        sessionKey: params.sessionKey,
        storePath: marker.storePath,
      })
    : undefined;
  const markerMatches = listSessionEntriesReadOnly({
    agentId: marker.agentId,
    storePath: marker.storePath,
  }).filter(({ entry }) => entry.sessionId === marker.sessionId);
  if (suppliedKeyEntry && suppliedKeyEntry.sessionId !== marker.sessionId) {
    throw new Error("Trajectory export session key conflicts with the legacy marker");
  }
  if (params.sessionKey && !suppliedKeyEntry && markerMatches.length > 0) {
    throw new Error("Trajectory export session key is not mapped to the legacy marker");
  }
  const markerSessionKey = suppliedKeyEntry
    ? params.sessionKey
    : (resolvePreferredSessionKeyForSessionIdMatches(
        markerMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
        marker.sessionId,
      ) ?? (markerMatches.length === 0 ? params.sessionKey : undefined));
  if (!markerSessionKey && markerMatches.length > 0) {
    throw new Error("Trajectory export legacy marker session key is ambiguous");
  }
  return collectSessionEntries(
    await loadTranscriptEvents({
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      ...(markerSessionKey ? { sessionKey: markerSessionKey } : {}),
      storePath: marker.storePath,
      maxEventBytes: MAX_TRAJECTORY_SESSION_FILE_BYTES,
    }),
  );
}

async function readSessionBranch(params: Parameters<typeof readSessionEntries>[0]) {
  const { entries: fileEntries, warnings, rowByEntry } = await readSessionEntries(params);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = fileEntries.filter(
    (entry): entry is SessionEntry =>
      entry.type !== "session" &&
      isCanonicalSessionTranscriptEntry(entry) &&
      typeof (entry as { id?: unknown }).id === "string",
  );
  const tree = scanSessionTranscriptTree(fileEntries);
  if (!tree.hasLeafUpdate) {
    return {
      header,
      leafId: entries.at(-1)?.id ?? null,
      branchEntries: entries,
      warnings,
    };
  }
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const branchEntries: SessionEntry[] = [];
  const seen = new Set<string>();
  let descendantEntry: SessionEntry | undefined;
  let currentId = tree.leafId;
  while (currentId) {
    if (seen.has(currentId)) {
      const cycleEntry = tree.byId.get(currentId)?.entry;
      warnings.push({
        source: "session",
        code: "cyclic-session-branch",
        row: cycleEntry ? (rowByEntry.get(cycleEntry) ?? 0) : 0,
        message: "Stopped trajectory session branch export at a cyclic parent link.",
      });
      break;
    }
    seen.add(currentId);
    const current = tree.byId.get(currentId);
    if (!current) {
      warnings.push({
        source: "session",
        code: "incomplete-session-branch",
        row: 0,
        message: "Exported the reachable session branch suffix after a missing parent link.",
      });
      break;
    }
    const visibleEntry = entriesById.get(currentId);
    if (visibleEntry) {
      const normalizedEntry = { ...visibleEntry, parentId: current.parentId };
      if (descendantEntry) {
        descendantEntry.parentId = normalizedEntry.id;
      }
      branchEntries.unshift(normalizedEntry);
      descendantEntry = normalizedEntry;
    }
    if (current.parentId && !tree.byId.has(current.parentId)) {
      warnings.push({
        source: "session",
        code: "incomplete-session-branch",
        row: rowByEntry.get(current.entry) ?? 0,
        message: "Exported the reachable session branch suffix after a missing parent link.",
      });
      break;
    }
    currentId = current.parentId;
  }
  return { header, leafId: tree.leafId, branchEntries, warnings };
}

async function readRuntimeTrajectoryEvents(params: {
  sessionFile?: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  sessionId: string;
}): Promise<TrajectoryEvent[]> {
  const marker =
    normalizeCompleteSessionTarget(params.sessionTarget) ??
    parseSqliteSessionFileMarker(params.sessionFile);
  if (marker && marker.sessionId !== params.sessionId) {
    throw new Error("Trajectory runtime target does not match the requested session");
  }
  return marker
    ? await loadSqliteTrajectoryRuntimeEvents({
        agentId: marker.agentId,
        sessionId: marker.sessionId,
        storePath: marker.storePath,
        maxEventBytes: TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
        maxEventCount: MAX_TRAJECTORY_RUNTIME_EVENTS,
      })
    : [];
}

function summarizeJsonlWarnings(warnings: JsonlParseWarning[]): TrajectoryBundleWarning[] {
  const byKey = new Map<string, TrajectoryBundleWarning>();
  for (const warning of warnings) {
    const key = `${warning.source}:${warning.code}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.rows.length < MAX_TRAJECTORY_WARNING_ROWS) {
        existing.rows.push(warning.row);
      }
      continue;
    }
    byKey.set(key, {
      source: warning.source,
      code: warning.code,
      count: 1,
      rows: [warning.row],
      message: warning.message,
    });
  }
  return [...byKey.values()];
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date(0).toISOString();
}

function resolveMessageEventType(message: AgentMessage): string {
  if (message.role === "user") {
    return "user.message";
  }
  if (message.role === "assistant") {
    return "assistant.message";
  }
  if (message.role === "toolResult") {
    return "tool.result";
  }
  return `message.${message.role}`;
}

function extractAssistantToolCalls(
  message: AgentMessage,
): Array<{ id?: string; name?: string; arguments?: unknown; index: number }> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((block, index) => {
    if (!block || typeof block !== "object") {
      return [];
    }
    const typedBlock = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
      input?: unknown;
      parameters?: unknown;
    };
    const blockType =
      typeof typedBlock.type === "string" ? typedBlock.type.trim().toLowerCase() : "";
    if (blockType !== "toolcall" && blockType !== "tooluse" && blockType !== "functioncall") {
      return [];
    }
    return [
      {
        id: typeof typedBlock.id === "string" ? typedBlock.id : undefined,
        name: typeof typedBlock.name === "string" ? typedBlock.name : undefined,
        arguments: typedBlock.arguments ?? typedBlock.input ?? typedBlock.parameters,
        index,
      },
    ];
  });
}

function buildTranscriptEvents(params: {
  entries: SessionEntry[];
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  traceId: string;
}): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [];
  let seq = 0;
  for (const entry of params.entries) {
    const push = (type: string, data?: Record<string, unknown>) => {
      events.push({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: params.traceId,
        source: "transcript",
        type,
        ts: normalizeTimestamp(entry.timestamp),
        seq: 0,
        sourceSeq: (seq += 1),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        entryId: entry.id,
        parentEntryId: entry.parentId,
        data,
      });
    };

    switch (entry.type) {
      case "message": {
        push(resolveMessageEventType(entry.message), {
          message: sanitizeDiagnosticPayload(entry.message),
        });
        for (const toolCall of extractAssistantToolCalls(entry.message)) {
          push("tool.call", {
            toolCallId: toolCall.id,
            name: toolCall.name,
            arguments: sanitizeDiagnosticPayload(toolCall.arguments),
            assistantEntryId: entry.id,
            blockIndex: toolCall.index,
          });
        }
        break;
      }
      case "compaction":
        push("session.compaction", {
          summary: entry.summary,
          firstKeptEntryId: entry.firstKeptEntryId,
          tokensBefore: entry.tokensBefore,
          details: sanitizeDiagnosticPayload(entry.details),
          fromHook: entry.fromHook ?? false,
        });
        break;
      case "reset":
        push("session.reset", {
          reason: entry.reason,
          firstKeptEntryId: entry.firstKeptEntryId,
        });
        break;
      case "branch_summary":
        push("session.branch_summary", {
          fromId: entry.fromId,
          summary: entry.summary,
          details: sanitizeDiagnosticPayload(entry.details),
          fromHook: entry.fromHook ?? false,
        });
        break;
      case "custom":
        push("session.custom", {
          customType: entry.customType,
          data: sanitizeDiagnosticPayload(entry.data),
        });
        break;
      case "custom_message":
        push("session.custom_message", {
          customType: entry.customType,
          content: sanitizeDiagnosticPayload(entry.content),
          details: sanitizeDiagnosticPayload(entry.details),
          display: entry.display,
        });
        break;
      case "thinking_level_change":
        push("session.thinking_level_change", {
          thinkingLevel: entry.thinkingLevel,
        });
        break;
      case "model_change":
        push("session.model_change", {
          provider: entry.provider,
          modelId: entry.modelId,
        });
        break;
      case "label":
        push("session.label", {
          targetId: entry.targetId,
          label: entry.label,
        });
        break;
      case "session_info":
        push("session.info", {
          name: entry.name,
        });
        break;
    }
  }
  return events;
}

function assertCanonicalTrajectoryInputs(
  entries: readonly SessionEntry[],
  runtimeEvents: readonly TrajectoryEvent[],
): void {
  const branchHasLegacy = entries.some(
    (entry) =>
      entry.type === "message" &&
      isRecord(entry.message) &&
      (Object.hasOwn(entry.message, "media") ||
        PERSISTED_LEGACY_MEDIA_KEYS.some((key) => Object.hasOwn(entry.message, key))),
  );
  const runtimeHasLegacy = runtimeEvents.some(
    (event) =>
      Array.isArray(event.data?.messagesSnapshot) &&
      event.data.messagesSnapshot.some(
        (message) => isRecord(message) && hasMeaningfulRetiredMediaCarrier(message),
      ),
  );
  if (branchHasLegacy || runtimeHasLegacy) {
    throw new Error(
      "Trajectory export input contains retired top-level media fields; migrate the source transcript before exporting.",
    );
  }
}

function sortTrajectoryEvents(events: TrajectoryEvent[]): TrajectoryEvent[] {
  const sourceOrder: Record<TrajectoryEvent["source"], number> = {
    runtime: 0,
    transcript: 1,
    export: 2,
  };
  const sorted = events.toSorted(
    (left, right) =>
      left.ts.localeCompare(right.ts) ||
      sourceOrder[left.source] - sourceOrder[right.source] ||
      (left.sourceSeq ?? left.seq) - (right.sourceSeq ?? right.seq),
  );
  for (const [index, event] of sorted.entries()) {
    event.seq = index + 1;
  }
  return sorted;
}

function trajectoryJsonlFile(
  pathName: string,
  events: TrajectoryEvent[],
): DiagnosticSupportBundleFile {
  const lines = events
    .map((event) => safeJsonStringify(event))
    .filter((line): line is string => Boolean(line));
  return jsonlSupportBundleFile(pathName, lines);
}

function redactTrajectoryBundleFileContent(
  file: DiagnosticSupportBundleFile,
): DiagnosticSupportBundleFile {
  return {
    ...file,
    content: redactToolPayloadText(file.content),
  };
}

function redactWorkspacePathString(value: string, redaction: TrajectoryExportRedaction): string {
  const workspaceDir = redaction.workspaceDir;
  if (!workspaceDir) {
    return value;
  }
  const normalizedWorkspaceDir = workspaceDir.replaceAll("\\", "/");
  let next = value;
  for (const candidate of new Set([workspaceDir, normalizedWorkspaceDir])) {
    if (!candidate) {
      continue;
    }
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    next = next.replace(new RegExp(`${escaped}(?=$|[\\\\/])`, "gu"), "$WORKSPACE_DIR");
  }
  return next;
}

function maybeRedactPathString(value: string, redaction: TrajectoryExportRedaction): string {
  const workspaceRedacted = redactWorkspacePathString(value, redaction);
  // Redact only strings that look path-like after workspace substitution. This
  // keeps ordinary model text readable while still removing local host details.
  if (
    workspaceRedacted !== value ||
    path.isAbsolute(workspaceRedacted) ||
    workspaceRedacted.includes(redaction.stateDir) ||
    (redaction.env.HOME ? workspaceRedacted.includes(redaction.env.HOME) : false) ||
    (redaction.env.USERPROFILE ? workspaceRedacted.includes(redaction.env.USERPROFILE) : false)
  ) {
    return redactSupportString(workspaceRedacted, redaction);
  }
  return workspaceRedacted;
}

function redactLocalPathValues(value: unknown, redaction: TrajectoryExportRedaction): unknown {
  if (typeof value === "string") {
    return maybeRedactPathString(value, redaction);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactLocalPathValues(entry, redaction));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    next[key] = redactLocalPathValues(entry, redaction);
  }
  return next;
}

function uniqueRedactedObjectKey(key: string, usedKeys: Set<string>): string {
  if (!usedKeys.has(key)) {
    usedKeys.add(key);
    return key;
  }
  let index = 2;
  while (usedKeys.has(`${key}#${index}`)) {
    index += 1;
  }
  const unique = `${key}#${index}`;
  usedKeys.add(unique);
  return unique;
}

function redactTrajectoryExportObjectKeys(
  value: unknown,
  redaction: TrajectoryExportRedaction,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactTrajectoryExportObjectKeys(entry, redaction));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const usedKeys = new Set<string>();
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const redactedKey = redactToolPayloadText(maybeRedactPathString(key, redaction));
    // Object keys can contain file paths or tool payload snippets too. Preserve
    // all entries even when redaction collapses two original keys together.
    next[uniqueRedactedObjectKey(redactedKey, usedKeys)] = redactTrajectoryExportObjectKeys(
      entry,
      redaction,
    );
  }
  return next;
}

function redactTrajectoryExportValue(
  value: unknown,
  redaction: TrajectoryExportRedaction,
): unknown {
  const redactedValue = redactSecrets(
    sanitizeDiagnosticPayload(redactLocalPathValues(value, redaction)),
  );
  return redactTrajectoryExportObjectKeys(redactedValue, redaction);
}

function resolveLatestRuntimeEventData(
  runtimeEvents: TrajectoryEvent[],
  type: string,
): JsonRecord | undefined {
  const event = runtimeEvents.findLast((candidate) => candidate.type === type);
  return event?.data;
}

function normalizePathForMatch(value: string): string {
  return value.replaceAll("\\", "/").trim().toLowerCase();
}

function collectPotentialPathStrings(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (input: unknown) => {
    if (!input || typeof input !== "object") {
      return;
    }
    if (Array.isArray(input)) {
      for (const entry of input) {
        visit(entry);
      }
      return;
    }
    for (const [key, entry] of Object.entries(input)) {
      if (
        typeof entry === "string" &&
        (key.toLowerCase().includes("path") ||
          entry.endsWith("SKILL.md") ||
          entry.endsWith("skill.md"))
      ) {
        found.add(entry);
      } else {
        visit(entry);
      }
    }
  };
  visit(value);
  return [...found];
}

function markInvokedSkills(params: { skills: unknown; events: TrajectoryEvent[] }): unknown {
  if (!params.skills || typeof params.skills !== "object") {
    return params.skills;
  }
  const skillsRecord = params.skills as {
    entries?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(skillsRecord.entries) || skillsRecord.entries.length === 0) {
    return params.skills;
  }
  // Skill invocation is inferred from tool-call file paths in captured prompts;
  // this keeps the export self-contained without re-reading skill state later.
  const normalizedInvokedPaths = new Set(
    params.events.flatMap((event) =>
      event.type === "tool.call"
        ? collectPotentialPathStrings(event.data?.arguments).map(normalizePathForMatch)
        : [],
    ),
  );
  const entries = skillsRecord.entries.map((entry) => {
    const rawPath = typeof entry.filePath === "string" ? entry.filePath : undefined;
    const normalizedPath = rawPath ? normalizePathForMatch(rawPath) : undefined;
    const skillDirName =
      rawPath?.replaceAll("\\", "/").split("/").slice(-2, -1)[0]?.toLowerCase() ?? undefined;
    const invoked = normalizedPath
      ? [...normalizedInvokedPaths].some(
          (candidate) =>
            candidate === normalizedPath ||
            candidate.endsWith(normalizedPath) ||
            (skillDirName ? candidate.endsWith(`/${skillDirName}/skill.md`) : false),
        )
      : false;
    return invoked
      ? {
          ...entry,
          invoked,
          invocationDetectedBy: "tool-call-file-path",
        }
      : {
          ...entry,
          invoked: false,
        };
  });
  return {
    ...skillsRecord,
    entries,
  };
}

function buildMetadataCapture(params: {
  manifest: TrajectoryBundleManifest;
  runtimeEvents: TrajectoryEvent[];
  events: TrajectoryEvent[];
}): JsonRecord | undefined {
  const runtimeMetadata = resolveLatestRuntimeEventData(params.runtimeEvents, "trace.metadata");
  if (!runtimeMetadata) {
    return undefined;
  }
  const latestModelEvent = params.runtimeEvents.findLast(
    (event) => event.provider || event.modelId || event.modelApi,
  );
  const modelFallback = latestModelEvent
    ? {
        provider: latestModelEvent.provider,
        name: latestModelEvent.modelId,
        api: latestModelEvent.modelApi,
      }
    : undefined;
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.manifest.traceId,
    sessionId: params.manifest.sessionId,
    sessionKey: params.manifest.sessionKey,
    harness: runtimeMetadata.harness,
    model: runtimeMetadata.model ?? modelFallback,
    config: runtimeMetadata.config,
    plugins: runtimeMetadata.plugins,
    skills: markInvokedSkills({
      skills: runtimeMetadata.skills,
      events: params.events,
    }),
    prompting: runtimeMetadata.prompting,
    redaction: runtimeMetadata.redaction,
    metadata: runtimeMetadata.metadata,
  };
}

function buildArtifactsCapture(params: {
  manifest: TrajectoryBundleManifest;
  runtimeEvents: TrajectoryEvent[];
}): JsonRecord | undefined {
  const cohortStart = params.runtimeEvents.findLastIndex(
    (event) => event.type === "session.started",
  );
  const latestTimedEnd =
    cohortStart < 0
      ? params.runtimeEvents
          .filter(
            (event) => event.type === "session.ended" && isFiniteNumber(event.data?.startedAt),
          )
          .toSorted((left, right) => Number(left.data?.startedAt) - Number(right.data?.startedAt))
          .at(-1)
      : undefined;
  const selectedEnd =
    latestTimedEnd ??
    (cohortStart < 0
      ? params.runtimeEvents.findLast((event) => event.type === "session.ended")
      : undefined);
  const cohortRunId =
    params.runtimeEvents[cohortStart]?.runId ??
    selectedEnd?.runId ??
    params.runtimeEvents.at(-1)?.runId;
  const cohortEnd = selectedEnd
    ? params.runtimeEvents.lastIndexOf(selectedEnd) + 1
    : params.runtimeEvents.length;
  const partialStart = selectedEnd
    ? params.runtimeEvents.findLastIndex(
        (event, index) =>
          index < cohortEnd - 1 && event.type === "session.ended" && event.runId === cohortRunId,
      ) + 1
    : cohortStart;
  // The newest start, or latest authoritative terminal in a partial tail, owns the cohort.
  const cohort = params.runtimeEvents
    .slice(Math.max(0, partialStart), cohortEnd)
    .filter((event) => cohortRunId === undefined || event.runId === cohortRunId);
  const runtimeArtifacts = resolveLatestRuntimeEventData(cohort, "trace.artifacts");
  const runtimeCompletion = resolveLatestRuntimeEventData(cohort, "model.completed");
  const runtimeEnd = resolveLatestRuntimeEventData(cohort, "session.ended");
  if (!runtimeArtifacts && !runtimeCompletion && !runtimeEnd) {
    return undefined;
  }
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.manifest.traceId,
    sessionId: params.manifest.sessionId,
    sessionKey: params.manifest.sessionKey,
    finalStatus: runtimeArtifacts?.finalStatus ?? runtimeEnd?.status,
    aborted: runtimeArtifacts?.aborted ?? runtimeEnd?.aborted,
    externalAbort: runtimeArtifacts?.externalAbort ?? runtimeEnd?.externalAbort,
    timedOut: runtimeArtifacts?.timedOut ?? runtimeEnd?.timedOut,
    idleTimedOut: runtimeArtifacts?.idleTimedOut ?? runtimeEnd?.idleTimedOut,
    timedOutDuringCompaction:
      runtimeArtifacts?.timedOutDuringCompaction ?? runtimeEnd?.timedOutDuringCompaction,
    timedOutDuringToolExecution:
      runtimeArtifacts?.timedOutDuringToolExecution ?? runtimeEnd?.timedOutDuringToolExecution,
    timedOutByRunBudget: runtimeArtifacts?.timedOutByRunBudget ?? runtimeEnd?.timedOutByRunBudget,
    promptError:
      runtimeArtifacts?.promptError ?? runtimeEnd?.promptError ?? runtimeCompletion?.promptError,
    promptErrorSource: runtimeArtifacts?.promptErrorSource ?? runtimeCompletion?.promptErrorSource,
    terminalError:
      runtimeArtifacts?.terminalError ??
      runtimeEnd?.terminalError ??
      runtimeCompletion?.terminalError,
    usage: runtimeArtifacts?.usage ?? runtimeCompletion?.usage,
    promptCache: runtimeArtifacts?.promptCache ?? runtimeCompletion?.promptCache,
    compactionCount: runtimeArtifacts?.compactionCount ?? runtimeCompletion?.compactionCount,
    assistantTexts: runtimeArtifacts?.assistantTexts ?? runtimeCompletion?.assistantTexts,
    stopReason:
      runtimeArtifacts?.stopReason ?? runtimeCompletion?.stopReason ?? runtimeEnd?.stopReason,
    finalPromptText: runtimeArtifacts?.finalPromptText ?? runtimeCompletion?.finalPromptText,
    finalPromptTextOriginalLength:
      runtimeArtifacts?.finalPromptTextOriginalLength ??
      runtimeCompletion?.finalPromptTextOriginalLength,
    itemLifecycle: runtimeArtifacts?.itemLifecycle,
    toolMetas: runtimeArtifacts?.toolMetas,
    didSendViaMessagingTool: runtimeArtifacts?.didSendViaMessagingTool,
    successfulCronAdds: runtimeArtifacts?.successfulCronAdds,
    messagingToolSentTexts: runtimeArtifacts?.messagingToolSentTexts,
    messagingToolSentMediaUrls: runtimeArtifacts?.messagingToolSentMediaUrls,
    messagingToolSentTargets: runtimeArtifacts?.messagingToolSentTargets,
    lastToolError: runtimeArtifacts?.lastToolError,
  };
}

function buildPromptsCapture(params: {
  manifest: TrajectoryBundleManifest;
  runtimeEvents: TrajectoryEvent[];
  systemPrompt: string | undefined;
}): JsonRecord | undefined {
  const runtimeMetadata = resolveLatestRuntimeEventData(params.runtimeEvents, "trace.metadata");
  const submittedPrompts = params.runtimeEvents
    .filter((event) => event.type === "prompt.submitted")
    .map((event) => event.data?.prompt)
    .filter((prompt): prompt is string => typeof prompt === "string");
  const systemPrompt = params.systemPrompt;
  const prompting =
    runtimeMetadata?.prompting && typeof runtimeMetadata.prompting === "object"
      ? (runtimeMetadata.prompting as JsonRecord)
      : undefined;
  const skillsPrompt =
    typeof prompting?.skillsPrompt === "string" ? prompting.skillsPrompt : undefined;
  const userPromptPrefixText =
    typeof prompting?.userPromptPrefixText === "string"
      ? prompting.userPromptPrefixText
      : undefined;
  const promptReport =
    typeof prompting?.systemPromptReport === "object" ? prompting.systemPromptReport : undefined;
  if (!systemPrompt && submittedPrompts.length === 0 && !skillsPrompt && !userPromptPrefixText) {
    return undefined;
  }
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.manifest.traceId,
    sessionId: params.manifest.sessionId,
    sessionKey: params.manifest.sessionKey,
    system: systemPrompt,
    submittedPrompts,
    latestSubmittedPrompt: submittedPrompts.at(-1),
    skillsPrompt,
    userPromptPrefixText,
    systemPromptReport: promptReport,
  };
}

export function resolveDefaultTrajectoryExportDir(params: {
  workspaceDir: string;
  sessionId: string;
  now?: Date;
}): string {
  const timestamp = (params.now ?? new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sessionFileName = safeTrajectorySessionFileName(params.sessionId);
  return path.join(
    params.workspaceDir,
    ".openclaw",
    "trajectory-exports",
    `openclaw-trajectory-${sessionFileName.slice(0, 8)}-${timestamp}`,
  );
}

// Public export API used by CLI/tests. The bundle is intentionally sanitized
// before writing so sharing it should not expose credentials or local paths.
export async function exportTrajectoryBundle(params: BuildTrajectoryBundleParams) {
  const env = process.env;
  const redaction: TrajectoryExportRedaction = {
    env,
    stateDir: resolveStateDir(env),
    workspaceDir: path.resolve(params.workspaceDir),
  };
  const sessionTarget = normalizeCompleteSessionTarget(params.sessionTarget);
  if (params.sessionFile && !sessionTarget && !parseSqliteSessionFileMarker(params.sessionFile)) {
    const sessionStat = await fsp.stat(params.sessionFile);
    if (sessionStat.size > MAX_TRAJECTORY_SESSION_FILE_BYTES) {
      throw new Error(
        `Trajectory session file is too large to export (${sessionStat.size} bytes; limit ${MAX_TRAJECTORY_SESSION_FILE_BYTES})`,
      );
    }
  }

  const {
    header,
    leafId,
    branchEntries,
    warnings: sessionWarnings,
  } = await readSessionBranch({
    sessionFile: params.sessionFile,
    sessionTarget: params.sessionTarget,
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
  const runtimeEvents = await readRuntimeTrajectoryEvents({
    sessionFile: params.sessionFile,
    sessionTarget,
    sessionId: params.sessionId,
  });
  assertCanonicalTrajectoryInputs(branchEntries, runtimeEvents);
  const transcriptEvents = buildTranscriptEvents({
    entries: branchEntries,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    traceId: params.sessionId,
  });
  const maxTotalEvents = params.maxTotalEvents ?? MAX_TRAJECTORY_TOTAL_EVENTS;
  const totalEventCount = runtimeEvents.length + transcriptEvents.length;
  if (totalEventCount > maxTotalEvents) {
    throw new Error(
      `Trajectory export has too many events (${totalEventCount}; limit ${maxTotalEvents})`,
    );
  }
  const rawEvents = sortTrajectoryEvents([...runtimeEvents, ...transcriptEvents]);
  const events = rawEvents.map(
    (event) => redactTrajectoryExportValue(event, redaction) as TrajectoryEvent,
  );
  const manifest: TrajectoryBundleManifest = {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    traceId: params.sessionId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: maybeRedactPathString(params.workspaceDir, redaction),
    leafId,
    eventCount: events.length,
    runtimeEventCount: runtimeEvents.length,
    transcriptEventCount: transcriptEvents.length,
    sourceFiles: {
      session: maybeRedactPathString(
        sessionTarget?.sessionKey ?? params.sessionFile ?? params.sessionId,
        redaction,
      ),
    },
  };
  const warnings = summarizeJsonlWarnings(sessionWarnings);
  if (warnings.length > 0) {
    manifest.warnings = warnings;
  }

  const compiledContext = resolveLatestRuntimeEventData(runtimeEvents, "context.compiled");
  const systemPrompt =
    typeof compiledContext?.systemPrompt === "string" ? compiledContext.systemPrompt : undefined;
  const tools = Array.isArray(compiledContext?.tools) ? compiledContext.tools : undefined;
  const files: DiagnosticSupportBundleFile[] = [];
  const supplementalFiles: string[] = [];
  const captures = {
    "metadata.json": buildMetadataCapture({ manifest, runtimeEvents, events: rawEvents }),
    "artifacts.json": buildArtifactsCapture({ manifest, runtimeEvents }),
    "prompts.json": buildPromptsCapture({
      manifest,
      runtimeEvents,
      systemPrompt,
    }),
  };
  for (const [fileName, capture] of Object.entries(captures)) {
    if (!capture) {
      continue;
    }
    files.push(jsonSupportBundleFile(fileName, redactTrajectoryExportValue(capture, redaction)));
    supplementalFiles.push(fileName);
  }
  if (supplementalFiles.length > 0) {
    manifest.supplementalFiles = supplementalFiles;
  }

  files.push(trajectoryJsonlFile("events.jsonl", events));
  files.push(
    jsonSupportBundleFile(
      "session-branch.json",
      redactTrajectoryExportValue(
        {
          header,
          leafId,
          entries: branchEntries,
        },
        redaction,
      ),
    ),
  );
  if (systemPrompt) {
    files.push(
      textSupportBundleFile(
        "system-prompt.txt",
        redactTrajectoryExportValue(systemPrompt, redaction) as string,
      ),
    );
  }
  if (tools) {
    files.push(jsonSupportBundleFile("tools.json", redactTrajectoryExportValue(tools, redaction)));
  }

  const redactedFiles = files.map(redactTrajectoryBundleFileContent);
  manifest.contents = supportBundleContents(redactedFiles);
  const redactedManifest = redactTrajectoryExportValue(
    manifest,
    redaction,
  ) as TrajectoryBundleManifest;
  const manifestFile = redactTrajectoryBundleFileContent(
    jsonSupportBundleFile("manifest.json", redactedManifest),
  );

  const writtenFiles = await writeSupportBundleDirectory({
    outputDir: params.outputDir,
    files: [manifestFile, ...redactedFiles],
  });

  return {
    manifest: redactedManifest,
    outputDir: params.outputDir,
    events,
    header,
    supplementalFiles,
    files: writtenFiles.map((file) => file.path),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
