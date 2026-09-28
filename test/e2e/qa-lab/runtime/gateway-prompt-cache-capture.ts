import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Stream } from "@anthropic-ai/sdk/core/streaming.js";
import { bindsClaudeThinkingPrefix } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasInternalRuntimeContext } from "../../../../src/agents/internal-runtime-context.js";
import type { DebugProxyCaptureReader } from "../../../../src/proxy-capture/store-readonly.js";
import type { PromptCacheModel, PromptCacheScenario } from "./gateway-prompt-cache-contract.js";

const CACHE_CAPTURE_EVENT_LIMIT = 512;
const CACHE_CAPTURE_BODY_LIMIT = 2 * 1024 * 1024;
export const CACHE_SCENARIO_REQUEST_LIMIT = 8;
const CACHE_SCENARIO_INPUT_TOKEN_LIMIT = 240_000;
const CACHE_CAPTURE_WAIT_MS = 15_000;

type JsonRecord = Record<string, unknown>;
type CacheUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number | null;
  totalInput: number;
};
export type CacheExchange = {
  flowId: string;
  request: JsonRecord;
  requestHash: string;
  responseHash: string;
  responseId: string;
  model: string;
  api: "anthropic-messages" | "openai-responses";
  usage: CacheUsage;
  captureDisposition?: "verified-terminal-with-response-body-read-failure";
};

export class CacheProofStopError extends Error {
  constructor(
    readonly phase:
      | "deadline"
      | "request-ceiling"
      | "capture-read"
      | "transport-observation"
      | "accounting",
    message: string,
    readonly observation?: ReturnType<typeof captureErrorEvidence>,
  ) {
    super(message);
    this.name = "CacheProofStopError";
  }
}

class CacheAssistantPendingError extends CacheProofStopError {
  constructor() {
    super("accounting", "Failed capture read lacks a successful persisted assistant.");
  }
}

export async function runWithCacheProofStop(
  state: { first?: CacheProofStopError },
  run: () => Promise<void>,
) {
  try {
    await run();
  } catch (error) {
    if (error instanceof CacheProofStopError) {
      state.first ??= error;
    }
    // Emergency shutdown can close an in-flight Gateway call. Preserve
    // the first stop cause instead of replacing it with that cleanup symptom.
    throw state.first ?? error;
  }
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} is missing or is not an object.`);
  }
  return value;
}

function parseRecord(text: string, label: string) {
  try {
    return requireRecord(JSON.parse(text), label);
  } catch {
    // Captured bodies can include credentials or private paths. Never attach the raw parse error.
    throw new Error(`${label} is not a complete JSON object.`);
  }
}

function counter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Missing or invalid provider usage: ${label}.`);
  }
  return value;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

function captureHash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

/** Use the SDK's framing decoder, but independently validate terminal state and raw usage. */
export async function decodeCacheResponse(
  api: CacheExchange["api"],
  body: string,
): Promise<Pick<CacheExchange, "model" | "responseId" | "usage">> {
  // The SDK correctly ignores an unfinished final frame. Proof cannot: a
  // truncated failure after a complete terminal must not silently disappear.
  if (!/(?:\r\n\r\n|\n\n|\r\r)$/.test(body)) {
    throw new Error("Captured SSE ends with an incomplete frame.");
  }
  let started = false;
  let stopped = false;
  let responseId = "";
  let model = "";
  let stopReason: unknown;
  let usage: JsonRecord = {};
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
  for await (const frame of Stream.rawEvents(response)) {
    if (frame.data === "[DONE]") {
      continue;
    }
    const event = frame.event ?? "";
    const known =
      event === "error" ||
      event.startsWith("response.") ||
      ["message_start", "message_delta", "message_stop"].includes(event);
    if (event && !known) {
      continue;
    }
    const data = parseRecord(frame.data, "Provider SSE event");
    if (event && data.type !== undefined && data.type !== event) {
      throw new Error("Provider SSE event contradicts its payload type.");
    }
    const kind = event || data.type;
    if (kind === "error" || kind === "response.failed" || kind === "response.incomplete") {
      throw new Error("Provider stream failed or ended incomplete.");
    }
    if (api === "anthropic-messages") {
      if (kind === "message_start") {
        if (started || stopped) {
          throw new Error("Duplicate Anthropic message_start.");
        }
        started = true;
        const message = requireRecord(data.message, "Anthropic message_start");
        responseId = nonemptyString(message.id, "Anthropic response identity");
        model = nonemptyString(message.model, "Anthropic response model");
        usage = { ...requireRecord(message.usage, "Anthropic initial usage") };
      } else if (kind === "message_delta") {
        if (!started || stopped) {
          throw new Error("Anthropic message_delta outside its message.");
        }
        const delta = requireRecord(data.delta, "Anthropic delta");
        stopReason = delta.stop_reason ?? stopReason;
        // Delta counters are cumulative, and nullable fields do not erase earlier observations.
        for (const [key, value] of Object.entries(
          requireRecord(data.usage, "Anthropic delta usage"),
        )) {
          if (value !== null && value !== undefined) {
            usage[key] = value;
          }
        }
      } else if (kind === "message_stop") {
        if (
          !started ||
          stopped ||
          !["end_turn", "tool_use", "stop_sequence"].includes(String(stopReason))
        ) {
          throw new Error("Anthropic message did not complete successfully.");
        }
        stopped = true;
      }
    } else if (kind === "response.completed") {
      if (stopped) {
        throw new Error("Duplicate OpenAI response terminal.");
      }
      const terminal = requireRecord(data.response, "OpenAI terminal response");
      if (terminal.status !== "completed" || terminal.error || terminal.incomplete_details) {
        throw new Error("OpenAI terminal response is not complete.");
      }
      responseId = nonemptyString(terminal.id, "OpenAI response identity");
      model = nonemptyString(terminal.model, "OpenAI response model");
      usage = requireRecord(terminal.usage, "OpenAI terminal usage");
      stopped = true;
    }
  }
  if (!stopped) {
    throw new Error("Captured SSE is missing its successful terminal event.");
  }
  const input = counter(usage.input_tokens, "input_tokens");
  const output = counter(usage.output_tokens, "output_tokens");
  if (api === "openai-responses") {
    const outputDetails = requireRecord(usage.output_tokens_details, "OpenAI output token details");
    if (
      counter(usage.total_tokens, "total_tokens") !== input + output ||
      counter(outputDetails.reasoning_tokens, "reasoning_tokens") > output
    ) {
      throw new Error("OpenAI terminal usage counters are inconsistent.");
    }
  }
  const details =
    api === "openai-responses"
      ? requireRecord(usage.input_tokens_details, "OpenAI input token details")
      : usage;
  const cacheRead = counter(
    api === "openai-responses" ? details.cached_tokens : usage.cache_read_input_tokens,
    "cache read",
  );
  const rawWrite =
    api === "openai-responses" ? details.cache_write_tokens : usage.cache_creation_input_tokens;
  const cacheWrite =
    rawWrite === undefined || rawWrite === null ? null : counter(rawWrite, "cache write");
  if (api === "anthropic-messages" && cacheWrite === null) {
    throw new Error("Anthropic cache creation usage was not observed.");
  }
  const totalInput = api === "anthropic-messages" ? input + cacheRead + (cacheWrite ?? 0) : input;
  if (cacheRead + (cacheWrite ?? 0) > totalInput) {
    throw new Error("Provider cache counters exceed total input.");
  }
  return { model, responseId, usage: { input, output, cacheRead, cacheWrite, totalInput } };
}

function providerApi(event: JsonRecord): CacheExchange["api"] | undefined {
  if (typeof event.path !== "string") {
    return undefined;
  }
  const endpoint = event.path.split("?")[0];
  if (endpoint === "/v1/messages") {
    return "anthropic-messages";
  }
  if (endpoint === "/v1/responses") {
    return "openai-responses";
  }
  return undefined;
}

function isResponseBodyReadFailure(event: JsonRecord): boolean {
  if (
    event.kind !== "error" ||
    event.direction !== "local" ||
    providerApi(event) !== "openai-responses"
  ) {
    return false;
  }
  try {
    const meta = parseRecord(String(event.metaJson), "Capture metadata");
    return meta.bodyCapture === "failed" && meta.stage === "response-body";
  } catch {
    return false;
  }
}

function captureBody(event: JsonRecord, reader: DebugProxyCaptureReader): string {
  const meta =
    typeof event.metaJson === "string" ? parseRecord(event.metaJson, "Capture metadata") : {};
  const failedRead = isResponseBodyReadFailure(event);
  if (meta.bodyCapture !== undefined && !failedRead) {
    throw new Error("Provider capture body was unavailable, oversized, or stalled.");
  }
  if (failedRead && (typeof event.dataBlobId !== "string" || !event.dataBlobId)) {
    throw new Error("Response-body read failure requires an authoritative capture blob.");
  }
  let body: string | null;
  // The store keeps only an 8 KiB preview inline. A referenced full blob is
  // authoritative; falling back would hide missing capture or truncate valid SSE.
  if (event.dataBlobId !== undefined && event.dataBlobId !== null) {
    if (typeof event.dataBlobId !== "string" || !event.dataBlobId) {
      throw new Error("Provider capture blob reference is invalid.");
    }
    try {
      body = reader.readBlob(event.dataBlobId);
    } catch {
      throw new Error("Provider capture blob could not be read.");
    }
  } else {
    body = typeof event.dataText === "string" ? event.dataText : null;
  }
  if (!body || Buffer.byteLength(body) > CACHE_CAPTURE_BODY_LIMIT) {
    throw new Error(
      failedRead
        ? "Provider capture blob is missing or exceeds the proof bound."
        : "Provider capture body is missing or exceeds the proof bound.",
    );
  }
  return body;
}

function pairCacheCaptureRows(
  rows: JsonRecord[],
  reader?: DebugProxyCaptureReader,
  expected?: PromptCacheModel,
) {
  const failure = rows.find(
    (row) => row.kind === "retry-link" || (row.kind === "error" && !isResponseBodyReadFailure(row)),
  );
  if (failure) {
    throw new CacheProofStopError(
      "transport-observation",
      "Provider transport error or retry was captured.",
      captureErrorEvidence(failure, rows),
    );
  }
  const requests = rows.filter((row) => row.kind === "request");
  const flows = new Map<string, { request: JsonRecord; response?: JsonRecord }>();
  for (const request of requests) {
    const flowId = nonemptyString(request.flowId, "Capture flow identity");
    if (flows.has(flowId)) {
      throw new Error("Duplicate provider request flow.");
    }
    flows.set(flowId, { request });
  }
  for (const response of rows.filter(
    (row) => row.kind === "response" || isResponseBodyReadFailure(row),
  )) {
    const pair = typeof response.flowId === "string" ? flows.get(response.flowId) : undefined;
    if (!pair) {
      throw new Error("Unmatched provider terminal capture.");
    }
    if (pair.response) {
      throw new Error("Duplicate provider terminal capture.");
    }
    if (isResponseBodyReadFailure(response)) {
      if (!reader || !expected) {
        throw new Error("Failed capture read requires the expected provider and capture reader.");
      }
      // Deferral is structural, never acceptance. Validate the official request
      // and authoritative blob before the monitor allows time for persistence.
      prepareCachePair(pair.request, response, reader, expected);
    }
    pair.response = response;
  }
  return [...flows.values()];
}

export function readCacheCaptureRows(
  reader: DebugProxyCaptureReader,
  sessionId: string,
  expected?: PromptCacheModel,
) {
  let rows: JsonRecord[];
  try {
    rows = reader.getSessionEvents(sessionId, CACHE_CAPTURE_EVENT_LIMIT);
  } catch {
    throw new CacheProofStopError("capture-read", "Runtime cache capture could not be read.");
  }
  if (rows.length >= CACHE_CAPTURE_EVENT_LIMIT) {
    throw new CacheProofStopError(
      "capture-read",
      "Capture event limit reached; complete request accounting is unavailable.",
    );
  }
  const providerRows = rows
    .filter(
      (row) => providerApi(row) !== undefined || row.kind === "error" || row.kind === "retry-link",
    )
    .toSorted(
      (left, right) => Number(left.ts) - Number(right.ts) || Number(left.id) - Number(right.id),
    );
  // Only a specific failed response-body read is deferred, not accepted. The
  // terminal decoder still requires the full blob and persisted assistant proof.
  pairCacheCaptureRows(providerRows, reader, expected);
  return providerRows;
}

function captureErrorEvidence(row: JsonRecord, rows: JsonRecord[], verified = false) {
  const requests = rows.filter((entry) => entry.kind === "request");
  const requestIndex = requests.findIndex((entry) => entry.flowId === row.flowId);
  // captureHttpExchange records the request after fetch returns headers. Its
  // same-flow local error records a failed clone read, not an HTTP failure verdict.
  const bodyCapture = row.kind === "error" && row.direction === "local" && requestIndex >= 0;
  const retry = row.kind === "retry-link";
  return {
    request: requestIndex < 0 ? null : requestIndex + 1,
    classification: retry ? "retry-link" : bodyCapture ? "response-body-capture" : "unknown-error",
    stage: isResponseBodyReadFailure(row)
      ? "response-body"
      : retry
        ? "retry"
        : bodyCapture
          ? "after-response-headers"
          : "unknown",
    cause: "unavailable",
    disposition: verified
      ? "verified-terminal-with-response-body-read-failure"
      : isResponseBodyReadFailure(row)
        ? "unverified-response-body-read-failure"
        : "failed",
    errorTextBytes: typeof row.errorText === "string" ? Buffer.byteLength(row.errorText) : null,
    errorTextHash: typeof row.errorText === "string" ? captureHash(row.errorText) : null,
  };
}

export function cacheRequestsComplete(
  rows: JsonRecord[],
  reader?: DebugProxyCaptureReader,
  expected?: PromptCacheModel,
): boolean {
  const pairs = pairCacheCaptureRows(rows, reader, expected);
  return pairs.length > 0 && pairs.every((pair) => pair.response !== undefined);
}

function prepareCachePair(
  request: JsonRecord,
  response: JsonRecord,
  reader: DebugProxyCaptureReader,
  expected: PromptCacheModel,
) {
  const expectedApi: CacheExchange["api"] =
    expected.provider === "anthropic" ? "anthropic-messages" : "openai-responses";
  const expectedHost = expected.provider === "anthropic" ? "api.anthropic.com" : "api.openai.com";
  if (
    providerApi(request) !== expectedApi ||
    providerApi(response) !== expectedApi ||
    request.host !== expectedHost ||
    (isResponseBodyReadFailure(response) && response.host !== expectedHost) ||
    request.method !== "POST" ||
    response.status !== 200 ||
    typeof response.contentType !== "string" ||
    response.contentType.split(";")[0]!.trim().toLowerCase() !== "text/event-stream"
  ) {
    throw new Error("Unexpected provider endpoint, status, or streaming transport.");
  }
  const requestText = captureBody(request, reader);
  const body = parseRecord(requestText, "Provider request");
  if (body.model !== expected.id || body.stream !== true) {
    throw new Error("Provider request used an unexpected model or non-streaming API.");
  }
  const responseText = captureBody(response, reader);
  return { requestText, body, responseText, expectedApi };
}

async function decodeCachePair(
  request: JsonRecord,
  response: JsonRecord,
  reader: DebugProxyCaptureReader,
  expected: PromptCacheModel,
): Promise<CacheExchange> {
  const { requestText, body, responseText, expectedApi } = prepareCachePair(
    request,
    response,
    reader,
    expected,
  );
  const terminal = await decodeCacheResponse(expectedApi, responseText);
  if (terminal.model !== expected.id) {
    throw new Error("Provider response used an unexpected model; fallback is not cache proof.");
  }
  return {
    flowId: nonemptyString(request.flowId, "Capture flow identity"),
    request: body,
    requestHash: captureHash(requestText),
    responseHash: captureHash(responseText),
    api: expectedApi,
    ...terminal,
  };
}

function verifyCapturedTerminal(
  exchange: CacheExchange,
  response: JsonRecord,
  assistant: JsonRecord | undefined,
  expected: PromptCacheModel,
) {
  if (!isResponseBodyReadFailure(response)) {
    return;
  }
  if (exchange.usage.cacheWrite === null) {
    throw new Error("Failed capture read is missing raw cache write usage.");
  }
  if (!assistant) {
    throw new CacheAssistantPendingError();
  }
  if (
    assistant.provider !== expected.provider ||
    !["stop", "toolUse"].includes(String(assistant.stopReason)) ||
    assistant.errorMessage !== undefined
  ) {
    throw new CacheProofStopError(
      "accounting",
      "Failed capture read lacks a successful persisted assistant.",
    );
  }
  try {
    reconcileCacheUsage([exchange], [assistant]);
  } catch {
    throw new CacheProofStopError(
      "accounting",
      "Failed capture read differs from persisted assistant identity or usage.",
    );
  }
  exchange.captureDisposition = "verified-terminal-with-response-body-read-failure";
}

/** Observe early capture failures even while agent.wait is still pending. */
export async function checkCacheReadFailures(
  readRows: () => JsonRecord[],
  reader: DebugProxyCaptureReader,
  expected: PromptCacheModel,
  readMessages: () => JsonRecord[] | Promise<JsonRecord[]>,
  pending: Map<string, number>,
) {
  const messages = await readMessages();
  // History can advance while its RPC is in flight. Read capture afterwards so
  // a newly persisted assistant is never compared with an older request snapshot.
  const rows = readRows();
  const pairs = pairCacheCaptureRows(rows, reader, expected);
  if (pairs.length >= CACHE_SCENARIO_REQUEST_LIMIT) {
    throw new CacheProofStopError(
      "request-ceiling",
      "Runtime cache scenario request budget reached.",
    );
  }
  const assistants = messages.filter((message) => message.role === "assistant");
  if (assistants.length > pairs.length) {
    throw new CacheProofStopError("accounting", "Persisted assistant count differs from capture.");
  }
  for (const [index, pair] of pairs.entries()) {
    if (!pair.response || !isResponseBodyReadFailure(pair.response)) {
      continue;
    }
    const exchange = await decodeCachePair(pair.request, pair.response, reader, expected);
    try {
      verifyCapturedTerminal(exchange, pair.response, assistants[index], expected);
      pending.delete(exchange.flowId);
    } catch (error) {
      if (!(error instanceof CacheAssistantPendingError)) {
        throw error;
      }
      const since = pending.get(exchange.flowId) ?? Date.now();
      pending.set(exchange.flowId, since);
      if (Date.now() - since >= CACHE_CAPTURE_WAIT_MS) {
        throw error;
      }
    }
  }
}

export async function decodeCacheExchanges(
  rows: JsonRecord[],
  reader: DebugProxyCaptureReader,
  expected: PromptCacheModel,
  messages: JsonRecord[] = [],
): Promise<CacheExchange[]> {
  const pairs = pairCacheCaptureRows(rows, reader, expected);
  if (
    !pairs.length ||
    pairs.some((pair) => !pair.response) ||
    pairs.length > CACHE_SCENARIO_REQUEST_LIMIT
  ) {
    throw new Error("Missing provider exchanges or request budget exceeded.");
  }
  const assistants = messages.filter((message) => message.role === "assistant");
  const hasReadFailure = pairs.some((pair) => isResponseBodyReadFailure(pair.response!));
  if (hasReadFailure && assistants.length > pairs.length) {
    throw new CacheProofStopError("accounting", "Persisted assistant count differs from capture.");
  }
  const result: CacheExchange[] = [];
  for (const [index, { request, response }] of pairs.entries()) {
    const exchange = await decodeCachePair(request, response!, reader, expected);
    verifyCapturedTerminal(exchange, response!, assistants[index], expected);
    result.push(exchange);
  }
  if (hasReadFailure && assistants.length < pairs.length) {
    throw new CacheAssistantPendingError();
  }
  if (
    result.reduce((total, exchange) => total + exchange.usage.totalInput, 0) >
    CACHE_SCENARIO_INPUT_TOKEN_LIMIT
  ) {
    throw new Error("Scenario input token budget exceeded.");
  }
  return result;
}

/** Agent completion and capture persistence are separate observable boundaries. */
export async function waitForCacheExchanges(
  readRows: () => JsonRecord[],
  reader: DebugProxyCaptureReader,
  model: PromptCacheModel,
  expectedCount: number,
  options: {
    timeoutMs?: number;
    messages?: JsonRecord[] | (() => JsonRecord[] | Promise<JsonRecord[]>);
  } = {},
) {
  const deadline = Date.now() + (options.timeoutMs ?? CACHE_CAPTURE_WAIT_MS);
  let pending: CacheAssistantPendingError | undefined;
  do {
    const rows = readRows();
    const pairs = pairCacheCaptureRows(rows, reader, model);
    const requests = pairs.length;
    const responses = pairs.filter((pair) => pair.response).length;
    if (requests > expectedCount || responses > expectedCount) {
      throw new Error("Unexpected provider exchanges in the completed turn.");
    }
    if (requests === expectedCount && responses === expectedCount) {
      const messages =
        typeof options.messages === "function" ? await options.messages() : options.messages;
      try {
        return await decodeCacheExchanges(rows, reader, model, messages);
      } catch (error) {
        if (!(error instanceof CacheAssistantPendingError)) {
          throw error;
        }
        pending = error;
      }
    }
    await delay(25);
  } while (Date.now() < deadline);
  throw pending ?? new Error("Completed turn is missing its full terminal capture.");
}

function withoutCacheMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutCacheMetadata);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, withoutCacheMetadata(item)]),
  );
}

function messageBlocks(message: JsonRecord, api: CacheExchange["api"]): unknown[] | undefined {
  if (Array.isArray(message.content)) {
    return message.content;
  }
  // Anthropic's message-level string is exactly one text block. The production
  // cache allocator switches between these wire forms as its breakpoint moves.
  if (api === "anthropic-messages" && typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  return undefined;
}

function messageAtoms(exchange: CacheExchange, retained: boolean): unknown[] {
  const messages =
    exchange.api === "anthropic-messages" ? exchange.request.messages : exchange.request.input;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Provider conversation payload is missing.");
  }
  return messages.flatMap((value) => {
    const message = requireRecord(value, "Provider message");
    const blocks = messageBlocks(message, exchange.api);
    if (blocks) {
      return blocks.flatMap((block) => {
        const content = requireRecord(block, "Provider content block");
        const carrier = typeof content.text === "string" && hasInternalRuntimeContext(content.text);
        if (carrier && !retained) {
          return [];
        }
        return [{ role: message.role, content: withoutCacheMetadata(content) }];
      });
    }
    return [withoutCacheMetadata(message)];
  });
}

function runtimeCarriers(exchange: CacheExchange) {
  const messages = exchange.request.messages ?? exchange.request.input;
  return Array.isArray(messages)
    ? messages.flatMap((message, messageIndex) => {
        const blocks = isRecord(message) ? messageBlocks(message, exchange.api) : undefined;
        return (blocks ?? []).flatMap((block, blockIndex) =>
          isRecord(block) && typeof block.text === "string" && hasInternalRuntimeContext(block.text)
            ? [
                {
                  content: block,
                  role: isRecord(message) ? message.role : undefined,
                  messageIndex,
                  blockIndex,
                  atTail: messageIndex === messages.length - 1 && blockIndex === blocks!.length - 1,
                },
              ]
            : [],
        );
      })
    : [];
}

function retainsRuntimeContext(model: PromptCacheModel): boolean {
  // This matrix uses OpenAI Responses, whose owner replay policy is append-only.
  // Anthropic retention follows the model's prefix-bound thinking contract.
  return model.provider === "openai" || bindsClaudeThinkingPrefix({ id: model.id });
}

function verifyCarrierLifecycle(
  exchanges: CacheExchange[],
  retained: boolean,
  turnBoundary: number,
) {
  const carriers = exchanges.map(runtimeCarriers);
  const original = carriers[0]?.[0];
  for (const [index, current] of carriers.entries()) {
    if (!retained && current.some((entry) => entry.content.cache_control !== undefined)) {
      throw new Error("Transient runtime context owns a cache breakpoint.");
    }
    const expected = retained && index === turnBoundary ? 2 : 1;
    if (current.length !== expected) {
      throw new Error(
        `Runtime carrier count differs on request ${index + 1}: expected ${expected}, observed ${current.length}.`,
      );
    }
    if ((!retained || index === 0 || index === turnBoundary) && !current.at(-1)!.atTail) {
      throw new Error(`Current runtime carrier is not at the tail on request ${index + 1}.`);
    }
    if (current.some((entry) => entry.role !== "user")) {
      throw new Error(`Runtime carrier has a non-user role on request ${index + 1}.`);
    }
    if (retained && original) {
      const historical = current[0]!;
      if (
        historical.messageIndex !== original.messageIndex ||
        historical.blockIndex !== original.blockIndex ||
        captureHash(withoutCacheMetadata(historical.content)) !==
          captureHash(withoutCacheMetadata(original.content))
      ) {
        throw new Error(`Retained runtime carrier moved or changed on request ${index + 1}.`);
      }
    }
  }
}

function atomEvidence(atom: unknown) {
  const content = isRecord(atom) ? atom.content : undefined;
  const type = isRecord(content) ? content.type : undefined;
  return {
    type:
      typeof type === "string" &&
      [
        "text",
        "tool_use",
        "tool_result",
        "thinking",
        "redacted_thinking",
        "image",
        "document",
      ].includes(type)
        ? type
        : atom === undefined
          ? "missing"
          : typeof atom,
    bytes: atom === undefined ? 0 : Buffer.byteLength(JSON.stringify(atom)),
    hash: atom === undefined ? null : captureHash(atom),
  };
}

function historyMismatch(projections: unknown[][]) {
  for (let index = 1; index < projections.length; index += 1) {
    const previous = projections[index - 1]!;
    const current = projections[index]!;
    for (let atom = 0; atom < previous.length; atom += 1) {
      if (atom >= current.length || captureHash(previous[atom]) !== captureHash(current[atom])) {
        return {
          request: index + 1,
          atomOrdinal: atom,
          previousCount: previous.length,
          currentCount: current.length,
          previous: atomEvidence(previous[atom]),
          current: atomEvidence(current[atom]),
        };
      }
    }
  }
  return null;
}

function cacheReuseEvidence(exchanges: CacheExchange[], retained: boolean) {
  return exchanges.slice(1).map((current, index) => {
    const previous = exchanges[index]!;
    const transientBytes = retained
      ? 0
      : runtimeCarriers(previous).reduce(
          (total, carrier) => total + Buffer.byteLength(String(carrier.content.text)),
          0,
        );
    // A removed carrier cannot be cached on the next request. Its UTF-8 byte
    // length conservatively bounds tokens; 128 allows provider cache-block rounding.
    return {
      request: index + 2,
      minimumPrefix: previous.usage.totalInput - transientBytes - 128,
      actualPrefix: current.usage.cacheRead,
      minimumColdGrowth: 1024,
      actualColdGrowth: current.usage.cacheRead - exchanges[0]!.usage.cacheRead,
      previousRequestGrowth: current.usage.cacheRead - previous.usage.cacheRead,
    };
  });
}

function observedUsage(value: unknown) {
  const usage = isRecord(value) ? value : {};
  return Object.fromEntries(
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map((key) => [
      key,
      typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) && usage[key] >= 0
        ? usage[key]
        : null,
    ]),
  );
}

function cacheMarkers(value: unknown): Array<{ contentHash: string; markerHash: string }> {
  if (Array.isArray(value)) {
    return value.flatMap(cacheMarkers);
  }
  if (!isRecord(value)) {
    return [];
  }
  return [
    ...(value.cache_control === undefined
      ? []
      : [
          {
            contentHash: captureHash(withoutCacheMetadata(value)),
            markerHash: captureHash(value.cache_control),
          },
        ]),
    ...Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .flatMap(([, item]) => cacheMarkers(item)),
  ];
}

/** Diagnostic collection cannot turn partial captures or failed assertions into passing proof. */
export async function collectCacheFailureEvidence(
  reader: DebugProxyCaptureReader | undefined,
  captureSession: string,
  model: PromptCacheModel,
  messages: JsonRecord[],
  scenario: PromptCacheScenario,
) {
  const retained = retainsRuntimeContext(model);
  let events: JsonRecord[] = [];
  let captureReadFailed = false;
  try {
    events = reader?.getSessionEvents(captureSession, CACHE_CAPTURE_EVENT_LIMIT) ?? [];
  } catch {
    captureReadFailed = true;
  }
  const rows = events
    .filter(
      (row) => providerApi(row) !== undefined || row.kind === "error" || row.kind === "retry-link",
    )
    .toSorted(
      (left, right) => Number(left.ts) - Number(right.ts) || Number(left.id) - Number(right.id),
    );
  const requests = rows.filter((row) => row.kind === "request");
  const decoded: CacheExchange[] = [];
  const observations = [];
  const assistants = messages.filter((message) => message.role === "assistant");
  let paired = false;
  try {
    paired = cacheRequestsComplete(rows, reader, model);
  } catch {
    // Keep valid per-flow diagnostics, but never ignore an extra or malformed row.
  }
  const verifiedReadFailures = new Set<JsonRecord>();
  for (const [index, request] of requests.slice(0, CACHE_SCENARIO_REQUEST_LIMIT).entries()) {
    const responses = rows.filter(
      (row) => (row.kind === "response" || row.kind === "error") && row.flowId === request.flowId,
    );
    let exchange: CacheExchange | undefined;
    let accountingValid = false;
    try {
      const [pair] = pairCacheCaptureRows([request, ...responses], reader, model);
      if (pair?.response) {
        exchange = await decodeCachePair(request, pair.response, reader!, model);
        verifyCapturedTerminal(exchange, pair.response, assistants[index], model);
        reconcileCacheUsage([exchange], assistants[index] ? [assistants[index]!] : []);
        accountingValid = true;
        if (paired && assistants.length === requests.length && exchange.captureDisposition) {
          verifiedReadFailures.add(pair.response);
        }
      }
    } catch {
      // Provider/parser errors may contain private data. Report validity, never their payload.
    }
    if (exchange) {
      decoded.push(exchange);
    }
    observations.push({
      request: index + 1,
      api: providerApi(request),
      model: exchange?.model ?? null,
      status: typeof responses[0]?.status === "number" ? responses[0].status : null,
      terminalComplete: exchange !== undefined,
      accountingValid,
      requestHash: exchange?.requestHash ?? null,
      responseHash: exchange?.responseHash ?? null,
      rawUsage: exchange?.usage ?? null,
      normalizedUsage: observedUsage(assistants[index]?.usage),
      markers: exchange ? cacheMarkers(exchange.request) : [],
      carriers: exchange
        ? runtimeCarriers(exchange).map((carrier) => ({
            messageIndex: carrier.messageIndex,
            blockIndex: carrier.blockIndex,
            atTail: carrier.atTail,
            contentHash: captureHash(withoutCacheMetadata(carrier.content)),
            markerHash:
              carrier.content.cache_control === undefined
                ? null
                : captureHash(carrier.content.cache_control),
          }))
        : [],
    });
  }
  const complete =
    !captureReadFailed &&
    events.length < CACHE_CAPTURE_EVENT_LIMIT &&
    requests.length === (scenario === "dependent-reads" ? 4 : 2) &&
    assistants.length === requests.length &&
    decoded.length === requests.length &&
    observations.every((row) => row.terminalComplete && row.accountingValid) &&
    paired &&
    rows.filter((row) => row.kind === "response").length + verifiedReadFailures.size ===
      requests.length &&
    decoded.reduce((total, exchange) => total + exchange.usage.totalInput, 0) <=
      CACHE_SCENARIO_INPUT_TOKEN_LIMIT;
  let history: { mismatch: ReturnType<typeof historyMismatch>; projectionValid: boolean } = {
    mismatch: null,
    projectionValid: false,
  };
  if (complete) {
    try {
      history = {
        mismatch: historyMismatch(decoded.map((exchange) => messageAtoms(exchange, retained))),
        projectionValid: true,
      };
    } catch {
      // Invalid shapes remain non-passing; raw fields and parse errors stay private.
    }
  }
  return {
    lifecycle: retained ? "retained" : "transient",
    requestCount: captureReadFailed || !reader ? null : requests.length,
    responseCount:
      captureReadFailed || !reader ? null : rows.filter((row) => row.kind === "response").length,
    transportErrorCount: rows.filter((row) => row.kind === "error" || row.kind === "retry-link")
      .length,
    verifiedTerminalReadFailureCount: verifiedReadFailures.size,
    omittedRequestCount: Math.max(0, requests.length - observations.length),
    captureReadFailed,
    captureLimitReached: events.length >= CACHE_CAPTURE_EVENT_LIMIT,
    captureComplete: complete,
    history,
    captureErrors: rows
      .filter((row) => row.kind === "error" || row.kind === "retry-link")
      .slice(0, CACHE_SCENARIO_REQUEST_LIMIT)
      .map((row) => captureErrorEvidence(row, rows, verifiedReadFailures.has(row))),
    requests: observations,
    reuse: complete ? cacheReuseEvidence(decoded, retained) : [],
    firstReadReuse:
      complete && scenario === "dependent-reads" && decoded.length >= 3
        ? { minimum: 1024, actual: decoded[2]!.usage.cacheRead - decoded[1]!.usage.cacheRead }
        : null,
  };
}

/** Compare the meaningful conversation, not a best-of hit rate or a system-only cache hit. */
export function verifyCacheConversation(
  exchanges: CacheExchange[],
  model: PromptCacheModel,
  scenario: PromptCacheScenario,
  turnBoundary: number,
) {
  const expectedCount = scenario === "dependent-reads" ? 4 : 2;
  if (exchanges.length !== expectedCount || turnBoundary !== expectedCount - 1) {
    throw new Error("Unexpected request count; retries or extra model turns are not cache proof.");
  }
  const retained = retainsRuntimeContext(model);
  const first = exchanges[0]!;
  verifyCarrierLifecycle(exchanges, retained, turnBoundary);
  const staticPrefix = captureHash(
    withoutCacheMetadata({
      system: first.request.system,
      instructions: first.request.instructions,
      tools: first.request.tools,
    }),
  );
  const projections = exchanges.map((exchange) => {
    if (
      captureHash(
        withoutCacheMetadata({
          system: exchange.request.system,
          instructions: exchange.request.instructions,
          tools: exchange.request.tools,
        }),
      ) !== staticPrefix
    ) {
      throw new Error("System or tool definitions changed within the cache scenario.");
    }
    return messageAtoms(exchange, retained);
  });
  const mismatch = historyMismatch(projections);
  if (mismatch) {
    throw new Error(
      `Eligible historical conversation content changed before the next request: ${JSON.stringify(mismatch)}.`,
    );
  }
  for (const reuse of cacheReuseEvidence(exchanges, retained)) {
    if (
      reuse.actualPrefix < reuse.minimumPrefix ||
      reuse.actualColdGrowth < reuse.minimumColdGrowth
    ) {
      throw new Error(
        `Request ${reuse.request} did not reuse the preceding conversation beyond the cold cache baseline.`,
      );
    }
  }
  if (
    scenario === "dependent-reads" &&
    exchanges[2]!.usage.cacheRead - exchanges[1]!.usage.cacheRead < 1024
  ) {
    throw new Error("The second tool continuation did not cache the large first read result.");
  }
  return {
    lifecycle: retained ? "retained" : "transient",
    prefixHash: captureHash(projections[0]),
    requestCount: exchanges.length,
    requests: exchanges.map(
      ({ request: _request, flowId: _flowId, responseId: _responseId, ...proof }) => proof,
    ),
  };
}

/** Reconcile each provider response with its persisted assistant, not a session sum. */
export function reconcileCacheUsage(exchanges: CacheExchange[], messages: JsonRecord[]) {
  const assistants = messages.filter((message) => message.role === "assistant");
  if (assistants.length !== exchanges.length) {
    throw new Error("Persisted assistant count differs from the provider exchange count.");
  }
  return exchanges.map((exchange, index) => {
    const assistant = assistants[index]!;
    const usage = requireRecord(assistant.usage, "Persisted assistant usage");
    if (
      assistant.responseId !== exchange.responseId ||
      assistant.model !== exchange.model ||
      assistant.api !== exchange.api
    ) {
      throw new Error("Persisted assistant identity differs from its provider response.");
    }
    const raw = exchange.usage;
    // OpenAI input includes both cache buckets; Anthropic input excludes them.
    // The runtime's numeric write default is checked, but never upgrades an
    // absent raw counter into observed zero-write evidence.
    const expected = {
      input:
        exchange.api === "openai-responses"
          ? raw.input - raw.cacheRead - (raw.cacheWrite ?? 0)
          : raw.input,
      output: raw.output,
      cacheRead: raw.cacheRead,
      cacheWrite: raw.cacheWrite ?? 0,
      totalTokens: raw.totalInput + raw.output,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (counter(usage[key], `persisted ${key}`) !== value) {
        throw new Error(`Persisted assistant ${index + 1} ${key} differs from raw provider usage.`);
      }
    }
    return { ...expected, rawCacheWriteObserved: raw.cacheWrite !== null };
  });
}

export function verifyDependentReadHistory(
  messages: JsonRecord[],
  firstPath: string,
  secondPath: string,
  answer: string,
  workspace = ".",
) {
  const calls: Array<{ id: unknown; path: unknown }> = [];
  const results: JsonRecord[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === "toolCall") {
          if (block.name !== "read" || !isRecord(block.arguments)) {
            throw new Error("Dependent-read scenario called an unexpected tool.");
          }
          calls.push({ id: block.id, path: block.arguments.path ?? block.arguments.file_path });
        }
      }
    } else if (message.role === "toolResult") {
      if (message.toolName !== "read" || message.isError === true) {
        throw new Error("Dependent-read scenario did not complete a read successfully.");
      }
      results.push(message);
    }
  }
  if (
    calls.length !== 2 ||
    results.length !== 2 ||
    typeof calls[0]!.path !== "string" ||
    typeof calls[1]!.path !== "string" ||
    path.resolve(workspace, calls[0]!.path) !== path.resolve(workspace, firstPath) ||
    path.resolve(workspace, calls[1]!.path) !== path.resolve(workspace, secondPath) ||
    results[0]!.toolCallId !== calls[0]!.id ||
    results[1]!.toolCallId !== calls[1]!.id ||
    !JSON.stringify(results[0]!.content).includes(secondPath) ||
    !JSON.stringify(results[1]!.content).includes(answer)
  ) {
    throw new Error("Dependent reads did not preserve the required tool/result order.");
  }
  const firstResultIndex = messages.indexOf(results[0]!);
  const secondCallIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (block) => isRecord(block) && block.type === "toolCall" && block.id === calls[1]!.id,
      ),
  );
  if (secondCallIndex <= firstResultIndex) {
    throw new Error("Second read was not dependent on the first completed result.");
  }
}
