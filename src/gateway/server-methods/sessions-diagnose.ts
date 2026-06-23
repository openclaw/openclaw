// Read-only session diagnosis for stuck or ambiguous session state.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsDiagnoseParams,
  type SessionsDiagnoseResult,
  validateSessionsDiagnoseParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { getEmbeddedRunDiagnosticSnapshot } from "../../agents/embedded-agent-runner/run-state.js";
import { isTerminalSessionStatus, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { getDiagnosticSessionStateSnapshot } from "../../logging/diagnostic-session-state.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveStoredSessionOwnerAgentId } from "../session-store-key.js";
import { readRecentSessionMessagesWithStatsAsync } from "../session-transcript-readers.js";
import { loadCombinedSessionStoreForGateway } from "../session-utils.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-create-service.js";
import {
  collectTrackedActiveSessionRuns,
  collectTrackedActiveSessionRunSnapshot,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";
import { loadSessionEntriesForTarget } from "./sessions-shared.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_DIAGNOSE_TAIL = 30;
const DEFAULT_DIAGNOSE_SCAN_LIMIT = 100;
const FRESH_PROGRESS_MAX_AGE_MS = 60_000;
const STALE_PROGRESS_MIN_AGE_MS = 120_000;

type DiagnoseParams = SessionsDiagnoseParams;
type DiagnoseFinding = SessionsDiagnoseResult["findings"][number];
type DiagnoseSummary = SessionsDiagnoseResult["summary"];
type DiagnoseGatewayRun = NonNullable<SessionsDiagnoseResult["live"]["gatewayRun"]>;
type DiagnoseEmbeddedRun = NonNullable<SessionsDiagnoseResult["live"]["embeddedRun"]>;
type DiagnoseDiagnostic = NonNullable<SessionsDiagnoseResult["live"]["diagnostic"]>;
type DiagnoseLane = NonNullable<SessionsDiagnoseResult["live"]["lane"]>;

type DiagnoseRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  status?: string;
  updatedAt: number | null;
  sessionId?: string;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  lastChannel?: SessionEntry["lastChannel"];
  lastTo?: string;
  lastThreadId?: SessionEntry["lastThreadId"];
};

type DiagnoseTarget = {
  key: string;
  chosenBecause: string;
  row: DiagnoseRow;
  entry: SessionEntry;
  storePath: string;
  agentId?: string;
};

type DiagnoseTranscriptEvidence = {
  resolved: boolean;
  source: "sessionFile" | "store";
  recentEventCount: number;
};

function countDiagnoseSelectors(p: DiagnoseParams): number {
  return [p.key, p.sessionId, p.label].filter((value) => Boolean(value)).length;
}

function clampDiagnoseTail(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(200, Math.max(1, Math.trunc(value)))
    : DEFAULT_DIAGNOSE_TAIL;
}

function selectorFromDiagnoseParams(p: DiagnoseParams): SessionsDiagnoseResult["selector"] {
  return {
    ...(p.key ? { key: p.key } : {}),
    ...(p.sessionId ? { sessionId: p.sessionId } : {}),
    ...(p.label ? { label: p.label } : {}),
    ...(p.agentId ? { agentId: p.agentId } : {}),
  };
}

function quoteDiagnoseCliArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function classifyDiagnoseSessionKind(key: string): DiagnoseRow["kind"] {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (key.includes(":group:")) {
    return "group";
  }
  return "direct";
}

function buildDiagnoseRow(key: string, entry: SessionEntry): DiagnoseRow {
  return {
    key,
    kind: classifyDiagnoseSessionKind(key),
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : null,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
    ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
    ...(entry.runtimeMs ? { runtimeMs: entry.runtimeMs } : {}),
    ...(entry.lastChannel ? { lastChannel: entry.lastChannel } : {}),
    ...(entry.lastTo ? { lastTo: entry.lastTo } : {}),
    ...(entry.lastThreadId ? { lastThreadId: entry.lastThreadId } : {}),
  };
}

function isDiagnoseRowTerminal(row: DiagnoseRow): boolean {
  return Boolean(row.endedAt || isTerminalSessionStatus(row.status));
}

function buildNotFoundDiagnosis(
  p: DiagnoseParams,
  outcome: "not_found" | "no_sessions",
  headline: string,
): SessionsDiagnoseResult {
  return {
    ok: true,
    ts: Date.now(),
    outcome,
    selector: selectorFromDiagnoseParams(p),
    summary: {
      state: outcome === "not_found" ? "not_found" : "unknown",
      confidence: "high",
      headline,
    },
    session: { found: false },
    live: {},
    findings:
      outcome === "not_found"
        ? [
            {
              code: "session_not_found",
              severity: "error",
              message: "No stored session matched the requested selector.",
              evidence: ["session store lookup returned no matching row"],
            },
          ]
        : [],
    nextChecks: ["openclaw sessions", "openclaw health --verbose"],
  };
}

function listDiagnoseCandidateRows(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  p: DiagnoseParams;
}) {
  const { cfg, context, p } = params;
  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg, {
    agentId: p.agentId,
  });
  const hasExplicitNonKeySelector = Boolean(p.sessionId || p.label);
  const requestedAgentId = p.agentId ? normalizeAgentId(p.agentId) : undefined;
  const activeSessionKeys = new Set(
    collectTrackedActiveSessionRuns(context)
      .filter((run) => !requestedAgentId || !run.agentId || run.agentId === requestedAgentId)
      .map((run) => run.sessionKey)
      .filter((key): key is string => Boolean(key)),
  );
  const candidates = Object.entries(store)
    .filter(([key, entry]) => {
      if (!entry?.sessionId) {
        return false;
      }
      if (key === "global" && p.includeGlobal !== true && !hasExplicitNonKeySelector) {
        return false;
      }
      if (key === "unknown" && p.includeUnknown !== true && !hasExplicitNonKeySelector) {
        return false;
      }
      if (p.label && entry.label !== p.label) {
        return false;
      }
      if (p.sessionId && entry.sessionId !== p.sessionId) {
        return false;
      }
      return true;
    })
    .toSorted(([aKey, aEntry], [bKey, bEntry]) => {
      const activePriority =
        Number(activeSessionKeys.has(bKey)) - Number(activeSessionKeys.has(aKey));
      return activePriority || (bEntry.updatedAt ?? 0) - (aEntry.updatedAt ?? 0);
    })
    .slice(0, DEFAULT_DIAGNOSE_SCAN_LIMIT)
    .map(([key, entry]) => ({
      key,
      entry,
      row: buildDiagnoseRow(key, entry),
      storePath,
      agentId:
        resolveStoredSessionOwnerAgentId({
          cfg,
          agentId: p.agentId ?? resolveDefaultAgentId(cfg),
          sessionKey: key,
        }) ?? p.agentId,
    }));
  return { candidates };
}

function scoreDiagnoseCandidate(params: {
  row: DiagnoseRow;
  context: GatewayRequestContext;
  cfg: OpenClawConfig;
  agentId?: string;
}): number {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const gatewayRun = collectTrackedActiveSessionRunSnapshot({
    context: params.context,
    requestedKey: params.row.key,
    canonicalKey: params.row.key,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    defaultAgentId,
  });
  const activeRunState = resolveVisibleActiveSessionRunState({
    context: params.context,
    requestedKey: params.row.key,
    canonicalKey: params.row.key,
    sessionId: params.row.sessionId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    defaultAgentId,
  });
  const diagnostic = getDiagnosticSessionStateSnapshot({
    sessionId: params.row.sessionId,
    sessionKey: params.row.key,
  });
  const activity = getDiagnosticSessionActivitySnapshot({
    sessionId: params.row.sessionId,
    sessionKey: params.row.key,
  });
  const lane = getCommandLaneSnapshot(resolveSessionLane(params.row.key));
  const terminal = isDiagnoseRowTerminal(params.row);
  let score = 0;
  if (gatewayRun.hasActiveRun || activeRunState.active || activity.activeWorkKind) {
    score += 50;
  }
  if ((diagnostic.queueDepth ?? 0) > 0 || lane.queuedCount > 0) {
    score += 40;
  }
  if (terminal && (gatewayRun.hasActiveRun || activeRunState.active || diagnostic.state === "processing")) {
    score += 80;
  }
  if (
    activity.lastProgressAgeMs !== undefined &&
    activity.lastProgressAgeMs >= STALE_PROGRESS_MIN_AGE_MS
  ) {
    score += 20;
  }
  return score;
}

async function resolveDiagnoseTarget(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  p: DiagnoseParams;
}): Promise<DiagnoseTarget | null> {
  const { cfg, context, p } = params;
  if (countDiagnoseSelectors(p) > 1) {
    throw new Error("choose only one of key, sessionId, or label for sessions.diagnose");
  }
  const requestedAgentId = p.key
    ? resolveRequestedGlobalAgentId(cfg, p.key, p.agentId)
    : resolveRequestedGlobalAgentId(cfg, "global", p.agentId);
  if (!requestedAgentId.ok) {
    throw new Error(requestedAgentId.error.message);
  }
  if (p.key) {
    const { target, storePath, entry } = loadSessionEntriesForTarget({
      key: p.key,
      cfg,
      ...(requestedAgentId.agentId ? { agentId: requestedAgentId.agentId } : {}),
    });
    if (!entry) {
      return null;
    }
    return {
      key: target.canonicalKey,
      chosenBecause: "explicit key selector",
      row: buildDiagnoseRow(target.canonicalKey, entry),
      entry,
      storePath,
      agentId: target.agentId ?? requestedAgentId.agentId,
    };
  }

  const listed = listDiagnoseCandidateRows({ cfg, context, p });
  let candidates = listed.candidates;
  if (p.sessionId) {
    candidates = candidates.filter((candidate) => candidate.row.sessionId === p.sessionId);
  }
  if (p.label) {
    candidates = candidates.filter((candidate) => candidate.row.label === p.label);
  }
  if (p.sessionId || p.label) {
    if (candidates.length > 1) {
      throw new Error(
        p.sessionId
          ? `multiple sessions match sessionId ${p.sessionId}; diagnose by session key instead`
          : `multiple sessions match label ${p.label}; diagnose by session key instead`,
      );
    }
    const candidate = candidates[0];
    return candidate
      ? {
          ...candidate,
          chosenBecause: p.sessionId ? "explicit session id selector" : "explicit label selector",
        }
      : null;
  }
  if (candidates.length === 0) {
    return null;
  }
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreDiagnoseCandidate({
        row: candidate.row,
        context,
        cfg,
        agentId: candidate.agentId,
      }),
    }))
    .toSorted(
      (a, b) =>
        b.score - a.score || (b.candidate.row.updatedAt ?? 0) - (a.candidate.row.updatedAt ?? 0),
    );
  const selected = scored[0];
  if (!selected) {
    return null;
  }
  return {
    ...selected.candidate,
    chosenBecause:
      selected.score > 0 ? "highest live or contradictory evidence score" : "newest stored session",
  };
}

function addFinding(findings: DiagnoseFinding[], finding: DiagnoseFinding): void {
  if (!findings.some((entry) => entry.code === finding.code)) {
    findings.push(finding);
  }
}

function buildDiagnoseFindings(params: {
  row: DiagnoseRow;
  gatewayRun: DiagnoseGatewayRun;
  embeddedRun: DiagnoseEmbeddedRun;
  diagnostic: DiagnoseDiagnostic;
  lane: DiagnoseLane;
  transcriptResolved: boolean;
  deliveryUncertain: boolean;
}): DiagnoseFinding[] {
  const findings: DiagnoseFinding[] = [];
  const activeVisible = params.gatewayRun.hasActiveRun || params.embeddedRun.active;
  const activeWork = activeVisible || Boolean(params.diagnostic.activeWorkKind);
  const terminalStore = isDiagnoseRowTerminal(params.row);

  if (activeVisible) {
    addFinding(findings, {
      code: "active_run_visible",
      severity: "info",
      message: "A live Gateway or embedded run is visible for this session.",
      evidence: ["gateway or embedded run projection is active"],
    });
  }
  if (
    activeWork &&
    params.diagnostic.lastProgressAgeMs !== undefined &&
    params.diagnostic.lastProgressAgeMs <= FRESH_PROGRESS_MAX_AGE_MS
  ) {
    addFinding(findings, {
      code: "active_progress_fresh",
      severity: "info",
      message:
        "Recent diagnostic progress is fresh, so the session should not be treated as stale.",
      evidence: [`lastProgressAgeMs=${params.diagnostic.lastProgressAgeMs}`],
    });
  }
  if (
    activeWork &&
    params.diagnostic.lastProgressAgeMs !== undefined &&
    params.diagnostic.lastProgressAgeMs >= STALE_PROGRESS_MIN_AGE_MS
  ) {
    addFinding(findings, {
      code: "last_progress_stale",
      severity: "warn",
      message: "Active work exists, but diagnostic progress has not advanced recently.",
      evidence: [`lastProgressAgeMs=${params.diagnostic.lastProgressAgeMs}`],
    });
  }
  if (!activeVisible && ((params.diagnostic.queueDepth ?? 0) > 0 || params.lane.queuedCount > 0)) {
    addFinding(findings, {
      code: "queued_without_active_run",
      severity: "warn",
      message: "Queued work exists, but no visible active run owns the session.",
      evidence: [
        `queueDepth=${params.diagnostic.queueDepth ?? 0}`,
        `laneQueued=${params.lane.queuedCount}`,
      ],
    });
  }
  if (
    !activeVisible &&
    params.lane.activeCount === 0 &&
    (params.diagnostic.activeWorkKind === "tool_call" ||
      params.diagnostic.activeWorkKind === "model_call")
  ) {
    addFinding(findings, {
      code: "stale_diagnostic_tool",
      severity: "warn",
      message:
        "Diagnostic activity reports active tool or model work, but live run and lane state disagree.",
      evidence: [`activeWorkKind=${params.diagnostic.activeWorkKind}`],
    });
  }
  if (terminalStore && (activeVisible || params.diagnostic.state === "processing")) {
    addFinding(findings, {
      code: "store_terminal_but_live_processing",
      severity: "warn",
      message: "The stored session looks terminal, but live state still reports processing.",
      evidence: [
        `status=${params.row.status ?? "unset"}`,
        `diagnosticState=${params.diagnostic.state ?? "unset"}`,
      ],
    });
  }
  if (!activeVisible && (params.lane.activeCount > 0 || params.lane.queuedCount > 0)) {
    addFinding(findings, {
      code: "lane_blocked",
      severity: "warn",
      message: "The session lane has active or queued work without a visible active run.",
      evidence: [`laneActive=${params.lane.activeCount}`, `laneQueued=${params.lane.queuedCount}`],
    });
  }
  if (!params.transcriptResolved) {
    addFinding(findings, {
      code: "transcript_unresolved",
      severity: "warn",
      message: "The session row does not resolve to a readable transcript tail.",
      evidence: ["transcript metadata could not be read"],
    });
  }
  if (params.deliveryUncertain) {
    addFinding(findings, {
      code: "delivery_uncertain",
      severity: "info",
      message: "The stored run is terminal, but generic delivery metadata is incomplete.",
      evidence: ["terminal store row lacks complete last delivery fields"],
    });
  }
  if (findings.length === 0) {
    addFinding(findings, {
      code: "unknown_low_confidence",
      severity: "info",
      message: "No dominant stuck-session signal was found from the available evidence.",
      evidence: [
        "store, live run, diagnostic, and lane evidence did not produce a stronger finding",
      ],
    });
  }
  return findings;
}

function summarizeDiagnose(params: {
  findings: DiagnoseFinding[];
  row: DiagnoseRow;
}): DiagnoseSummary {
  const hasError = params.findings.some((finding) => finding.severity === "error");
  const hasWarn = params.findings.some((finding) => finding.severity === "warn");
  const hasQueued = params.findings.some((finding) => finding.code === "queued_without_active_run");
  const hasActive = params.findings.some(
    (finding) => finding.code === "active_run_visible" || finding.code === "active_progress_fresh",
  );
  const state = hasError
    ? "unknown"
    : hasQueued
      ? "queued"
      : hasWarn
        ? "stalled"
        : hasActive
          ? "active"
          : isDiagnoseRowTerminal(params.row)
            ? "done"
            : "unknown";
  return {
    state,
    confidence: hasWarn || hasError ? "medium" : "high",
    headline:
      params.findings[0]?.message ??
      "No dominant stuck-session signal was found from the available evidence.",
  };
}

async function readDiagnoseTranscriptEvidence(params: {
  target: DiagnoseTarget;
  maxLines: number;
}): Promise<DiagnoseTranscriptEvidence | null> {
  if (!params.target.entry.sessionId) {
    return null;
  }
  try {
    const result = await readRecentSessionMessagesWithStatsAsync(
      {
        sessionId: params.target.entry.sessionId,
        sessionKey: params.target.key,
        storePath: params.target.storePath,
        sessionEntry: params.target.entry,
        ...(params.target.agentId ? { agentId: params.target.agentId } : {}),
      },
      {
        maxMessages: params.maxLines,
        maxLines: params.maxLines * 20 + 20,
        maxBytes: 64 * 1024,
        allowResetArchiveFallback: true,
      },
    );
    return {
      resolved:
        Boolean(result.transcriptPath) || result.totalMessages > 0 || result.messages.length > 0,
      source: params.target.entry.sessionFile ? "sessionFile" : "store",
      recentEventCount: result.messages.length,
    };
  } catch {
    return null;
  }
}

async function buildDiagnoseResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  p: DiagnoseParams;
  target: DiagnoseTarget;
}): Promise<SessionsDiagnoseResult> {
  const { cfg, context, p, target } = params;
  const now = Date.now();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const gatewayRun = collectTrackedActiveSessionRunSnapshot({
    context,
    requestedKey: p.key ?? target.key,
    canonicalKey: target.key,
    ...(target.agentId ? { agentId: target.agentId } : {}),
    defaultAgentId,
    now,
  });
  const embeddedRun = getEmbeddedRunDiagnosticSnapshot({
    sessionId: target.entry.sessionId,
    sessionKey: target.key,
    sessionFile: target.entry.sessionFile,
  });
  const stateSnapshot = getDiagnosticSessionStateSnapshot(
    {
      sessionId: target.entry.sessionId,
      sessionKey: target.key,
      sessionFile: target.entry.sessionFile,
    },
    now,
  );
  const activity = getDiagnosticSessionActivitySnapshot(
    {
      sessionId: target.entry.sessionId,
      sessionKey: target.key,
    },
    now,
  );
  const diagnostic = {
    present: stateSnapshot.present,
    ...(stateSnapshot.state ? { state: stateSnapshot.state } : {}),
    ...(stateSnapshot.queueDepth !== undefined ? { queueDepth: stateSnapshot.queueDepth } : {}),
    ...(stateSnapshot.activeQueuedTurn !== undefined
      ? { activeQueuedTurn: stateSnapshot.activeQueuedTurn }
      : {}),
    ...(stateSnapshot.generation !== undefined ? { generation: stateSnapshot.generation } : {}),
    ...(activity.activeWorkKind ? { activeWorkKind: activity.activeWorkKind } : {}),
    ...(activity.activeToolName ? { activeToolName: activity.activeToolName } : {}),
    ...(activity.activeToolAgeMs !== undefined
      ? { activeToolAgeMs: activity.activeToolAgeMs }
      : {}),
    ...(stateSnapshot.lastActivityAgeMs !== undefined
      ? { lastActivityAgeMs: stateSnapshot.lastActivityAgeMs }
      : {}),
    ...(activity.lastProgressAgeMs !== undefined
      ? { lastProgressAgeMs: activity.lastProgressAgeMs }
      : {}),
    ...(activity.lastProgressReason ? { lastProgressReason: activity.lastProgressReason } : {}),
    ...(stateSnapshot.recentToolCalls !== undefined
      ? { recentToolCalls: stateSnapshot.recentToolCalls }
      : {}),
    ...(stateSnapshot.repeatedToolPattern
      ? { repeatedToolPattern: stateSnapshot.repeatedToolPattern }
      : {}),
  };
  const lane = getCommandLaneSnapshot(resolveSessionLane(target.key));
  const transcript = await readDiagnoseTranscriptEvidence({
    target,
    maxLines: clampDiagnoseTail(p.tail),
  });
  const transcriptResolved = transcript?.resolved === true;
  const deliveryUncertain =
    isDiagnoseRowTerminal(target.row) &&
    !target.row.lastChannel &&
    !target.row.lastTo &&
    !target.row.lastThreadId;
  const lastChannel = normalizeOptionalString(target.row.lastChannel);
  const lastTo = normalizeOptionalString(target.row.lastTo);
  const lastThreadId = normalizeOptionalString(target.row.lastThreadId);
  const findings = buildDiagnoseFindings({
    row: target.row,
    gatewayRun,
    embeddedRun,
    diagnostic,
    lane,
    transcriptResolved,
    deliveryUncertain,
  });
  return {
    ok: true,
    ts: now,
    outcome: "diagnosed",
    selector: selectorFromDiagnoseParams(p),
    chosenBecause: target.chosenBecause,
    summary: summarizeDiagnose({ findings, row: target.row }),
    session: {
      found: true,
      key: target.key,
      ...(target.agentId ? { agentId: target.agentId } : {}),
      ...(target.entry.sessionId ? { sessionId: target.entry.sessionId } : {}),
      kind: target.row.kind,
      ...(target.row.label ? { label: target.row.label } : {}),
      ...(target.row.status ? { status: target.row.status } : {}),
      updatedAt: target.row.updatedAt,
      ...(target.row.startedAt ? { startedAt: target.row.startedAt } : {}),
      ...(target.row.endedAt ? { endedAt: target.row.endedAt } : {}),
      ...(target.row.runtimeMs ? { runtimeMs: target.row.runtimeMs } : {}),
      hasActiveRun: gatewayRun.hasActiveRun || embeddedRun.active,
    },
    live: {
      gatewayRun,
      embeddedRun,
      diagnostic,
      lane,
    },
    transcript: {
      resolved: transcriptResolved,
      ...(transcript ? { source: transcript.source, recentEventCount: transcript.recentEventCount } : {}),
    },
    ...(deliveryUncertain || lastChannel || lastTo || lastThreadId
      ? {
          delivery: {
            uncertain: deliveryUncertain,
            ...(lastChannel ? { lastChannel } : {}),
            ...(lastTo ? { lastTo } : {}),
            ...(lastThreadId ? { lastThreadId } : {}),
          },
        }
      : {}),
    findings,
    nextChecks: [
      `openclaw sessions tail --session-key ${quoteDiagnoseCliArg(target.key)}`,
      `openclaw sessions export-trajectory --session-key ${quoteDiagnoseCliArg(target.key)}`,
      "openclaw health --verbose",
    ],
  };
}

export const sessionDiagnoseHandlers: GatewayRequestHandlers = {
  "sessions.diagnose": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsDiagnoseParams, "sessions.diagnose", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    try {
      const target = await resolveDiagnoseTarget({ cfg, context, p });
      if (!target) {
        const hasExplicitSelector = Boolean(p.key || p.sessionId || p.label);
        respond(
          true,
          buildNotFoundDiagnosis(
            p,
            hasExplicitSelector ? "not_found" : "no_sessions",
            hasExplicitSelector
              ? "No stored session matched the requested selector."
              : "No stored sessions are available to diagnose.",
          ),
          undefined,
        );
        return;
      }
      respond(true, await buildDiagnoseResult({ cfg, context, p, target }), undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    }
  },
};
