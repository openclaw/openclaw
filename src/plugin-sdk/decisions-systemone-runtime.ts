import {
  decodeSystemOneResponse,
  encodeSystemOneQuestions,
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionProviderContextV2,
  type ProviderDecisionOutcomeV2,
} from "./decisions.js";
import { fetchWithProviderHttpGuard, readProviderJsonResponse } from "./provider-http.js";

// Liquid's documented complete JSON-body limit includes base64, state and questions.
const MAX_REQUEST_BYTES = 4_500_000;

export function supportsLiquidDecisionBatch(batch: DecisionBatchV2): boolean {
  if (!validateDecisionBatchV2(batch) || batch.state.type === "list") {
    return false;
  }
  if (
    batch.state.type === "json" &&
    (batch.state.value === null ||
      (typeof batch.state.value !== "string" && typeof batch.state.value !== "object"))
  ) {
    return false;
  }
  return Object.values(batch.questions).every((question) => {
    if (question.type === "boolean") {
      return (
        question.instructions != null ||
        Object.values(question.criteria ?? {}).some((value) => value != null)
      );
    }
    return question.type === "choice" || question.type === "score";
  });
}

export function encodeLiquidDecisionRequest(
  batch: DecisionBatchV2,
  modelId: string,
): string | undefined {
  const body = JSON.stringify({
    model: modelId,
    state:
      batch.state.type === "text"
        ? batch.state.text
        : batch.state.type === "json"
          ? batch.state.value
          : batch.state.type === "image"
            ? (batch.state.text ?? "")
            : undefined,
    ...(batch.state.type === "image" ? { images: [batch.state.dataUri] } : {}),
    questions: encodeSystemOneQuestions(batch),
  });
  return Buffer.byteLength(body) >= MAX_REQUEST_BYTES ? undefined : body;
}

function supportsLiquidImageDimensions(
  metadata: { width: number; height: number } | null,
): boolean {
  return !(
    !metadata ||
    metadata.width <= 0 ||
    metadata.height <= 0 ||
    Math.max(metadata.width, metadata.height) > 100 * Math.min(metadata.width, metadata.height) ||
    Math.ceil(metadata.width / 32) * Math.ceil(metadata.height / 32) > 10_000
  );
}

function decodeLiquidDecisionResult(
  batch: DecisionBatchV2,
  value: unknown,
  capabilities: Parameters<typeof validateDecisionResultV2>[2],
): ProviderDecisionOutcomeV2 {
  const result = decodeSystemOneResponse(batch, value);
  return validateDecisionResultV2(batch, result, capabilities) && result.usage?.outputTokens === 0
    ? { status: "ok", result }
    : { status: "unavailable", reason: "invalid-response" };
}

type GuardOptions = Parameters<typeof fetchWithProviderHttpGuard>[0];
type LiquidDecisionTransport = Pick<GuardOptions, "url" | "policy" | "dispatcherPolicy"> & {
  headers: HeadersInit;
};

type LiquidDecisionExecution = Pick<
  DecisionProviderContextV2,
  "signal" | "deadlineMonotonicMs" | "isAdmissible"
> & {
  body: string;
  capabilities: Parameters<typeof decodeLiquidDecisionResult>[2];
  getImageMetadata: (buffer: Buffer) => Promise<{ width: number; height: number } | null>;
  prepareTransport: () => LiquidDecisionTransport;
};

export async function executeLiquidDecision(
  batch: DecisionBatchV2,
  execution: LiquidDecisionExecution,
): Promise<ProviderDecisionOutcomeV2> {
  let release: (() => Promise<void>) | undefined;
  let admissionError: { error: unknown } | undefined;
  const assertActive = () => {
    execution.signal.throwIfAborted();
    let admitted: boolean;
    try {
      admitted = execution.isAdmissible();
    } catch (error) {
      admissionError = { error };
      throw error;
    }
    if (!admitted || performance.now() >= execution.deadlineMonotonicMs) {
      throw new Error("Liquid Decision is no longer admitted.");
    }
  };
  try {
    assertActive();
    if (batch.state.type === "image") {
      const metadata = await execution.getImageMetadata(
        Buffer.from(batch.state.dataUri.split(",", 2)[1]!, "base64"),
      );
      assertActive();
      if (!supportsLiquidImageDimensions(metadata)) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
    }
    const transport = execution.prepareTransport();
    assertActive();
    const guarded = await fetchWithProviderHttpGuard({
      url: transport.url,
      init: { method: "POST", headers: transport.headers, body: execution.body },
      signal: execution.signal,
      timeoutMs: execution.deadlineMonotonicMs - performance.now(),
      beforeRequest: assertActive,
      policy: transport.policy,
      dispatcherPolicy: transport.dispatcherPolicy,
      auditContext: "liquid-ai-decisions",
    });
    release = guarded.release;
    const response = guarded.response;
    if (!response.ok) {
      return {
        status: "unavailable",
        reason:
          response.status === 401 || response.status === 403
            ? "authentication"
            : response.status === 429
              ? "rate-limited"
              : [400, 413, 422].includes(response.status)
                ? "unsupported-input"
                : "transport",
      };
    }
    let value: unknown;
    try {
      value = await readProviderJsonResponse(response, "Liquid decisions", {
        maxBytes: 1_048_576,
        timeoutMs: Math.max(1, execution.deadlineMonotonicMs - performance.now()),
      });
    } catch {
      execution.signal.throwIfAborted();
      return { status: "unavailable", reason: "invalid-response" };
    }
    assertActive();
    return decodeLiquidDecisionResult(batch, value, execution.capabilities);
  } catch {
    execution.signal.throwIfAborted();
    if (admissionError) {
      throw admissionError.error;
    }
    return { status: "unavailable", reason: "transport" };
  } finally {
    await release?.();
  }
}
