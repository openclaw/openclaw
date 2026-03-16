import { randomUUID } from "node:crypto";
import type { NodeInvokeRequestPayload } from "./invoke.js";

type AcpSessionMode = "persistent" | "oneshot";
type AcpTurnMode = "prompt" | "steer";
type AcpWorkerState = "idle" | "running" | "cancelling";

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
  nodeRuntimeSessionId: string;
  state: AcpWorkerState;
  currentRunId?: string;
  currentRequestId?: string;
  nodeWorkerRunId?: string;
  cwd?: string;
  runtimeOptions?: Record<string, unknown>;
  resume?: Record<string, unknown>;
  updatedAt: number;
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

function buildStatusPayload(params: {
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
        session.state === "running"
          ? `run ${session.currentRunId ?? "unknown"} active`
          : session.state === "cancelling"
            ? `run ${session.currentRunId ?? "unknown"} cancelling`
            : "session ready",
    },
  };
}

function handleEnsureLike(
  frame: NodeInvokeRequestPayload,
  params: AcpEnsureParams,
): AcpInvokeCommandResult {
  const existing = nodeAcpSessions.get(params.sessionKey);
  if (existing && existing.leaseEpoch > params.leaseEpoch) {
    return {
      handled: true,
      ok: false,
      code: "INVALID_REQUEST",
      message: `lease epoch ${params.leaseEpoch} is stale for ${params.sessionKey}; active epoch is ${existing.leaseEpoch}`,
    };
  }
  const now = Date.now();
  const session: AcpNodeSessionRecord =
    existing && existing.leaseEpoch === params.leaseEpoch && existing.leaseId === params.leaseId
      ? {
          ...existing,
          agent: params.agent,
          mode: params.mode,
          state: existing.state,
          updatedAt: now,
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.runtimeOptions ? { runtimeOptions: params.runtimeOptions } : {}),
          ...(params.resume ? { resume: params.resume } : {}),
        }
      : {
          sessionKey: params.sessionKey,
          leaseId: params.leaseId,
          leaseEpoch: params.leaseEpoch,
          agent: params.agent,
          mode: params.mode,
          nodeRuntimeSessionId: existing?.nodeRuntimeSessionId ?? randomUUID(),
          state: "idle",
          updatedAt: now,
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.runtimeOptions ? { runtimeOptions: params.runtimeOptions } : {}),
          ...(params.resume ? { resume: params.resume } : {}),
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

function handleTurnStart(
  frame: NodeInvokeRequestPayload,
  params: AcpTurnStartParams,
): AcpInvokeCommandResult {
  const session = assertLeaseBinding(nodeAcpSessions.get(params.sessionKey), params);
  if (
    session.currentRunId === params.runId &&
    session.currentRequestId === params.requestId &&
    session.nodeWorkerRunId
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
  if (session.currentRunId && session.currentRunId !== params.runId && session.state !== "idle") {
    return {
      handled: true,
      ok: false,
      code: "INVALID_REQUEST",
      message: `ACP session ${params.sessionKey} already has active run ${session.currentRunId}`,
    };
  }
  const nextWorkerRunId = session.nodeWorkerRunId ?? randomUUID();
  nodeAcpSessions.set(params.sessionKey, {
    ...session,
    state: "running",
    currentRunId: params.runId,
    currentRequestId: params.requestId,
    nodeWorkerRunId: nextWorkerRunId,
    updatedAt: Date.now(),
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

function handleTurnCancel(params: AcpTurnCancelParams): AcpInvokeCommandResult {
  const session = assertLeaseBinding(nodeAcpSessions.get(params.sessionKey), params);
  if (session.currentRunId && session.currentRunId !== params.runId) {
    return {
      handled: true,
      ok: false,
      code: "INVALID_REQUEST",
      message: `ACP session ${params.sessionKey} active run is ${session.currentRunId}, not ${params.runId}`,
    };
  }
  nodeAcpSessions.set(params.sessionKey, {
    ...session,
    state: "cancelling",
    currentRunId: params.runId,
    updatedAt: Date.now(),
  });
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

function handleSessionClose(params: AcpSessionCloseParams): AcpInvokeCommandResult {
  const session = assertLeaseBinding(nodeAcpSessions.get(params.sessionKey), params);
  nodeAcpSessions.delete(params.sessionKey);
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

function handleSessionStatus(
  frame: NodeInvokeRequestPayload,
  params: AcpSessionStatusParams,
): AcpInvokeCommandResult {
  return {
    handled: true,
    ok: true,
    payload: buildStatusPayload({
      nodeId: frame.nodeId,
      request: params,
      session: nodeAcpSessions.get(params.sessionKey),
    }),
  };
}

export async function handleAcpInvokeCommand(
  frame: NodeInvokeRequestPayload,
): Promise<AcpInvokeCommandResult> {
  if (!ACP_COMMANDS.has(frame.command)) {
    return { handled: false };
  }
  try {
    if (frame.command === "acp.session.ensure" || frame.command === "acp.session.load") {
      return handleEnsureLike(frame, parseEnsureParams(frame));
    }
    if (frame.command === "acp.turn.start") {
      return handleTurnStart(frame, parseTurnStartParams(frame));
    }
    if (frame.command === "acp.turn.cancel") {
      return handleTurnCancel(parseTurnCancelParams(frame));
    }
    if (frame.command === "acp.session.close") {
      return handleSessionClose(parseSessionCloseParams(frame));
    }
    return handleSessionStatus(frame, parseSessionStatusParams(frame));
  } catch (error) {
    return {
      handled: true,
      ok: false,
      code: "INVALID_REQUEST",
      message: String(error instanceof Error ? error.message : error),
    };
  }
}

export const __testing = {
  resetNodeAcpSessionsForTests() {
    nodeAcpSessions.clear();
  },
};
