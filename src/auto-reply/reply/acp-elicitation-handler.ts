import { createHash } from "node:crypto";
import type {
  AcpElicitationHandler,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpJsonRpcId,
} from "@openclaw/acp-core/runtime/types";
import { runStructuredInput } from "../../agents/harness/structured-input-execution.js";
import {
  compileStructuredInputForm,
  compileStructuredInputUrl,
  isStructuredInputRecord,
  snapshotStructuredInput,
  type StructuredInputCompileResult,
  type StructuredInputRecord,
  type StructuredInputValue,
} from "../../agents/harness/structured-input.js";
import type { ReplyPayload } from "../types.js";

const MAX_CORRELATION_TEXT = 128;

type ParsedAcpElicitationRequest = {
  input: StructuredInputCompileResult;
  correlation?:
    | { sessionId: string; toolCallId?: string | null }
    | { requestId: string | number | null };
};

/** Adapts ACP wire scope and codex-acp metadata into the shared structured-input compiler. */
function parseAcpElicitationRequest(request: AcpElicitationRequest): ParsedAcpElicitationRequest {
  const snapshot = snapshotStructuredInput(request);
  if (!isStructuredInputRecord(snapshot)) {
    return unsupported("OpenClaw declined a malformed or over-limit ACP input request.");
  }
  const correlation = readScope(snapshot);
  if (typeof correlation === "string") {
    return unsupported(correlation);
  }
  const mode = readAcpElicitationString(snapshot, "mode");
  if (mode === "url") {
    return {
      correlation,
      input: compileStructuredInputUrl({
        url: readValue(snapshot, "url"),
        elicitationId: readValue(snapshot, "elicitationId"),
        message: readValue(snapshot, "message"),
        fallbackMessage: "ACP provided a URL",
        protocolName: "ACP",
      }),
    };
  }
  if (mode !== "form") {
    return unsupported(
      `OpenClaw does not support ACP elicitation mode ${JSON.stringify(mode ?? "unknown")}.`,
    );
  }
  return {
    correlation,
    input: compileStructuredInputForm({
      schema: readValue(snapshot, "requestedSchema"),
      message: readAcpElicitationString(snapshot, "message"),
      fallbackMessage: "ACP needs input",
      options: {
        protocolName: "ACP",
        allowEmptyForm: true,
        minimumChoiceCount: 2,
        booleanLabels: ["True", "False"],
        metadata: {
          secretPath: ["_meta", "codex", "isSecret"],
          otherAnswerPath: ["_meta", "codex", "isOtherAnswer"],
          otherQuestionIdPath: ["_meta", "codex", "questionId"],
        },
      },
    }),
  };
}

function readScope(
  request: StructuredInputRecord,
): ParsedAcpElicitationRequest["correlation"] | string {
  const sessionId = readValue(request, "sessionId");
  const requestId = readValue(request, "requestId");
  const hasSession = sessionId !== undefined;
  const hasRequest = requestId !== undefined;
  if (hasSession === hasRequest) {
    return "OpenClaw declined an ACP input request with an invalid or ambiguous scope.";
  }
  if (hasSession) {
    const normalizedSessionId = readCorrelationText(sessionId);
    if (!normalizedSessionId) {
      return "OpenClaw declined an ACP input request with an invalid session id.";
    }
    const toolCallId = readValue(request, "toolCallId");
    const normalizedToolCallId =
      toolCallId === undefined || toolCallId === null
        ? toolCallId
        : readCorrelationText(toolCallId);
    if (toolCallId !== undefined && toolCallId !== null && !normalizedToolCallId) {
      return "OpenClaw declined an ACP input request with an invalid tool-call id.";
    }
    return {
      sessionId: normalizedSessionId,
      ...(toolCallId === undefined ? {} : { toolCallId: normalizedToolCallId ?? null }),
    };
  }
  if (requestId === null || typeof requestId === "number") {
    return { requestId };
  }
  const normalizedRequestId = readCorrelationText(requestId);
  return normalizedRequestId
    ? { requestId: normalizedRequestId }
    : "OpenClaw declined an ACP input request with an invalid request scope.";
}

function readCorrelationText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CORRELATION_TEXT) {
    return undefined;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return undefined;
    }
  }
  return value;
}

function readValue(record: StructuredInputRecord, key: string): StructuredInputValue | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readAcpElicitationString(record: StructuredInputRecord, key: string): string | undefined {
  const value = readValue(record, key);
  return typeof value === "string" ? value : undefined;
}

function unsupported(message: string): ParsedAcpElicitationRequest {
  return { input: { kind: "unsupported", message } };
}

const DEFAULT_ELICITATION_TIMEOUT_MS = 15 * 60_000;
const MAX_REQUEST_ID_TEXT = 128;

export type AcpElicitationHandlerParams = {
  sourceSessionKey: string;
  targetSessionKey: string;
  outerRequestId: string;
  agentId: string;
  runId: string;
  delivery: {
    deliver: (kind: "block", payload: ReplyPayload) => Promise<boolean>;
  };
  /** The turn's sender is a bot, so its questions go to the agent's owner. */
  senderIsBot?: boolean;
  isActive: () => boolean;
};

function questionId(params: {
  contextRequestId: AcpJsonRpcId;
  correlation: unknown;
  sourceSessionKey: string;
  targetSessionKey: string;
  outerRequestId: string;
  batch: number;
}): string {
  const digest = createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 24);
  return `acp_${digest}_${params.batch}`;
}

function cancellation(message: string): AcpElicitationResponse {
  return { action: "cancel", _meta: { message } };
}

function isContextRequestIdValid(value: AcpJsonRpcId): boolean {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_TEXT)
  );
}

/** Creates the turn-owned ACP form/URL bridge used by channel delivery. */
export function createAcpElicitationHandler(
  params: AcpElicitationHandlerParams,
): AcpElicitationHandler {
  const delivery = {
    onBlockReply: async (payload: ReplyPayload) => {
      await params.delivery.deliver("block", payload);
    },
    senderIsBot: params.senderIsBot,
  };
  return async (request, context) => {
    if (
      !isContextRequestIdValid(context.requestId) ||
      context.signal.aborted ||
      !params.isActive()
    ) {
      return cancellation("ACP input request is no longer active.");
    }
    const parsed = parseAcpElicitationRequest(request);
    const result = await runStructuredInput({
      input: parsed.input,
      sessionKey: params.targetSessionKey,
      agentId: params.agentId,
      runId: params.runId,
      timeoutMs: DEFAULT_ELICITATION_TIMEOUT_MS,
      delivery,
      signal: context.signal,
      isActive: params.isActive,
      questionId: (batch) =>
        questionId({
          contextRequestId: context.requestId,
          correlation: parsed.correlation,
          sourceSessionKey: params.sourceSessionKey,
          targetSessionKey: params.targetSessionKey,
          outerRequestId: params.outerRequestId,
          batch,
        }),
      promptOptions: {
        unsupportedIntro: "ACP input request could not be shown:",
        urlIntro: "ACP needs confirmation:",
      },
    });
    if (result.status === "answered") {
      return parsed.input.kind === "ready" && parsed.input.plan.kind === "url"
        ? { action: "accept" }
        : { action: "accept", content: result.content };
    }
    if (result.status === "declined" || result.status === "unsupported") {
      return {
        action: "decline",
        ...(result.message ? { _meta: { message: result.message } } : {}),
      };
    }
    return cancellation(result.message ?? "ACP input request was cancelled.");
  };
}
