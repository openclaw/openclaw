import { randomUUID } from "node:crypto";
import { requireAcpRuntimeBackend, type AcpRuntimeBackend } from "../acp/runtime/registry.js";
import type { AcpRuntime, AcpRuntimeHandle, AcpRuntimeStatus } from "../acp/runtime/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";

type AcpSessionMode = "persistent" | "oneshot";
type AcpTurnMode = "prompt" | "steer";
type AcpWorkerState = "idle" | "running" | "cancelling" | "error";

type AcpEnsureParams = {
  sessionKey: string;
  leaseId: string;
  leaseEpoch: number;
  agent: string;
  mode: AcpSessionMode;
  cwd?: string;
  runtimeOptions?: Record<string, unknown>;
  resume?: Record<string, unknown>;
};

type AcpTurnStartParams = {
  sessionKey: string;
  runId: string;
  leaseId: string;
  leaseEpoch: number;
  requestId: string;
  mode: AcpTurnMode;
  text: string;
  attachments?: Array<{ mediaType: string; data: string }>;
};

type AcpTurnCancelParams = {
  sessionKey: string;
  runId: string;
  leaseId: string;
  leaseEpoch: number;
  reason?: string;
};

type AcpSessionCloseParams = {
  sessionKey: string;
  leaseId: string;
  leaseEpoch: number;
  reason?: string;
};

type AcpSessionStatusParams = {
  sessionKey: string;
  leaseId?: string;
  leaseEpoch?: number;
};

type AcpNodeSessionRecord = {
  sessionKey: string;
  leaseId: string;
  leaseEpoch: number;
  agent: string;
  mode: AcpSessionMode;
  backendId: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  nodeRuntimeSessionId: string;
  state: AcpWorkerState;
  currentRunId?: string;
  currentRequestId?: string;
  nodeWorkerRunId?: string;
  activeTurn?: AcpNodeActiveTurn;
  cwd?: string;
  runtimeOptions?: Record<string, unknown>;
  resume?: Record<string, unknown>;
  lastStatusSummary?: string;
  terminalDeliveryFailure?: AcpNodeTerminalDeliveryFailure;
  completedTurns: Map<string, AcpCompletedTurnRecord>;
  updatedAt: number;
};

type AcpNodeActiveTurn = {
  runId: string;
  requestId: string;
  nodeWorkerRunId: string;
  cancelRequested: boolean;
  cancelReason?: string;
  abortController: AbortController;
  completion: Promise<void>;
};

type AcpCompletedTurnRecord = {
  runId: string;
  requestId: string;
  nodeWorkerRunId: string;
};

type AcpNodeTerminalDeliveryFailure = {
  runId: string;
  requestId: string;
  nodeWorkerRunId: string;
  errorMessage: string;
};

type AcpInvokeCommandResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      ok: true;
      payload: unknown;
    }
  | {
      handled: true;
      ok: false;
      code: string;
      message: string;
    };

const ACP_COMMANDS = new Set([
  "acp.session.ensure",
  "acp.session.load",
  "acp.turn.start",
  "acp.turn.cancel",
  "acp.session.close",
  "acp.session.status",
]);

const nodeAcpSessions = new Map<string, AcpNodeSessionRecord>();
const DEFAULT_NODE_HOST_ACP_BACKEND = "acpx";

let acpRuntimeServicesInit: Promise<void> | null = null;
let acpRuntimeServicesHandle: PluginServicesHandle | null = null;

type AcpInvokeCommandDeps = {
  ensureRuntimeReady?: () => Promise<void>;
  loadConfig?: () => OpenClawConfig;
  requireRuntimeBackend?: (backendId?: string) => AcpRuntimeBackend;
  sendNodeEvent?: (event: string, payload: unknown) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeParams(raw?: string | null): Record<string, unknown> {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("INVALID_REQUEST: paramsJSON must decode to an object");
  }
  return parsed;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  message = `INVALID_REQUEST: ${key} required`,
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value.trim();
}

function requirePositiveInteger(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.trunc(value) !== value ||
    value <= 0
  ) {
    throw new Error(`INVALID_REQUEST: ${key} must be a positive integer`);
  }
  return value;
}

function optionalRecord(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = obj[key];
  return isRecord(value) ? value : undefined;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveResumeSessionId(resume?: Record<string, unknown>): string | undefined {
  if (!resume) {
    return undefined;
  }
  return (
    optionalStringValue(resume.runtimeSessionId) ??
    optionalStringValue(resume.backendSessionId) ??
    optionalStringValue(resume.sessionId)
  );
}

function parseEnsureParams(frame: NodeInvokeRequestPayload): AcpEnsureParams {
  const raw = decodeParams(frame.paramsJSON);
  const mode = requireString(raw, "mode");
  if (mode !== "persistent" && mode !== "oneshot") {
    throw new Error("INVALID_REQUEST: mode must be persistent or oneshot");
  }
  return {
    sessionKey: requireString(raw, "sessionKey"),
    leaseId: requireString(raw, "leaseId"),
    leaseEpoch: requirePositiveInteger(raw, "leaseEpoch"),
    agent: requireString(raw, "agent"),
    mode,
    ...(optionalString(raw, "cwd") ? { cwd: optionalString(raw, "cwd") } : {}),
    ...(optionalRecord(raw, "runtimeOptions")
      ? { runtimeOptions: optionalRecord(raw, "runtimeOptions") }
      : {}),
    ...(optionalRecord(raw, "resume") ? { resume: optionalRecord(raw, "resume") } : {}),
  };
}

function parseTurnStartParams(frame: NodeInvokeRequestPayload): AcpTurnStartParams {
  const raw = decodeParams(frame.paramsJSON);
  const mode = requireString(raw, "mode");
  if (mode !== "prompt" && mode !== "steer") {
    throw new Error("INVALID_REQUEST: mode must be prompt or steer");
  }
  const text = requireString(raw, "text");
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments
        .filter((entry) => isRecord(entry))
        .map((entry) => ({
          mediaType: requireString(
            entry,
            "mediaType",
            "INVALID_REQUEST: attachments[].mediaType required",
          ),
          data: requireString(entry, "data", "INVALID_REQUEST: attachments[].data required"),
        }))
    : undefined;
  return {
    sessionKey: requireString(raw, "sessionKey"),
    runId: requireString(raw, "runId"),
    leaseId: requireString(raw, "leaseId"),
    leaseEpoch: requirePositiveInteger(raw, "leaseEpoch"),
    requestId: requireString(raw, "requestId"),
    mode,
    text,
    ...(attachments ? { attachments } : {}),
  };
}

function parseTurnCancelParams(frame: NodeInvokeRequestPayload): AcpTurnCancelParams {
  const raw = decodeParams(frame.paramsJSON);
  return {
    sessionKey: requireString(raw, "sessionKey"),
    runId: requireString(raw, "runId"),
    leaseId: requireString(raw, "leaseId"),
    leaseEpoch: requirePositiveInteger(raw, "leaseEpoch"),
    ...(optionalString(raw, "reason") ? { reason: optionalString(raw, "reason") } : {}),
  };
}

function parseSessionCloseParams(frame: NodeInvokeRequestPayload): AcpSessionCloseParams {
  const raw = decodeParams(frame.paramsJSON);
  return {
    sessionKey: requireString(raw, "sessionKey"),
    leaseId: requireString(raw, "leaseId"),
    leaseEpoch: requirePositiveInteger(raw, "leaseEpoch"),
    ...(optionalString(raw, "reason") ? { reason: optionalString(raw, "reason") } : {}),
  };
}

function parseSessionStatusParams(frame: NodeInvokeRequestPayload): AcpSessionStatusParams {
  const raw = decodeParams(frame.paramsJSON);
  return {
    sessionKey: requireString(raw, "sessionKey"),
    ...(optionalString(raw, "leaseId") ? { leaseId: optionalString(raw, "leaseId") } : {}),
    ...(typeof raw.leaseEpoch === "number" && Number.isFinite(raw.leaseEpoch)
      ? { leaseEpoch: Math.trunc(raw.leaseEpoch) }
      : {}),
  };
}

function assertLeaseBinding(
  session: AcpNodeSessionRecord | undefined,
  params: { sessionKey: string; leaseId: string; leaseEpoch: number },
): AcpNodeSessionRecord {
  if (!session) {
    throw new Error(
      `INVALID_REQUEST: ACP session ${params.sessionKey} is not ensured on this node`,
    );
  }
  if (session.leaseEpoch > params.leaseEpoch) {
    throw new Error(
      `INVALID_REQUEST: lease epoch ${params.leaseEpoch} is stale for ${params.sessionKey}; active epoch is ${session.leaseEpoch}`,
    );
  }
  if (session.leaseEpoch !== params.leaseEpoch || session.leaseId !== params.leaseId) {
    throw new Error(
      `INVALID_REQUEST: lease ${params.leaseId}@${params.leaseEpoch} does not match current ACP session lease ${session.leaseId}@${session.leaseEpoch}`,
    );
  }
  return session;
}

function resolveConfiguredNodeHostBackendId(config: OpenClawConfig): string {
  const configured = config.acp?.backend?.trim().toLowerCase();
  if (!configured || configured === "acp-node") {
    return DEFAULT_NODE_HOST_ACP_BACKEND;
  }
  return configured;
}

async function ensureNodeHostAcpRuntimeReady(): Promise<void> {
  if (acpRuntimeServicesHandle) {
    return;
  }
  if (!acpRuntimeServicesInit) {
    acpRuntimeServicesInit = (async () => {
      const [
        { resolveAgentWorkspaceDir, resolveDefaultAgentId },
        { loadConfig },
        { loadOpenClawPlugins },
        { startPluginServices },
      ] = await Promise.all([
        import("../agents/agent-scope.js"),
        import("../config/config.js"),
        import("../plugins/loader.js"),
        import("../plugins/services.js"),
      ]);
      const config = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
      const registry = loadOpenClawPlugins({
        config,
        workspaceDir,
      });
      acpRuntimeServicesHandle = await startPluginServices({
        registry,
        config,
        workspaceDir,
      });
    })().catch((error) => {
      acpRuntimeServicesInit = null;
      throw error;
    });
  }
  await acpRuntimeServicesInit;
}

function buildNodeRuntimeSessionId(handle: AcpRuntimeHandle): string {
  return handle.backendSessionId?.trim() || handle.runtimeSessionName.trim();
}

function resolveFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

function resolveFailureCode(error: unknown): string | undefined {
  const code =
    error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

async function closeSessionRecord(session: AcpNodeSessionRecord, reason: string): Promise<void> {
  if (session.activeTurn) {
    session.activeTurn.abortController.abort();
    try {
      await session.runtime.cancel({
        handle: session.handle,
        reason,
      });
    } catch {
      // Best-effort shutdown: replacing a lease must not get stuck on a stale worker.
    }
  }
  try {
    await session.runtime.close({
      handle: session.handle,
      reason,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

async function buildStatusPayload(params: {
  nodeId: string;
  request: AcpSessionStatusParams;
  session?: AcpNodeSessionRecord;
}) {
  const session = params.session;
  if (!session) {
    return {
      nodeId: params.nodeId,
      ok: true,
      sessionKey: params.request.sessionKey,
      leaseId: params.request.leaseId ?? "",
      leaseEpoch: params.request.leaseEpoch ?? 0,
      state: "missing",
      workerProtocolVersion: 1,
      details: {
        summary: "ACP session not present on node",
      },
    };
  }
  if (!session.runtime.getStatus) {
    throw new Error(`ACP status backend unavailable for session ${session.sessionKey}.`);
  }
  let runtimeStatus: AcpRuntimeStatus;
  try {
    runtimeStatus = await session.runtime.getStatus({
      handle: session.handle,
    });
  } catch (error) {
    throw new Error(
      `ACP status backend failed for session ${session.sessionKey}: ${resolveFailureMessage(error)}`,
      { cause: error },
    );
  }
  session.lastStatusSummary =
    typeof runtimeStatus.summary === "string" && runtimeStatus.summary.trim()
      ? runtimeStatus.summary.trim()
      : session.lastStatusSummary;
  const statusSummary =
    typeof runtimeStatus.summary === "string" && runtimeStatus.summary.trim()
      ? runtimeStatus.summary.trim()
      : session.lastStatusSummary;
  if (session.terminalDeliveryFailure) {
    return {
      nodeId: params.nodeId,
      ok: true,
      sessionKey: session.sessionKey,
      leaseId: session.leaseId,
      leaseEpoch: session.leaseEpoch,
      state: "error",
      nodeRuntimeSessionId: session.nodeRuntimeSessionId,
      workerProtocolVersion: 1,
      details: {
        summary: `ACP terminal handoff failed for run ${session.terminalDeliveryFailure.runId}; explicit recovery required`,
        reason: "terminal_delivery_failed",
        runId: session.terminalDeliveryFailure.runId,
        requestId: session.terminalDeliveryFailure.requestId,
        nodeWorkerRunId: session.terminalDeliveryFailure.nodeWorkerRunId,
        errorMessage: session.terminalDeliveryFailure.errorMessage,
        ...(statusSummary ? { backendSummary: statusSummary } : {}),
      },
    };
  }
  return {
    nodeId: params.nodeId,
    ok: true,
    sessionKey: session.sessionKey,
    leaseId: session.leaseId,
    leaseEpoch: session.leaseEpoch,
    state: session.state,
    nodeRuntimeSessionId: session.nodeRuntimeSessionId,
    ...(session.nodeWorkerRunId ? { nodeWorkerRunId: session.nodeWorkerRunId } : {}),
    workerProtocolVersion: 1,
    details: {
      summary:
        statusSummary ??
        (session.state === "running"
          ? `run ${session.currentRunId ?? "unknown"} active`
          : session.state === "cancelling"
            ? `run ${session.currentRunId ?? "unknown"} cancelling`
            : "session ready"),
    },
  };
}

async function resolveRuntimeForEnsure(
  deps: AcpInvokeCommandDeps,
): Promise<{ backendId: string; runtime: AcpRuntime }> {
  const ensureRuntimeReady = deps.ensureRuntimeReady ?? ensureNodeHostAcpRuntimeReady;
  const requireRuntimeBackendFromDeps = deps.requireRuntimeBackend ?? requireAcpRuntimeBackend;
  await ensureRuntimeReady();
  const config = deps.loadConfig?.() ?? (await import("../config/config.js")).loadConfig();
  const backendId = resolveConfiguredNodeHostBackendId(config);
  const backend = requireRuntimeBackendFromDeps(backendId);
  return {
    backendId: backend.id,
    runtime: backend.runtime,
  };
}

async function handleEnsureLike(
  frame: NodeInvokeRequestPayload,
  params: AcpEnsureParams,
  deps: AcpInvokeCommandDeps,
): Promise<AcpInvokeCommandResult> {
  const existing = nodeAcpSessions.get(params.sessionKey);
  if (existing && existing.leaseEpoch > params.leaseEpoch) {
    return {
      handled: true,
      ok: false,
      code: "INVALID_REQUEST",
      message: `lease epoch ${params.leaseEpoch} is stale for ${params.sessionKey}; active epoch is ${existing.leaseEpoch}`,
    };
  }
  if (
    existing &&
    (existing.leaseEpoch !== params.leaseEpoch || existing.leaseId !== params.leaseId)
  ) {
    await closeSessionRecord(existing, "lease-replaced");
    if (nodeAcpSessions.get(params.sessionKey) === existing) {
      nodeAcpSessions.delete(params.sessionKey);
    }
  }
  if (
    existing &&
    existing.leaseEpoch === params.leaseEpoch &&
    existing.leaseId === params.leaseId
  ) {
    existing.agent = params.agent;
    existing.mode = params.mode;
    existing.updatedAt = Date.now();
    if (params.cwd) {
      existing.cwd = params.cwd;
    }
    if (params.runtimeOptions) {
      existing.runtimeOptions = params.runtimeOptions;
    }
    if (params.resume) {
      existing.resume = params.resume;
    }
    return {
      handled: true,
      ok: true,
      payload: {
        ok: true,
        sessionKey: existing.sessionKey,
        leaseId: existing.leaseId,
        leaseEpoch: existing.leaseEpoch,
        nodeRuntimeSessionId: existing.nodeRuntimeSessionId,
        nodeRuntimeInfo: {
          kind: "openclaw-node-host",
          backend: existing.backendId,
          ...(existing.cwd ? { cwd: existing.cwd } : {}),
          capabilities: {
            supportsCancel: true,
            supportsStatus: true,
            supportsMode: false,
            supportsConfigOptions: false,
          },
        },
      },
    };
  }
  const { backendId, runtime } = await resolveRuntimeForEnsure(deps);
  const handle = await runtime.ensureSession({
    sessionKey: params.sessionKey,
    agent: params.agent,
    mode: params.mode,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(resolveResumeSessionId(params.resume)
      ? { resumeSessionId: resolveResumeSessionId(params.resume) }
      : {}),
  });
  const now = Date.now();
  const session: AcpNodeSessionRecord = {
    sessionKey: params.sessionKey,
    leaseId: params.leaseId,
    leaseEpoch: params.leaseEpoch,
    agent: params.agent,
    mode: params.mode,
    backendId,
    runtime,
    handle,
    nodeRuntimeSessionId: buildNodeRuntimeSessionId(handle),
    state: "idle",
    updatedAt: now,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.runtimeOptions ? { runtimeOptions: params.runtimeOptions } : {}),
    ...(params.resume ? { resume: params.resume } : {}),
    completedTurns: new Map(),
  };
  nodeAcpSessions.set(params.sessionKey, session);
  return {
    handled: true,
    ok: true,
    payload: {
      ok: true,
      sessionKey: session.sessionKey,
      leaseId: session.leaseId,
      leaseEpoch: session.leaseEpoch,
      nodeRuntimeSessionId: session.nodeRuntimeSessionId,
      nodeRuntimeInfo: {
        kind: "openclaw-node-host",
        backend: session.backendId,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        capabilities: {
          supportsCancel: true,
          supportsStatus: true,
          supportsMode: false,
          supportsConfigOptions: false,
        },
      },
    },
  };
}

function rememberCompletedTurn(session: AcpNodeSessionRecord, turn: AcpCompletedTurnRecord): void {
  if (session.completedTurns.has(turn.runId)) {
    session.completedTurns.delete(turn.runId);
  }
  session.completedTurns.set(turn.runId, turn);
  while (session.completedTurns.size > 8) {
    const oldest = session.completedTurns.keys().next().value;
    if (!oldest) {
      break;
    }
    session.completedTurns.delete(oldest);
  }
}

function settleCompletedTurn(session: AcpNodeSessionRecord, activeTurn: AcpNodeActiveTurn): void {
  if (nodeAcpSessions.get(session.sessionKey) !== session || session.activeTurn !== activeTurn) {
    return;
  }
  rememberCompletedTurn(session, {
    runId: activeTurn.runId,
    requestId: activeTurn.requestId,
    nodeWorkerRunId: activeTurn.nodeWorkerRunId,
  });
  session.state = "idle";
  session.currentRunId = undefined;
  session.currentRequestId = undefined;
  session.nodeWorkerRunId = undefined;
  session.activeTurn = undefined;
  session.terminalDeliveryFailure = undefined;
  session.updatedAt = Date.now();
}

function settleTerminalDeliveryFailure(
  session: AcpNodeSessionRecord,
  activeTurn: AcpNodeActiveTurn,
  error: unknown,
): void {
  if (nodeAcpSessions.get(session.sessionKey) !== session || session.activeTurn !== activeTurn) {
    return;
  }
  session.state = "error";
  session.currentRunId = activeTurn.runId;
  session.currentRequestId = activeTurn.requestId;
  session.nodeWorkerRunId = undefined;
  session.activeTurn = undefined;
  session.terminalDeliveryFailure = {
    runId: activeTurn.runId,
    requestId: activeTurn.requestId,
    nodeWorkerRunId: activeTurn.nodeWorkerRunId,
    errorMessage: resolveFailureMessage(error),
  };
  session.updatedAt = Date.now();
}

async function runWorkerTurn(params: {
  nodeId: string;
  session: AcpNodeSessionRecord;
  activeTurn: AcpNodeActiveTurn;
  text: string;
  attachments?: Array<{ mediaType: string; data: string }>;
  mode: AcpTurnMode;
  sendNodeEvent: (event: string, payload: unknown) => Promise<void>;
}) {
  const { nodeId, session, activeTurn, sendNodeEvent } = params;
  let seq = 0;
  let terminal:
    | {
        kind: "completed" | "failed" | "cancelled";
        stopReason?: string;
        errorCode?: string;
        errorMessage?: string;
      }
    | undefined;

  try {
    for await (const event of session.runtime.runTurn({
      handle: session.handle,
      text: params.text,
      ...(params.attachments ? { attachments: params.attachments } : {}),
      mode: params.mode,
      requestId: activeTurn.requestId,
      signal: activeTurn.abortController.signal,
    })) {
      if (event.type === "text_delta" || event.type === "status" || event.type === "tool_call") {
        seq += 1;
        await sendNodeEvent("acp.worker.event", {
          nodeId,
          sessionKey: session.sessionKey,
          runId: activeTurn.runId,
          leaseId: session.leaseId,
          leaseEpoch: session.leaseEpoch,
          seq,
          event,
        });
        continue;
      }
      if (event.type === "done") {
        terminal = {
          kind: activeTurn.cancelRequested ? "cancelled" : "completed",
          ...(activeTurn.cancelRequested
            ? {
                stopReason:
                  activeTurn.cancelReason?.trim() || event.stopReason?.trim() || "cancelled",
              }
            : event.stopReason
              ? { stopReason: event.stopReason }
              : {}),
        };
        continue;
      }
      terminal = {
        kind: "failed",
        ...(event.code ? { errorCode: event.code } : {}),
        errorMessage: event.message,
      };
    }
  } catch (error) {
    terminal = {
      kind: "failed",
      ...(resolveFailureCode(error) ? { errorCode: resolveFailureCode(error) } : {}),
      errorMessage: resolveFailureMessage(error),
    };
  }

  if (!terminal) {
    terminal = activeTurn.cancelRequested
      ? {
          kind: "cancelled",
          stopReason: activeTurn.cancelReason?.trim() || "cancelled",
        }
      : {
          kind: "completed",
          stopReason: "done",
        };
  }

  try {
    await sendNodeEvent("acp.worker.terminal", {
      nodeId,
      sessionKey: session.sessionKey,
      runId: activeTurn.runId,
      leaseId: session.leaseId,
      leaseEpoch: session.leaseEpoch,
      terminalEventId: `node-host:${randomUUID()}`,
      finalSeq: seq,
      terminal,
    });
    settleCompletedTurn(session, activeTurn);
  } catch (error) {
    settleTerminalDeliveryFailure(session, activeTurn, error);
  }
}

function handleTurnStart(
  frame: NodeInvokeRequestPayload,
  params: AcpTurnStartParams,
  deps: AcpInvokeCommandDeps,
): AcpInvokeCommandResult {
  if (!deps.sendNodeEvent) {
    return {
      handled: true,
      ok: false,
      code: "UNAVAILABLE",
      message: "ACP worker event transport is unavailable on this node host.",
    };
  }
  const session = assertLeaseBinding(nodeAcpSessions.get(params.sessionKey), params);
  if (session.terminalDeliveryFailure) {
    return {
      handled: true,
      ok: false,
      code: "UNAVAILABLE",
      message: `ACP run ${session.terminalDeliveryFailure.runId} finished locally but terminal delivery failed on this node; explicit recovery is required before starting another turn`,
    };
  }
  if (
    session.currentRunId === params.runId &&
    session.currentRequestId === params.requestId &&
    session.nodeWorkerRunId &&
    session.activeTurn
  ) {
    return {
      handled: true,
      ok: true,
      payload: {
        ok: true,
        sessionKey: session.sessionKey,
        runId: params.runId,
        leaseId: session.leaseId,
        leaseEpoch: session.leaseEpoch,
        accepted: true,
        nodeWorkerRunId: session.nodeWorkerRunId,
      },
    };
  }
  if (
    session.activeTurn &&
    session.currentRunId === params.runId &&
    session.currentRequestId &&
    session.currentRequestId !== params.requestId
  ) {
    return {
      handled: true,
      ok: false,
      code: "INVALID_REQUEST",
      message: `ACP run ${params.runId} is already active on this node for request ${session.currentRequestId}`,
    };
  }
  const completedTurn = session.completedTurns.get(params.runId);
  if (completedTurn) {
    if (completedTurn.requestId !== params.requestId) {
      return {
        handled: true,
        ok: false,
        code: "INVALID_REQUEST",
        message: `ACP run ${params.runId} already completed on this node for request ${completedTurn.requestId}`,
      };
    }
    return {
      handled: true,
      ok: true,
      payload: {
        ok: true,
        sessionKey: session.sessionKey,
        runId: params.runId,
        leaseId: session.leaseId,
        leaseEpoch: session.leaseEpoch,
        accepted: true,
        nodeWorkerRunId: completedTurn.nodeWorkerRunId,
      },
    };
  }
  if (session.activeTurn && session.activeTurn.runId !== params.runId && session.state !== "idle") {
    return {
      handled: true,
      ok: false,
      code: "INVALID_REQUEST",
      message: `ACP session ${params.sessionKey} already has active run ${session.currentRunId}`,
    };
  }
  const nextWorkerRunId = randomUUID();
  const activeTurn: AcpNodeActiveTurn = {
    runId: params.runId,
    requestId: params.requestId,
    nodeWorkerRunId: nextWorkerRunId,
    cancelRequested: false,
    cancelReason: undefined,
    abortController: new AbortController(),
    completion: Promise.resolve(),
  };
  session.state = "running";
  session.currentRunId = params.runId;
  session.currentRequestId = params.requestId;
  session.nodeWorkerRunId = nextWorkerRunId;
  session.activeTurn = activeTurn;
  session.updatedAt = Date.now();
  activeTurn.completion = runWorkerTurn({
    nodeId: frame.nodeId,
    session,
    activeTurn,
    text: params.text,
    ...(params.attachments ? { attachments: params.attachments } : {}),
    mode: params.mode,
    sendNodeEvent: deps.sendNodeEvent,
  }).catch(() => {
    // The worker turn path already converts runtime failures into canonical terminals.
  });
  return {
    handled: true,
    ok: true,
    payload: {
      ok: true,
      sessionKey: session.sessionKey,
      runId: params.runId,
      leaseId: session.leaseId,
      leaseEpoch: session.leaseEpoch,
      accepted: true,
      nodeWorkerRunId: nextWorkerRunId,
    },
  };
}

async function handleTurnCancel(params: AcpTurnCancelParams): Promise<AcpInvokeCommandResult> {
  const session = assertLeaseBinding(nodeAcpSessions.get(params.sessionKey), params);
  if (!session.activeTurn || !session.currentRunId) {
    return {
      handled: true,
      ok: false,
      code: "INVALID_REQUEST",
      message: `ACP session ${params.sessionKey} has no active run to cancel`,
    };
  }
  if (session.currentRunId !== params.runId) {
    return {
      handled: true,
      ok: false,
      code: "INVALID_REQUEST",
      message: `ACP session ${params.sessionKey} active run is ${session.currentRunId}, not ${params.runId}`,
    };
  }
  session.state = "cancelling";
  session.currentRunId = params.runId;
  session.activeTurn.cancelRequested = true;
  session.activeTurn.cancelReason = params.reason?.trim() || session.activeTurn.cancelReason;
  session.updatedAt = Date.now();
  try {
    await session.runtime.cancel({
      handle: session.handle,
      ...(params.reason ? { reason: params.reason } : {}),
    });
  } catch (error) {
    session.state = "running";
    session.activeTurn.cancelRequested = false;
    session.activeTurn.cancelReason = undefined;
    throw error;
  }
  return {
    handled: true,
    ok: true,
    payload: {
      ok: true,
      sessionKey: params.sessionKey,
      runId: params.runId,
      leaseId: session.leaseId,
      leaseEpoch: session.leaseEpoch,
      accepted: true,
    },
  };
}

async function handleSessionClose(params: AcpSessionCloseParams): Promise<AcpInvokeCommandResult> {
  const session = assertLeaseBinding(nodeAcpSessions.get(params.sessionKey), params);
  await closeSessionRecord(session, params.reason ?? "session-close");
  if (nodeAcpSessions.get(params.sessionKey) === session) {
    nodeAcpSessions.delete(params.sessionKey);
  }
  return {
    handled: true,
    ok: true,
    payload: {
      ok: true,
      sessionKey: params.sessionKey,
      leaseId: session.leaseId,
      leaseEpoch: session.leaseEpoch,
      accepted: true,
    },
  };
}

async function handleSessionStatus(
  frame: NodeInvokeRequestPayload,
  params: AcpSessionStatusParams,
): Promise<AcpInvokeCommandResult> {
  return {
    handled: true,
    ok: true,
    payload: await buildStatusPayload({
      nodeId: frame.nodeId,
      request: params,
      session: nodeAcpSessions.get(params.sessionKey),
    }),
  };
}

export async function handleAcpInvokeCommand(
  frame: NodeInvokeRequestPayload,
  deps: AcpInvokeCommandDeps = {},
): Promise<AcpInvokeCommandResult> {
  if (!ACP_COMMANDS.has(frame.command)) {
    return { handled: false };
  }
  try {
    if (frame.command === "acp.session.ensure" || frame.command === "acp.session.load") {
      return await handleEnsureLike(frame, parseEnsureParams(frame), deps);
    }
    if (frame.command === "acp.turn.start") {
      return handleTurnStart(frame, parseTurnStartParams(frame), deps);
    }
    if (frame.command === "acp.turn.cancel") {
      return await handleTurnCancel(parseTurnCancelParams(frame));
    }
    if (frame.command === "acp.session.close") {
      return await handleSessionClose(parseSessionCloseParams(frame));
    }
    return await handleSessionStatus(frame, parseSessionStatusParams(frame));
  } catch (error) {
    return {
      handled: true,
      ok: false,
      code:
        error instanceof Error && /ACP_|backend/i.test(error.message)
          ? "UNAVAILABLE"
          : "INVALID_REQUEST",
      message: String(error instanceof Error ? error.message : error),
    };
  }
}

export const __testing = {
  resetNodeAcpSessionsForTests() {
    nodeAcpSessions.clear();
  },
  async resetNodeAcpRuntimeBootstrapForTests() {
    const handle = acpRuntimeServicesHandle;
    acpRuntimeServicesHandle = null;
    acpRuntimeServicesInit = null;
    await handle?.stop();
  },
};
