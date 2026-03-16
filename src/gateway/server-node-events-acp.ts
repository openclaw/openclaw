import type { AcpGatewayStoreResult } from "../acp/store/file-store.js";
import { ErrorCodes, errorShape, type ErrorShape } from "./protocol/index.js";

type GatewayAcpWorkerContext = {
  acpGatewayStore: {
    appendTerminal: (
      input: import("../acp/store/file-store.js").AppendAcpGatewayTerminalInput,
    ) => Promise<AcpGatewayStoreResult<import("../acp/store/file-store.js").AcpGatewayRunRecord>>;
    appendWorkerEvent: (
      input: import("../acp/store/file-store.js").AppendAcpGatewayWorkerEventInput,
    ) => Promise<
      AcpGatewayStoreResult<import("../acp/store/file-store.js").AcpGatewayWorkerEventRecord>
    >;
    recordHeartbeat: (input: {
      sessionKey: string;
      runId: string;
      nodeId: string;
      leaseId: string;
      leaseEpoch: number;
    }) => Promise<
      AcpGatewayStoreResult<import("../acp/store/file-store.js").AcpGatewayLeaseRecord>
    >;
  };
  logGateway: {
    warn: (message: string) => void;
  };
};

type AcpWorkerEventResponse =
  | {
      ok: true;
      payload: {
        ok: true;
        duplicate?: boolean;
      };
    }
  | {
      ok: false;
      error: ErrorShape;
    };

type ParsedAcpWorkerBase = {
  sessionKey: string;
  runId: string;
  nodeId: string;
  leaseId: string;
  leaseEpoch: number;
};

type ParsedBasePayloadResult =
  | {
      value: ParsedAcpWorkerBase;
      raw: Record<string, unknown>;
    }
  | {
      error: ErrorShape;
    };

function parsePayloadObject(payloadJSON?: string | null): Record<string, unknown> | null {
  if (!payloadJSON) {
    return null;
  }
  try {
    const payload = JSON.parse(payloadJSON) as unknown;
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function requireString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requirePositiveInteger(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function invalidPayload(message: string): AcpWorkerEventResponse {
  return {
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, message),
  };
}

function invalidPayloadError(message: string): ErrorShape {
  return errorShape(ErrorCodes.INVALID_REQUEST, message);
}

function mapStoreError(result: Extract<AcpGatewayStoreResult<unknown>, { ok: false }>): ErrorShape {
  return errorShape(ErrorCodes.INVALID_REQUEST, result.message, {
    details: {
      code: result.code,
    },
  });
}

function parseBasePayload(
  payloadJSON: string | null | undefined,
  authenticatedNodeId: string,
): ParsedBasePayloadResult {
  const raw = parsePayloadObject(payloadJSON);
  if (!raw) {
    return { error: invalidPayloadError("ACP worker event payload must be a JSON object.") };
  }
  const sessionKey = requireString(raw, "sessionKey");
  const runId = requireString(raw, "runId");
  const nodeId = requireString(raw, "nodeId");
  const leaseId = requireString(raw, "leaseId");
  const leaseEpoch = requirePositiveInteger(raw, "leaseEpoch");
  if (!sessionKey || !runId || !nodeId || !leaseId || leaseEpoch === null) {
    return {
      error: invalidPayloadError(
        "ACP worker event payload must include sessionKey, runId, nodeId, leaseId, and leaseEpoch.",
      ),
    };
  }
  if (nodeId !== authenticatedNodeId) {
    return {
      error: invalidPayloadError(
        `ACP worker payload nodeId ${nodeId} does not match authenticated node ${authenticatedNodeId}.`,
      ),
    };
  }
  return {
    value: {
      sessionKey,
      runId,
      nodeId,
      leaseId,
      leaseEpoch,
    },
    raw,
  };
}

export function isAcpWorkerNodeEvent(eventName: string): boolean {
  return (
    eventName === "acp.worker.event" ||
    eventName === "acp.worker.terminal" ||
    eventName === "acp.worker.heartbeat"
  );
}

export async function handleAcpWorkerNodeEvent(params: {
  context: GatewayAcpWorkerContext;
  nodeId: string;
  event: string;
  payloadJSON?: string | null;
}): Promise<AcpWorkerEventResponse> {
  const parsed = parseBasePayload(params.payloadJSON, params.nodeId);
  if ("error" in parsed) {
    return {
      ok: false,
      error: parsed.error,
    };
  }

  if (params.event === "acp.worker.event") {
    const seq = requirePositiveInteger(parsed.raw, "seq");
    const eventId = requireString(parsed.raw, "eventId");
    const event = parsed.raw.event;
    if (
      seq === null ||
      !eventId ||
      typeof event !== "object" ||
      event === null ||
      Array.isArray(event)
    ) {
      return invalidPayload("acp.worker.event requires seq, eventId, and an event object.");
    }
    const result = await params.context.acpGatewayStore.appendWorkerEvent({
      ...parsed.value,
      seq,
      eventId,
      event: event as Record<string, unknown>,
    });
    if (!result.ok) {
      params.context.logGateway.warn(
        `acp worker event rejected node=${params.nodeId}: ${result.message}`,
      );
      return {
        ok: false,
        error: mapStoreError(result),
      };
    }
    return {
      ok: true,
      payload: {
        ok: true,
        ...(result.duplicate ? { duplicate: true } : {}),
      },
    };
  }

  if (params.event === "acp.worker.terminal") {
    const finalSeq = requirePositiveInteger(parsed.raw, "finalSeq");
    const terminalEventId = requireString(parsed.raw, "terminalEventId");
    const resultValue = parsed.raw.result;
    if (
      finalSeq === null ||
      !terminalEventId ||
      typeof resultValue !== "object" ||
      resultValue === null ||
      Array.isArray(resultValue)
    ) {
      return invalidPayload(
        "acp.worker.terminal requires finalSeq, terminalEventId, and a result object.",
      );
    }
    const status = requireString(resultValue as Record<string, unknown>, "status");
    if (status !== "completed" && status !== "failed" && status !== "canceled") {
      return invalidPayload(
        "acp.worker.terminal result.status must be completed, failed, or canceled.",
      );
    }
    const terminalResult = {
      status,
      stopReason: requireString(resultValue as Record<string, unknown>, "stopReason") ?? undefined,
      errorCode: requireString(resultValue as Record<string, unknown>, "errorCode") ?? undefined,
      errorMessage:
        requireString(resultValue as Record<string, unknown>, "errorMessage") ?? undefined,
    } as const;
    const result = await params.context.acpGatewayStore.appendTerminal({
      ...parsed.value,
      finalSeq,
      terminalEventId,
      result: terminalResult,
    });
    if (!result.ok) {
      params.context.logGateway.warn(
        `acp worker terminal rejected node=${params.nodeId}: ${result.message}`,
      );
      return {
        ok: false,
        error: mapStoreError(result),
      };
    }
    return {
      ok: true,
      payload: {
        ok: true,
        ...(result.duplicate ? { duplicate: true } : {}),
      },
    };
  }

  if (params.event === "acp.worker.heartbeat") {
    const result = await params.context.acpGatewayStore.recordHeartbeat(parsed.value);
    if (!result.ok) {
      params.context.logGateway.warn(
        `acp worker heartbeat rejected node=${params.nodeId}: ${result.message}`,
      );
      return {
        ok: false,
        error: mapStoreError(result),
      };
    }
    return {
      ok: true,
      payload: {
        ok: true,
      },
    };
  }

  return invalidPayload(`Unsupported ACP worker event ${params.event}.`);
}
