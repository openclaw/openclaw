import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../../../packages/agent-core/src/harness/messages.js";
import { convertAnthropicMessages } from "../../../../packages/ai/src/transports/anthropic-messages.js";
import { applyAnthropicRequestCacheControl } from "../../../../packages/ai/src/transports/anthropic-payload-policy.js";
import {
  convertProviderResponsesMessages,
  convertResponsesMessages,
  createOpenAIResponsesAssistantOutput,
} from "../../../../packages/ai/src/transports/openai-responses-replay-messages-internal.js";
import { buildRuntimeContextCustomMessage } from "../../../../src/agents/embedded-agent-runner/run/runtime-context-prompt.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../../../src/agents/internal-runtime-context.js";
import { buildRuntimeFactsContext } from "../../../../src/agents/runtime-facts-prompt.js";
import {
  createDebugProxyCaptureReader,
  type DebugProxyCaptureReader,
} from "../../../../src/proxy-capture/store-readonly.js";
import {
  DebugProxyCaptureStore,
  persistEventPayload,
} from "../../../../src/proxy-capture/store.sqlite.js";
import { closeOpenClawStateDatabaseByPath } from "../../../../src/state/openclaw-state-db.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  cacheRequestsComplete,
  CacheProofStopError,
  collectCacheFailureEvidence,
  checkCacheReadFailures,
  decodeCacheExchanges,
  decodeCacheResponse,
  readCacheCaptureRows,
  reconcileCacheUsage,
  runWithCacheProofStop,
  verifyCacheConversation,
  verifyDependentReadHistory,
  waitForCacheExchanges,
  type CacheExchange,
} from "./gateway-prompt-cache-capture.js";
import {
  GATEWAY_PROMPT_CACHE_SCENARIOS,
  gatewayPromptCacheCaseId,
  gatewayPromptCacheModels,
  validateGatewayPromptCacheAssertions,
  type PromptCacheScenario,
} from "./gateway-prompt-cache-contract.js";
import {
  assertGatewayPromptCacheStopped,
  gatewayPromptCacheOptions,
  stopGatewayPromptCacheFixture,
} from "./gateway-prompt-cache-fixture.js";

const sonnet = gatewayPromptCacheModels()[1]!;
const fable = gatewayPromptCacheModels()[2]!;
const openai = gatewayPromptCacheModels()[0]!;
const sse = (event: string, data: unknown) =>
  `${event ? `event: ${event}\r\n` : ""}data: ${JSON.stringify(data)}\r\n\r\n`;
const initialUsage = {
  input_tokens: 10,
  output_tokens: 1,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 200,
};
function anthropicStream(stop = "end_turn") {
  return (
    sse("message_start", { message: { id: "msg_test", model: sonnet.id, usage: initialUsage } }) +
    sse("message_delta", { delta: {}, usage: { output_tokens: 4 } }) +
    sse("message_delta", {
      delta: { stop_reason: stop },
      usage: { output_tokens: 6, cache_read_input_tokens: null },
    }) +
    sse("message_stop", {})
  );
}
function openaiStream(usage: unknown, status = "completed", responseId = "resp_test") {
  // Responses also supports data-only SSE frames; the SDK owns framing.
  return sse("", {
    type: `response.${status}`,
    response: { id: responseId, model: openai.id, status, usage },
  });
}
const openaiUsage = {
  input_tokens: 500,
  output_tokens: 9,
  total_tokens: 509,
  output_tokens_details: { reasoning_tokens: 0 },
  input_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
};
const reader = { getSessionEvents: () => [], readBlob: () => null };

function persistedOpenaiAssistant(): Record<string, unknown> {
  return {
    role: "assistant",
    provider: "openai",
    model: openai.id,
    api: "openai-responses",
    responseId: "resp_test",
    stopReason: "stop",
    usage: { input: 100, output: 9, cacheRead: 300, cacheWrite: 100, totalTokens: 509 },
  };
}

function carrier(text: string, cached = false) {
  return {
    type: "text",
    text: `${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n${text}\n${INTERNAL_RUNTIME_CONTEXT_END}`,
    ...(cached ? { cache_control: { type: "ephemeral" } } : {}),
  };
}
function message(role: string, content: unknown[]) {
  return { role, content };
}
function exchange(messages: unknown[], cacheRead = 0): CacheExchange {
  return {
    flowId: "test-flow",
    requestHash: "request-hash",
    responseHash: "response-hash",
    responseId: "response-test",
    model: sonnet.id,
    api: "anthropic-messages",
    request: { system: [{ type: "text", text: "system" }], tools: [], messages },
    usage: { input: 50, output: 8, cacheRead, cacheWrite: 7950 - cacheRead, totalInput: 8000 },
  };
}
function conversation(retained = false): CacheExchange[] {
  const seed = message("user", [{ type: "text", text: "unique long user seed" }]);
  const context = message("user", [carrier("turn one", retained)]);
  const reply = message("assistant", [{ type: "text", text: "ready" }]);
  const followup = message("user", [{ type: "text", text: "repeat" }]);
  return [
    exchange([seed, context]),
    exchange(
      structuredClone([
        seed,
        ...(retained ? [context] : []),
        reply,
        followup,
        message("user", [carrier("turn two")]),
      ]),
      7950,
    ),
  ];
}
function readHistory() {
  return [
    message("assistant", [
      { type: "toolCall", id: "a", name: "read", arguments: { path: "a.txt" } },
    ]),
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "a",
      content: [{ type: "text", text: "next: b-random.txt" }],
    },
    message("assistant", [
      { type: "toolCall", id: "b", name: "read", arguments: { path: "b-random.txt" } },
    ]),
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "b",
      content: [{ type: "text", text: "opaque-answer" }],
    },
  ];
}

describe("raw cache stream evidence", () => {
  it("merges cumulative Anthropic deltas without adding or erasing counters", async () => {
    expect(await decodeCacheResponse("anthropic-messages", anthropicStream())).toEqual({
      model: sonnet.id,
      responseId: "msg_test",
      usage: { input: 10, output: 6, cacheRead: 100, cacheWrite: 200, totalInput: 310 },
    });
  });
  it("reads raw OpenAI cached and cache-write input without double counting", async () => {
    const decoded = await decodeCacheResponse("openai-responses", openaiStream(openaiUsage));
    expect(decoded.usage).toEqual({
      input: 500,
      output: 9,
      cacheRead: 300,
      cacheWrite: 100,
      totalInput: 500,
    });
    const absent = await decodeCacheResponse(
      "openai-responses",
      openaiStream({
        ...openaiUsage,
        input_tokens_details: { cached_tokens: 0 },
      }),
    );
    expect(absent.usage.cacheWrite).toBeNull();
    expect(absent.usage.cacheRead).toBe(0);
  });
  it.each(["failed", "incomplete"])("rejects OpenAI %s terminals", async (status) => {
    await expect(
      decodeCacheResponse("openai-responses", openaiStream(openaiUsage, status)),
    ).rejects.toThrow("incomplete");
  });
  it.each(["max_tokens", "refusal"])("rejects Anthropic %s termination", async (reason) => {
    await expect(
      decodeCacheResponse("anthropic-messages", anthropicStream(reason)),
    ).rejects.toThrow("complete");
  });
  it("rejects missing terminal, malformed data, duplicate terminal and provider error", async () => {
    for (const body of [
      anthropicStream().replace(sse("message_stop", {}), ""),
      "event: message_start\ndata: {broken\n\n",
      anthropicStream() + sse("message_stop", {}),
      anthropicStream() + sse("error", { error: { message: "private provider detail" } }),
    ]) {
      await expect(decodeCacheResponse("anthropic-messages", body)).rejects.toThrow();
    }
  });
  it("allows nonblocking unknown events and SDK multiline/comment framing", async () => {
    const body =
      ": heartbeat\r\n\r\n" +
      sse("future_event", { anything: true }) +
      anthropicStream().replace('data: {"message":', 'data: {\r\ndata: "message":');
    expect((await decodeCacheResponse("anthropic-messages", body)).usage.output).toBe(6);
  });
  it("does not turn missing usage into zero", async () => {
    await expect(
      decodeCacheResponse(
        "openai-responses",
        openaiStream({
          ...openaiUsage,
          input_tokens_details: {},
        }),
      ),
    ).rejects.toThrow("cache read");
  });
  it("requires one paired complete official HTTP/SSE exchange for the selected model", async () => {
    const rows = [
      {
        kind: "request",
        flowId: "flow",
        host: "api.openai.com",
        path: "/v1/responses",
        method: "POST",
        dataText: JSON.stringify({ model: openai.id, stream: true }),
      },
      {
        kind: "response",
        flowId: "flow",
        path: "/v1/responses",
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        dataText: openaiStream(openaiUsage),
      },
    ];
    expect(cacheRequestsComplete(rows)).toBe(true);
    expect(await decodeCacheExchanges(rows, reader, openai)).toHaveLength(1);
    expect(cacheRequestsComplete(rows.slice(0, 1))).toBe(false);
    for (const invalid of [
      [rows[0]!, { ...rows[1], flowId: "unmatched" }],
      [rows[0]!, { ...rows[1], status: 429 }],
      [{ ...rows[0], host: "proxy.example" }, rows[1]!],
      [{ ...rows[0], dataText: "{}" }, rows[1]!],
      [rows[0]!, { ...rows[1], metaJson: '{"bodyCapture":"stalled"}' }],
      [rows[0]!, { ...rows[1], dataText: undefined }],
      [
        rows[0]!,
        { ...rows[1], dataText: openaiStream(openaiUsage).replace(openai.id, "other-model") },
      ],
    ]) {
      await expect(decodeCacheExchanges(invalid, reader, openai)).rejects.toThrow();
    }
  });
  it.each([
    { kind: "error", phase: "transport-observation" },
    { kind: "retry-link", phase: "transport-observation" },
    { kind: "overflow", phase: "capture-read" },
    { kind: "storage", phase: "capture-read" },
  ])("classifies $kind without relabeling it as a budget stop", ({ kind, phase }) => {
    const failure = (() => {
      try {
        readCacheCaptureRows(
          {
            ...reader,
            getSessionEvents: () => {
              if (kind === "storage") {
                throw new Error("private storage detail");
              }
              return kind === "overflow"
                ? Array.from({ length: 512 }, () => ({}))
                : [{ kind, path: "/v1/messages", errorText: "private transport detail" }];
            },
          },
          "capture",
        );
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(CacheProofStopError);
    expect(failure).toMatchObject({ phase });
    expect(String(failure)).not.toContain("private");
  });
  it("waits for the complete expected phase, not an earlier complete prefix", async () => {
    const pair = (flowId: string) => [
      {
        kind: "request",
        flowId,
        host: "api.openai.com",
        path: "/v1/responses",
        method: "POST",
        dataText: JSON.stringify({ model: openai.id, stream: true }),
      },
      {
        kind: "response",
        flowId,
        path: "/v1/responses",
        status: 200,
        contentType: "text/event-stream",
        dataText: openaiStream(openaiUsage),
      },
    ];
    const first = pair("first");
    const second = pair("second");
    const snapshots = [[], first, [...first, second[0]!], [...first, ...second]];
    let reads = 0;
    const result = await waitForCacheExchanges(
      () => snapshots[Math.min(reads++, snapshots.length - 1)]!,
      reader,
      openai,
      2,
    );
    expect(result).toHaveLength(2);
    expect(reads).toBe(4);
    await expect(
      waitForCacheExchanges(() => first, reader, openai, 2, { timeoutMs: 1 }),
    ).rejects.toThrow("full terminal capture");
    await expect(
      waitForCacheExchanges(() => [...first, ...second], reader, openai, 1),
    ).rejects.toThrow("Unexpected");
  });
});

describe("cache first-stop evidence", () => {
  it("records and rethrows a foreground capture failure before the monitor observes it", async () => {
    const state: { first?: CacheProofStopError } = {};
    const captureFailure = new CacheProofStopError("capture-read", "Capture read failed.");
    await expect(
      runWithCacheProofStop(state, async () => {
        throw captureFailure;
      }),
    ).rejects.toBe(captureFailure);
    expect(state.first).toBe(captureFailure);
  });

  it.each(["lifecycle", "capture"] as const)(
    "retains an earlier monitor failure instead of a later %s error",
    async (kind) => {
      const first = new CacheProofStopError("transport-observation", "Transport failure observed.");
      const state = { first };
      await expect(
        runWithCacheProofStop(state, async () => {
          throw kind === "lifecycle"
            ? new Error("qa gateway child lifecycle is closed")
            : new CacheProofStopError("capture-read", "Later capture failure.");
        }),
      ).rejects.toBe(first);
      expect(state.first).toBe(first);
    },
  );

  it("preserves the original decode error without inventing a stop reason", async () => {
    const state: { first?: CacheProofStopError } = {};
    const decodeFailure = new Error("Provider request is not a complete JSON object.");
    await expect(
      runWithCacheProofStop(state, async () => {
        throw decodeFailure;
      }),
    ).rejects.toBe(decodeFailure);
    expect(state.first).toBeUndefined();
  });
});

describe("verified Responses terminal with a capture read failure", () => {
  function fixture() {
    const request: Record<string, unknown> = {
      id: 1,
      kind: "request",
      flowId: "private-flow",
      host: "api.openai.com",
      path: "/v1/responses",
      method: "POST",
      dataText: JSON.stringify({ model: openai.id, stream: true }),
    };
    const terminal: Record<string, unknown> = {
      id: 2,
      kind: "error",
      direction: "local",
      flowId: "private-flow",
      host: "api.openai.com",
      path: "/v1/responses",
      status: 200,
      contentType: "text/event-stream",
      metaJson: JSON.stringify({ bodyCapture: "failed", stage: "response-body" }),
      dataBlobId: "terminal-blob",
      dataText: openaiStream(openaiUsage),
      errorText: "private response body failure",
    };
    const assistant = persistedOpenaiAssistant();
    const rows = [request, terminal];
    const capture = {
      getSessionEvents: () => rows,
      readBlob: () => openaiStream(openaiUsage),
    };
    return { rows, request, terminal, assistant, capture };
  }

  it("defers the candidate until raw terminal and persisted assistant proof agree", async () => {
    const { rows, capture, assistant } = fixture();
    expect(readCacheCaptureRows(capture, "private-session", openai)).toEqual(rows);
    expect(cacheRequestsComplete(rows, capture, openai)).toBe(true);
    const decoded = await decodeCacheExchanges(rows, capture, openai, [assistant]);
    expect(decoded[0]).toMatchObject({
      captureDisposition: "verified-terminal-with-response-body-read-failure",
      usage: { cacheRead: 300, cacheWrite: 100 },
    });
    expect(
      await waitForCacheExchanges(() => rows, capture, openai, 1, { messages: [assistant] }),
    ).toHaveLength(1);
    const evidence = await collectCacheFailureEvidence(
      capture,
      "private-session",
      openai,
      [assistant],
      "text-followup",
    );
    expect(evidence).toMatchObject({
      captureComplete: false,
      transportErrorCount: 1,
      verifiedTerminalReadFailureCount: 1,
      requests: [{ terminalComplete: true, accountingValid: true }],
      captureErrors: [
        { disposition: "verified-terminal-with-response-body-read-failure", cause: "unavailable" },
      ],
    });
    expect(JSON.stringify(evidence)).not.toContain("private");
  });

  it.each(GATEWAY_PROMPT_CACHE_SCENARIOS)(
    "accepts exactly the complete %s scenario with verified read-failure terminals",
    async (scenario) => {
      const count = scenario === "dependent-reads" ? 4 : 2;
      const fixtures = Array.from({ length: count }, (_, index) => {
        const value = fixture();
        value.request.id = index * 2;
        value.terminal.id = index * 2 + 1;
        value.request.flowId = value.terminal.flowId = `private-flow-${index}`;
        value.assistant.responseId = `resp_test-${index}`;
        value.terminal.dataBlobId = `terminal-blob-${index}`;
        value.terminal.dataText = sse("", {
          type: "response.completed",
          response: {
            id: value.assistant.responseId,
            model: openai.id,
            status: "completed",
            usage: openaiUsage,
          },
        });
        return value;
      });
      const evidence = await collectCacheFailureEvidence(
        {
          getSessionEvents: () => fixtures.flatMap(({ rows }) => rows),
          readBlob: (id) =>
            String(fixtures.find(({ terminal }) => terminal.dataBlobId === id)!.terminal.dataText),
        },
        "private-session",
        openai,
        fixtures.map(({ assistant }) => assistant),
        scenario,
      );
      expect(evidence.captureComplete).toBe(true);
      expect(evidence.requestCount).toBe(count);
      expect(evidence.verifiedTerminalReadFailureCount).toBe(count);
      expect(evidence.requests.every((row) => row.terminalComplete && row.accountingValid)).toBe(
        true,
      );
    },
  );

  it("does not accept capture arriving before assistant persistence or convert it to a budget wait", async () => {
    const { rows, capture } = fixture();
    expect(readCacheCaptureRows(capture, "session", openai)).toHaveLength(2);
    await expect(
      waitForCacheExchanges(() => rows, capture, openai, 1, { messages: [], timeoutMs: 1 }),
    ).rejects.toMatchObject({ phase: "accounting" });
  });

  it("waits for independently persisted assistant proof after capture arrives", async () => {
    const { rows, capture, assistant } = fixture();
    let reads = 0;
    const exchanges = await waitForCacheExchanges(() => rows, capture, openai, 1, {
      messages: () => (++reads === 1 ? [] : [assistant]),
    });
    expect(reads).toBe(2);
    expect(exchanges[0]?.captureDisposition).toBe(
      "verified-terminal-with-response-body-read-failure",
    );
  });

  it("bounds monitor deferral and preserves its first accounting cause", async () => {
    const { rows, capture, assistant } = fixture();
    const pending = new Map<string, number>();
    await checkCacheReadFailures(
      () => rows,
      capture,
      openai,
      () => [],
      pending,
    );
    expect(pending.size).toBe(1);
    pending.set(String(rows[0]!.flowId), Date.now() - 15_001);
    const state: { first?: CacheProofStopError } = {};
    await expect(
      runWithCacheProofStop(state, () =>
        checkCacheReadFailures(
          () => rows,
          capture,
          openai,
          () => [],
          pending,
        ),
      ),
    ).rejects.toMatchObject({ phase: "accounting" });
    expect(state.first?.phase).toBe("accounting");
    await checkCacheReadFailures(
      () => rows,
      capture,
      openai,
      () => [assistant],
      pending,
    );
    expect(pending.size).toBe(0);
  });

  it("refreshes capture after history advances during the monitor read", async () => {
    const { rows, request, capture, assistant } = fixture();
    let currentRows = rows;
    await expect(
      checkCacheReadFailures(
        () => currentRows,
        capture,
        openai,
        async () => {
          await Promise.resolve();
          currentRows = [...rows, { ...request, flowId: "next-request" }];
          return [assistant, { ...assistant, responseId: "next-response" }];
        },
        new Map(),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    "responseId",
    "model",
    "api",
    "provider",
    "stopReason",
    "errorMessage",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
  ] as const)(
    "rejects invalid persisted %s while retaining raw diagnostic usage",
    async (field) => {
      const { rows, capture, assistant } = fixture();
      if (["input", "output", "cacheRead", "cacheWrite", "totalTokens"].includes(field)) {
        Object.assign(assistant.usage as object, { [field]: 0 });
      } else {
        assistant[field] = field === "stopReason" ? "aborted" : "wrong";
      }
      await expect(decodeCacheExchanges(rows, capture, openai, [assistant])).rejects.toMatchObject({
        phase: "accounting",
      });
      const evidence = await collectCacheFailureEvidence(
        capture,
        "session",
        openai,
        [assistant],
        "text-followup",
      );
      expect(evidence).toMatchObject({
        captureComplete: false,
        verifiedTerminalReadFailureCount: 0,
        requests: [
          {
            terminalComplete: true,
            accountingValid: false,
            rawUsage: { input: 500, cacheRead: 300, cacheWrite: 100 },
          },
        ],
      });
    },
  );

  it("rejects an extra persisted assistant instead of matching only the first one", async () => {
    const { rows, capture, assistant } = fixture();
    await expect(
      decodeCacheExchanges(rows, capture, openai, [assistant, assistant]),
    ).rejects.toMatchObject({ phase: "accounting" });
    const evidence = await collectCacheFailureEvidence(
      capture,
      "session",
      openai,
      [assistant, assistant],
      "text-followup",
    );
    expect(evidence.captureComplete).toBe(false);
    expect(evidence.verifiedTerminalReadFailureCount).toBe(0);
  });

  it.each([
    "preterminal",
    "malformed",
    "truncated",
    "incomplete",
    "duplicate",
    "contradictory",
    "missing-usage",
    "missing-write",
    "missing-total",
    "invalid-total",
    "missing-output-details",
    "invalid-reasoning",
    "trailing-truncation",
    "contradictory-type",
  ] as const)("rejects %s raw terminal evidence", async (kind) => {
    const { rows, capture, assistant } = fixture();
    const good = openaiStream(openaiUsage);
    const bodies = {
      preterminal: sse("response.created", { response: { id: "resp_test" } }),
      malformed: "event: response.completed\ndata: {broken\n\n",
      truncated: good.slice(0, -12),
      incomplete: openaiStream(openaiUsage, "incomplete"),
      duplicate: good + good,
      contradictory: good + openaiStream(openaiUsage, "failed"),
      "missing-usage": openaiStream(undefined),
      "missing-write": openaiStream({
        ...openaiUsage,
        input_tokens_details: { cached_tokens: 300 },
      }),
      "missing-total": openaiStream({ ...openaiUsage, total_tokens: undefined }),
      "invalid-total": openaiStream({ ...openaiUsage, total_tokens: 508 }),
      "missing-output-details": openaiStream({ ...openaiUsage, output_tokens_details: undefined }),
      "invalid-reasoning": openaiStream({
        ...openaiUsage,
        output_tokens_details: { reasoning_tokens: 10 },
      }),
      "trailing-truncation": good + "event: response.failed\ndata: {",
      "contradictory-type": `event: response.completed\n${good.replace(
        '"type":"response.completed"',
        '"type":"response.failed"',
      )}`,
    };
    capture.readBlob = () => bodies[kind];
    await expect(decodeCacheExchanges(rows, capture, openai, [assistant])).rejects.toThrow();
    await expect(
      checkCacheReadFailures(
        () => rows,
        capture,
        openai,
        () => [],
        new Map(),
      ),
    ).rejects.toThrow();
  });

  it.each(["missing", "unreadable", "unreferenced"] as const)(
    "rejects a %s full blob even with a complete inline preview",
    async (kind) => {
      const { rows, capture, terminal, assistant } = fixture();
      const missingReader: DebugProxyCaptureReader = {
        ...capture,
        readBlob: () => {
          if (kind === "unreadable") {
            throw new Error("private storage failure");
          }
          return null;
        },
      };
      if (kind === "unreferenced") {
        delete terminal.dataBlobId;
      }
      await expect(decodeCacheExchanges(rows, missingReader, openai, [assistant])).rejects.toThrow(
        /blob/,
      );
      expect(() => readCacheCaptureRows(missingReader, "session", openai)).toThrow();
    },
  );

  it.each([
    "status",
    "endpoint",
    "model",
    "sse",
    "stage",
    "stalled",
    "finalized",
    "oversized",
  ] as const)("rejects an invalid %s capture candidate", async (kind) => {
    const { rows, request, terminal, capture, assistant } = fixture();
    if (kind === "status") {
      terminal.status = 500;
    } else if (kind === "endpoint") {
      terminal.path = "/v1/messages";
    } else if (kind === "model") {
      request.dataText = JSON.stringify({ model: "wrong", stream: true });
    } else if (kind === "sse") {
      terminal.contentType = "application/json";
    } else {
      terminal.metaJson = JSON.stringify({
        stage: kind === "stage" ? "before-headers" : "response-body",
        bodyCapture: kind === "stage" ? "failed" : kind === "oversized" ? "too-large" : kind,
      });
    }
    await expect(decodeCacheExchanges(rows, capture, openai, [assistant])).rejects.toThrow();
    expect(() => readCacheCaptureRows(capture, "session", openai)).toThrow();
  });

  it.each([
    "retry",
    "duplicate-request",
    "duplicate-terminal",
    "unmatched-error",
    "extra-error",
  ] as const)("rejects %s rather than waiting or ignoring the extra row", async (kind) => {
    const { rows, request, terminal, capture, assistant } = fixture();
    rows.push(
      kind === "retry"
        ? { ...terminal, kind: "retry-link" }
        : kind === "duplicate-request"
          ? { ...request }
          : kind === "duplicate-terminal"
            ? { ...terminal, kind: "response", metaJson: undefined }
            : kind === "unmatched-error"
              ? { ...terminal, flowId: "unmatched" }
              : { kind: "error", path: "/unknown", flowId: "other" },
    );
    await expect(
      waitForCacheExchanges(() => rows, capture, openai, 1, {
        messages: [assistant],
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/Provider|Duplicate|Unmatched|Unexpected/);
    const evidence = await collectCacheFailureEvidence(
      capture,
      "session",
      openai,
      [assistant],
      "text-followup",
    );
    expect(evidence.captureComplete).toBe(false);
    expect(evidence.verifiedTerminalReadFailureCount).toBe(0);
  });
});

describe("persisted cache body boundary", () => {
  const request = JSON.stringify({ model: sonnet.id, stream: true });
  const response = anthropicStream();
  async function withStoredExchange(
    options: { request?: string; response?: string; inline?: boolean; readFailure?: boolean },
    check: (capture: {
      rows: Array<Record<string, unknown>>;
      reader: DebugProxyCaptureReader;
      store: DebugProxyCaptureStore;
    }) => Promise<void>,
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-body-test-"));
    const env = { OPENCLAW_STATE_DIR: root };
    const store = new DebugProxyCaptureStore({ env });
    const model = options.readFailure ? openai : sonnet;
    try {
      for (const [index, kind] of (["request", "response"] as const).entries()) {
        const data =
          kind === "request"
            ? (options.request ?? JSON.stringify({ model: model.id, stream: true }))
            : (options.response ?? response);
        const contentType = kind === "request" ? "application/json" : "text/event-stream";
        store.recordEvent({
          sessionId: "body-boundary",
          ts: index,
          sourceScope: "openclaw",
          sourceProcess: "test",
          protocol: "http",
          direction: kind === "request" ? "outbound" : options.readFailure ? "local" : "inbound",
          kind: kind === "response" && options.readFailure ? "error" : kind,
          flowId: "body-flow",
          method: "POST",
          host: options.readFailure ? "api.openai.com" : "api.anthropic.com",
          path: options.readFailure ? "/v1/responses" : "/v1/messages",
          ...(kind === "response" ? { status: 200 } : {}),
          contentType,
          ...(kind === "response" && options.readFailure
            ? { metaJson: JSON.stringify({ bodyCapture: "failed", stage: "response-body" }) }
            : {}),
          ...(options.inline
            ? { dataText: data }
            : persistEventPayload(store, { data, contentType })),
        });
      }
      const storedReader = createDebugProxyCaptureReader({ env });
      await check({
        rows: readCacheCaptureRows(storedReader, "body-boundary", model),
        reader: storedReader,
        store,
      });
    } finally {
      store.close();
      closeOpenClawStateDatabaseByPath(store.dbPath);
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it("verifies an error-row terminal beyond the preview from its real persisted blob", async () => {
    const body =
      sse("response.output_text.delta", { delta: "x".repeat(9000) }) + openaiStream(openaiUsage);
    await withStoredExchange(
      { readFailure: true, response: body },
      async ({ rows, reader: storedReader }) => {
        expect(rows[1]?.kind).toBe("error");
        expect(Buffer.byteLength(String(rows[1]?.dataText))).toBe(8192);
        const messages = [persistedOpenaiAssistant()];
        const [decoded] = await decodeCacheExchanges(rows, storedReader, openai, messages);
        expect(decoded?.responseHash).toBe(createHash("sha256").update(body).digest("hex"));
        const evidence = await collectCacheFailureEvidence(
          storedReader,
          "body-boundary",
          openai,
          messages,
          "text-followup",
        );
        expect(evidence).toMatchObject({
          captureComplete: false,
          responseCount: 0,
          transportErrorCount: 1,
          verifiedTerminalReadFailureCount: 1,
        });
      },
    );
  });

  it.each(["request", "response"] as const)(
    "decodes the complete persisted %s beyond the 8 KiB preview",
    async (kind) => {
      const body =
        kind === "request"
          ? JSON.stringify({
              model: sonnet.id,
              stream: true,
              messages: [{ role: "user", content: "x".repeat(9000) }],
            })
          : sse("content_block_delta", { delta: { type: "text_delta", text: "x".repeat(9000) } }) +
            response;
      await withStoredExchange({ [kind]: body }, async ({ rows, reader: storedReader }) => {
        const row = rows.find((entry) => entry.kind === kind)!;
        expect(Buffer.byteLength(String(row.dataText))).toBe(8192);
        expect(typeof row.dataBlobId).toBe("string");
        const [decoded] = await decodeCacheExchanges(rows, storedReader, sonnet);
        expect(decoded?.[kind === "request" ? "requestHash" : "responseHash"]).toBe(
          createHash("sha256").update(body).digest("hex"),
        );
        expect(decoded?.usage).toEqual({
          input: 10,
          output: 6,
          cacheRead: 100,
          cacheWrite: 200,
          totalInput: 310,
        });
      });
    },
  );

  it("accepts complete inline bodies only when no blob is referenced", async () => {
    await withStoredExchange({ inline: true }, async ({ rows, reader: storedReader }) => {
      expect(rows.every((row) => row.dataBlobId === null)).toBe(true);
      expect(await decodeCacheExchanges(rows, storedReader, sonnet)).toHaveLength(1);
    });
  });

  it.each(["missing", "unreadable", "empty", "oversized"] as const)(
    "rejects a %s full blob despite a valid inline preview",
    async (kind) => {
      await withStoredExchange({}, async ({ rows, reader: storedReader, store }) => {
        let captureReader = storedReader;
        const requestRow = rows.find((row) => row.kind === "request")!;
        expect(requestRow.dataText).toBe(request);
        if (kind === "missing") {
          store.purgeAll();
        } else if (kind === "unreadable") {
          captureReader = {
            ...storedReader,
            readBlob() {
              throw new Error("private storage detail");
            },
          };
        } else {
          requestRow.dataBlobId = persistEventPayload(store, {
            data: kind === "empty" ? "" : "x".repeat(2 * 1024 * 1024 + 1),
          }).dataBlobId;
        }
        await expect(decodeCacheExchanges(rows, captureReader, sonnet)).rejects.toThrow(
          kind === "unreadable"
            ? "Provider capture blob could not be read."
            : "Provider capture body is missing or exceeds the proof bound.",
        );
      });
    },
  );
});

describe("cache history and lifecycle proof", () => {
  it.each(["provider", "transport"] as const)(
    "compares real %s converter and allocator string/text-block equivalents",
    async (profile) => {
      const model: Model<"anthropic-messages"> = {
        ...fable,
        name: "Cache fixture",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        input: ["text"],
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      };
      const history: Context["messages"] = [
        { role: "user", content: "exact seed\n  preserve spacing", timestamp: 0 },
        { role: "user", content: carrier("same facts").text, timestamp: 0 },
      ];
      const next: Context["messages"] = [
        ...history,
        { role: "user", content: "followup", timestamp: 1 },
        { role: "user", content: carrier("same facts").text, timestamp: 1 },
      ];
      const requests = await Promise.all(
        [history, next].map(async (messages) => {
          const payload = {
            messages: await convertAnthropicMessages(messages, model, false, { profile }),
          };
          applyAnthropicRequestCacheControl(payload, { type: "ephemeral" }, true);
          return payload;
        }),
      );
      expect(Array.isArray(requests[0]!.messages[1]!.content)).toBe(true);
      expect(typeof requests[1]!.messages[1]!.content).toBe("string");
      const exchanges = requests.map((request, index) =>
        Object.assign(exchange([], index ? 7950 : 0), { request }),
      );
      expect(() => verifyCacheConversation(exchanges, fable, "text-followup", 1)).not.toThrow();
    },
  );
  it("allows identical current runtime facts without mistaking them for historical retention", () => {
    const turns = conversation();
    const messages = turns[1]!.request.messages as ReturnType<typeof message>[];
    messages.at(-1)!.content = [carrier("turn one")];
    expect(() => verifyCacheConversation(turns, sonnet, "text-followup", 1)).not.toThrow();
  });
  it.each(["missing", "extra", "misplaced", "assistant"] as const)(
    "rejects a %s current carrier",
    (kind) => {
      const turns = conversation();
      const messages = turns[1]!.request.messages as ReturnType<typeof message>[];
      const current = messages.at(-1)!;
      if (kind === "missing") {
        messages.pop();
      } else if (kind === "extra") {
        current.content.push(carrier("extra"));
      } else if (kind === "assistant") {
        current.role = "assistant";
      } else {
        messages.push(message("user", [{ type: "text", text: "after carrier" }]));
      }
      expect(() => verifyCacheConversation(turns, sonnet, "text-followup", 1)).toThrow(/carrier/);
    },
  );
  it("rejects relocation of a retained original even if its text is unchanged", () => {
    const turns = conversation(true);
    const messages = turns[1]!.request.messages as ReturnType<typeof message>[];
    [messages[1], messages[2]] = [messages[2]!, messages[1]!];
    expect(() => verifyCacheConversation(turns, fable, "text-followup", 1)).toThrow(
      "Retained runtime carrier moved",
    );
  });
  it("enables the real runtime-facts producer in both fixture allowlists", () => {
    const options = gatewayPromptCacheOptions(sonnet, "fixture-root", "fixture-session");
    const cfg = options!.mutateConfig!({});
    const effective = cfg.tools!.allow!.filter((tool) =>
      cfg.agents!.entries!.qa!.tools!.allow!.includes(tool),
    );
    expect(effective).toEqual(["read", "process"]);
    expect(
      buildRuntimeFactsContext({
        cfg,
        agentId: "qa",
        sessionKey: "agent:qa:cache-fixture-isolated",
        capabilityToolNames: new Set(effective),
      }),
    ).toEqual([{ kind: "conversation-data", text: "Active exec sessions:\nnone" }]);
  });
  it("uses actual model contracts for transient and retained carriers", () => {
    expect(verifyCacheConversation(conversation(), sonnet, "text-followup", 1).lifecycle).toBe(
      "transient",
    );
    expect(verifyCacheConversation(conversation(true), fable, "text-followup", 1).lifecycle).toBe(
      "retained",
    );
    expect(() => verifyCacheConversation(conversation(true), sonnet, "text-followup", 1)).toThrow(
      "breakpoint",
    );
    expect(() => verifyCacheConversation(conversation(), fable, "text-followup", 1)).toThrow();
  });
  it("allows cache metadata movement but not historical content or system mutation", () => {
    const stable = conversation();
    const messages = stable[1]!.request.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    messages[0]!.content[0]!.cache_control = { type: "ephemeral" };
    expect(() => verifyCacheConversation(stable, sonnet, "text-followup", 1)).not.toThrow();
    messages[0]!.content[0]!.text = "rewritten history";
    expect(() => verifyCacheConversation(stable, sonnet, "text-followup", 1)).toThrow("historical");
    const changed = conversation();
    changed[1]!.request.system = [{ type: "text", text: "new system" }];
    expect(() => verifyCacheConversation(changed, sonnet, "text-followup", 1)).toThrow("System");
  });
  it("rejects system-only cache hits and retries instead of choosing the best request", () => {
    const noGrowth = conversation();
    noGrowth[1]!.usage.cacheRead = 512;
    expect(() => verifyCacheConversation(noGrowth, sonnet, "text-followup", 1)).toThrow("baseline");
    expect(() =>
      verifyCacheConversation([...conversation(), conversation()[1]!], sonnet, "text-followup", 1),
    ).toThrow("count");
  });
  it.each([false, true])(
    "requires both tool continuations and marginal reuse with retained=%s",
    (retained) => {
      const seed = message("user", [{ type: "text", text: "unique seed" }]);
      const a = message("assistant", [
        { type: "tool_use", id: "a", name: "read", input: { path: "a.txt" } },
      ]);
      const resultA = message("user", [
        { type: "tool_result", tool_use_id: "a", content: "large first tool result" },
      ]);
      const b = message("assistant", [
        { type: "tool_use", id: "b", name: "read", input: { path: "b.txt" } },
      ]);
      const resultB = message("user", [
        { type: "tool_result", tool_use_id: "b", content: "opaque answer" },
      ]);
      const history = [
        [seed],
        [seed, a, resultA],
        [seed, a, resultA, b, resultB],
        [
          seed,
          a,
          resultA,
          b,
          resultB,
          message("assistant", [{ type: "text", text: "opaque answer" }]),
          message("user", [{ type: "text", text: "repeat" }]),
        ],
      ];
      const valid = history.map((messages, index) =>
        Object.assign(
          exchange([
            ...(retained ? [message("user", [carrier("first turn", true)])] : []),
            ...structuredClone(messages),
            ...(!retained || index === 3
              ? [message("user", [carrier(index === 3 ? "new turn" : "first turn")])]
              : []),
          ]),
          {
            usage: {
              input: 50,
              output: 8,
              cacheRead: [0, 7950, 15950, 16000][index]!,
              cacheWrite: [7950, 8000, 100, 150][index]!,
              totalInput: [8000, 16000, 16100, 16200][index]!,
            },
          },
        ),
      );
      if (retained) {
        // Retained context starts at the first request's tail, then stays at that
        // exact historical position through both tool continuations.
        for (const turn of valid) {
          const messages = turn.request.messages as ReturnType<typeof message>[];
          [messages[0], messages[1]] = [messages[1]!, messages[0]!];
        }
      }
      const model = retained ? fable : sonnet;
      expect(() => verifyCacheConversation(valid, model, "dependent-reads", 3)).not.toThrow();
      const continuationsMiss = structuredClone(valid);
      continuationsMiss[1]!.usage.cacheRead = 0;
      continuationsMiss[2]!.usage.cacheRead = 0;
      continuationsMiss[3]!.usage.cacheRead = 7950;
      expect(() => verifyCacheConversation(continuationsMiss, model, "dependent-reads", 3)).toThrow(
        "Request 2",
      );
      const missingToolCache = structuredClone(valid);
      missingToolCache[2]!.usage.cacheRead = 7950;
      expect(() => verifyCacheConversation(missingToolCache, model, "dependent-reads", 3)).toThrow(
        "Request 3",
      );
    },
  );
  it("requires real read A result before read B and both successful results", () => {
    expect(() =>
      verifyDependentReadHistory(readHistory(), "a.txt", "b-random.txt", "opaque-answer"),
    ).not.toThrow();
    const parallel = readHistory();
    [parallel[1], parallel[2]] = [parallel[2]!, parallel[1]!];
    expect(() =>
      verifyDependentReadHistory(parallel, "a.txt", "b-random.txt", "opaque-answer"),
    ).toThrow("dependent");
    const failed = readHistory();
    Object.assign(failed[3]!, { isError: true });
    expect(() =>
      verifyDependentReadHistory(failed, "a.txt", "b-random.txt", "opaque-answer"),
    ).toThrow("successfully");
    expect(() =>
      verifyDependentReadHistory(
        readHistory().slice(0, 3),
        "a.txt",
        "b-random.txt",
        "opaque-answer",
      ),
    ).toThrow("order");
    const otherTool = readHistory();
    Object.assign(otherTool[0]!.content[0]!, { name: "process" });
    expect(() =>
      verifyDependentReadHistory(otherTool, "a.txt", "b-random.txt", "opaque-answer"),
    ).toThrow("read");
  });
});

describe("Responses retained carrier proof", () => {
  const model: Model<"openai-responses"> = {
    ...openai,
    name: "Cache fixture",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  function converted(scenario: PromptCacheScenario, convert = convertProviderResponsesMessages) {
    const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
    const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
      ...createOpenAIResponsesAssistantOutput(model),
      content,
    });
    const runtime = () =>
      convertToLlm([buildRuntimeContextCustomMessage("same runtime facts")!])[0]!;
    const initial = [user("seed"), runtime()];
    const history: Context["messages"] = [...initial];
    const requests = [convert(model, { messages: history }, new Set(["openai"]))];
    if (scenario === "dependent-reads") {
      for (const id of ["a", "b"]) {
        history.push(
          assistant([{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }]),
          {
            role: "toolResult",
            toolName: "read",
            toolCallId: id,
            content: [{ type: "text", text: id === "a" ? "next: b.txt" : "opaque answer" }],
            isError: false,
            timestamp: 0,
          },
        );
        requests.push(convert(model, { messages: history }, new Set(["openai"])));
      }
    }
    history.push(assistant([{ type: "text", text: "answer" }]), user("followup"), runtime());
    requests.push(convert(model, { messages: history }, new Set(["openai"])));
    const totals = scenario === "dependent-reads" ? [8000, 16000, 16100, 16200] : [8000, 8100];
    const reads = scenario === "dependent-reads" ? [0, 7950, 15950, 16000] : [0, 7950];
    const exchanges: CacheExchange[] = requests.map((input, index) => ({
      ...exchange([]),
      api: "openai-responses",
      model: openai.id,
      responseId: `resp_test-${index}`,
      request: { input },
      usage: {
        input: totals[index]!,
        totalInput: totals[index]!,
        output: 8,
        cacheRead: reads[index]!,
        cacheWrite: totals[index]! - reads[index]! - 50,
      },
    }));
    return { exchanges, requests };
  }

  it.each([
    ["provider", convertProviderResponsesMessages],
    ["transport", convertResponsesMessages],
  ] as const)(
    "checks both %s scenarios against the real retained wire conversion",
    (_, convert) => {
      for (const scenario of GATEWAY_PROMPT_CACHE_SCENARIOS) {
        const { exchanges } = converted(scenario, convert);
        expect(
          verifyCacheConversation(exchanges, openai, scenario, exchanges.length - 1).lifecycle,
        ).toBe("retained");
      }
    },
  );

  it.each(["missing", "extra", "wrong-role", "moved", "mutated", "missing-new-turn"])(
    "rejects a %s retained Responses carrier even with identical turn facts",
    (kind) => {
      const { exchanges, requests } = converted("dependent-reads");
      const input = requests.at(-1)!;
      const original = input[1]!;
      if (!("content" in original) || !Array.isArray(original.content)) {
        throw new Error("Converter did not emit the expected carrier message.");
      }
      if (kind === "missing") {
        input.splice(1, 1);
      } else if (kind === "extra") {
        input.push(structuredClone(original));
      } else if (kind === "wrong-role") {
        Object.assign(original, { role: "assistant" });
      } else if (kind === "moved") {
        [input[1], input[2]] = [input[2]!, input[1]!];
      } else if (kind === "mutated") {
        Object.assign(original.content[0]!, { text: carrier("changed runtime facts").text });
      } else {
        input.pop();
      }
      expect(() => verifyCacheConversation(exchanges, openai, "dependent-reads", 3)).toThrow(
        /carrier/,
      );
    },
  );

  it("does not discount retained carrier bytes from the required reusable prefix", () => {
    const { exchanges } = converted("text-followup");
    exchanges[1]!.usage.cacheRead = 8000 - 128 - 1;
    expect(() => verifyCacheConversation(exchanges, openai, "text-followup", 1)).toThrow(
      "Request 2",
    );
  });

  it.each(GATEWAY_PROMPT_CACHE_SCENARIOS)(
    "reports retained %s carrier positions and the undiscounted prefix floor",
    async (scenario) => {
      const { exchanges } = converted(scenario);
      const rows = exchanges.flatMap((value, index) => [
        {
          id: index * 2,
          kind: "request",
          flowId: `flow-${index}`,
          path: "/v1/responses",
          host: "api.openai.com",
          method: "POST",
          dataText: JSON.stringify({ model: openai.id, stream: true, ...value.request }),
        },
        {
          id: index * 2 + 1,
          kind: "response",
          flowId: `flow-${index}`,
          path: "/v1/responses",
          status: 200,
          contentType: "text/event-stream",
          dataText: openaiStream(
            {
              input_tokens: value.usage.totalInput,
              output_tokens: 8,
              total_tokens: value.usage.totalInput + 8,
              input_tokens_details: {
                cached_tokens: value.usage.cacheRead,
                cache_write_tokens: value.usage.cacheWrite,
              },
              output_tokens_details: { reasoning_tokens: 0 },
            },
            "completed",
            value.responseId,
          ),
        },
      ]);
      const evidence = await collectCacheFailureEvidence(
        { ...reader, getSessionEvents: () => rows },
        "session",
        openai,
        exchanges.map((value) => ({
          ...persistedOpenaiAssistant(),
          responseId: value.responseId,
          usage: {
            input: 50,
            output: 8,
            cacheRead: value.usage.cacheRead,
            cacheWrite: value.usage.cacheWrite,
            totalTokens: value.usage.totalInput + 8,
          },
        })),
        scenario,
      );
      expect(evidence).toMatchObject({ captureComplete: true, lifecycle: "retained" });
      expect(evidence.requests.map((value) => value.carriers.length)).toEqual(
        scenario === "dependent-reads" ? [1, 1, 1, 2] : [1, 2],
      );
      expect(evidence.requests.map((value) => value.carriers[0]!.messageIndex)).toEqual(
        exchanges.map(() => 1),
      );
      expect(evidence.reuse[0]!.minimumPrefix).toBe(8000 - 128);
    },
  );
});

describe("persisted cache usage reconciliation", () => {
  const raw: CacheExchange = {
    ...exchange([]),
    api: "openai-responses",
    model: openai.id,
    usage: { input: 500, output: 9, cacheRead: 300, cacheWrite: 100, totalInput: 500 },
  };
  function persisted(capturedExchange: CacheExchange) {
    const usage = capturedExchange.usage;
    return {
      role: "assistant",
      model: capturedExchange.model,
      api: capturedExchange.api,
      responseId: capturedExchange.responseId,
      usage: {
        input:
          capturedExchange.api === "openai-responses"
            ? usage.input - usage.cacheRead - (usage.cacheWrite ?? 0)
            : usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite ?? 0,
        totalTokens: usage.totalInput + usage.output,
      },
    };
  }
  it("reconciles independently parsed raw buckets for each response", () => {
    const second: CacheExchange = {
      ...raw,
      api: "anthropic-messages",
      model: sonnet.id,
      responseId: "second",
      usage: { input: 10, output: 6, cacheRead: 100, cacheWrite: 200, totalInput: 310 },
    };
    expect(reconcileCacheUsage([raw, second], [persisted(raw), persisted(second)])).toHaveLength(2);
    expect(() => reconcileCacheUsage([raw, second], [persisted(second), persisted(raw)])).toThrow(
      "identity",
    );
  });
  it.each(["cacheRead", "cacheWrite"])(
    "rejects zeroed persisted %s despite positive raw usage",
    (field) => {
      const assistant = persisted(raw);
      Object.assign(assistant.usage, { [field]: 0 });
      expect(() => reconcileCacheUsage([raw], [assistant])).toThrow(field);
    },
  );
  it("keeps absent raw writes distinct from the runtime's numeric zero default", () => {
    const absent = structuredClone(raw);
    absent.usage.cacheWrite = null;
    const result = reconcileCacheUsage([absent], [persisted(absent)]);
    expect(result[0]).toMatchObject({ cacheWrite: 0, rawCacheWriteObserved: false });
    expect(absent.usage.cacheWrite).toBeNull();
    expect(() => reconcileCacheUsage([raw], [])).toThrow("count");
  });
});

describe("runtime cache matrix contract", () => {
  it.each(["daily", "expanded"])("requires every unique completed %s scenario", (profile) => {
    const models = gatewayPromptCacheModels(profile);
    const assertions = models.flatMap((model) =>
      GATEWAY_PROMPT_CACHE_SCENARIOS.map((scenario) => ({
        title: gatewayPromptCacheCaseId(model, scenario),
        status: "passed",
      })),
    );
    expect(assertions).toHaveLength(profile === "daily" ? 6 : 10);
    expect(validateGatewayPromptCacheAssertions(assertions, profile)).toEqual({ ok: true });
    for (const invalid of [
      assertions.slice(1),
      [...assertions, assertions[0]!],
      ...["skipped", "failed", "pending", "unavailable"].map((status) =>
        [Object.assign({}, assertions[0], { status })].concat(assertions.slice(1)),
      ),
      [{ ...assertions[0], title: "wrong model/runtime" }, ...assertions.slice(1)],
    ]) {
      expect(validateGatewayPromptCacheAssertions(invalid, profile).ok).toBe(false);
    }
  });
  it("keeps expanded reasoning models runnable without a none override", () => {
    expect(gatewayPromptCacheModels("expanded").map((model) => model.id)).toContain("gpt-6-astra");
    expect(gatewayPromptCacheModels("expanded").map((model) => model.id)).toContain(
      "claude-opus-5",
    );
    expect(gatewayPromptCacheModels("expanded").every((model) => model.thinking === "low")).toBe(
      true,
    );
    expect(() => gatewayPromptCacheModels("first-available")).toThrow("profile");
  });
});

describe("cache failure evidence and cleanup", () => {
  function captured(exchanges: CacheExchange[]) {
    return exchanges.flatMap((capturedExchange, index) => [
      {
        id: index * 2,
        kind: "request",
        flowId: `private-flow-${index}`,
        path: "/v1/messages",
        host: "api.anthropic.com",
        method: "POST",
        dataText: JSON.stringify({ model: sonnet.id, stream: true, ...capturedExchange.request }),
      },
      {
        id: index * 2 + 1,
        kind: "response",
        flowId: `private-flow-${index}`,
        path: "/v1/messages",
        status: 200,
        contentType: "text/event-stream",
        dataText:
          sse("message_start", {
            message: {
              id: `private-response-${index}`,
              model: sonnet.id,
              usage: {
                input_tokens: capturedExchange.usage.input,
                output_tokens: 0,
                cache_read_input_tokens: capturedExchange.usage.cacheRead,
                cache_creation_input_tokens: capturedExchange.usage.cacheWrite,
              },
            },
          }) +
          sse("message_delta", {
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: capturedExchange.usage.output },
          }) +
          sse("message_stop", {}),
      },
    ]);
  }

  function persisted(exchanges: CacheExchange[]): Array<Record<string, unknown>> {
    return exchanges.map((value, index) => ({
      role: "assistant",
      responseId: `private-response-${index}`,
      model: sonnet.id,
      api: "anthropic-messages",
      usage: {
        input: value.usage.input,
        output: value.usage.output,
        cacheRead: value.usage.cacheRead,
        cacheWrite: value.usage.cacheWrite,
        totalTokens: value.usage.totalInput + value.usage.output,
        secret: "private-usage",
      },
    }));
  }

  it.each(GATEWAY_PROMPT_CACHE_SCENARIOS)(
    "requires exactly the complete %s scenario for final evidence",
    async (scenario) => {
      const exchanges =
        scenario === "dependent-reads" ? [...conversation(), ...conversation()] : conversation();
      const evidence = await collectCacheFailureEvidence(
        { ...reader, getSessionEvents: () => captured(exchanges) },
        "session",
        sonnet,
        persisted(exchanges),
        scenario,
      );
      expect(evidence.captureComplete).toBe(true);
      expect(evidence.requestCount).toBe(exchanges.length);
      expect(evidence.requests.every((row) => row.terminalComplete && row.accountingValid)).toBe(
        true,
      );
    },
  );

  it.each([false, true])(
    "rejects a late extra request after readiness succeeded (persisted: %s)",
    async (persistedExtra) => {
      const exchanges = conversation();
      let rows = captured(exchanges);
      const messages = persisted(exchanges);
      expect(await waitForCacheExchanges(() => rows, reader, sonnet, 2, { messages })).toHaveLength(
        2,
      );
      exchanges.push(conversation()[1]!);
      rows = captured(exchanges);
      const evidence = await collectCacheFailureEvidence(
        { ...reader, getSessionEvents: () => rows },
        "session",
        sonnet,
        persistedExtra ? persisted(exchanges) : messages,
        "text-followup",
      );
      expect(evidence).toMatchObject({
        captureComplete: false,
        requestCount: 3,
        responseCount: 3,
        requests: [
          { terminalComplete: true, accountingValid: true },
          { terminalComplete: true, accountingValid: true },
          {
            terminalComplete: true,
            accountingValid: persistedExtra,
            rawUsage: { cacheRead: 7950 },
          },
        ],
      });
    },
  );

  it.each([
    "missing-assistant",
    "extra-assistant",
    "responseId",
    "model",
    "api",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
  ])("rejects final %s evidence while retaining raw counters", async (field) => {
    const exchanges = conversation();
    const messages = persisted(exchanges);
    if (field === "missing-assistant") {
      messages.pop();
    } else if (field === "extra-assistant") {
      messages.push({ ...messages[1]! });
    } else if (["responseId", "model", "api"].includes(field)) {
      messages[1]![field] = "wrong";
    } else {
      Object.assign(messages[1]!.usage as object, { [field]: -1 });
    }
    const evidence = await collectCacheFailureEvidence(
      { ...reader, getSessionEvents: () => captured(exchanges) },
      "session",
      sonnet,
      messages,
      "text-followup",
    );
    expect(evidence).toMatchObject({
      captureComplete: false,
      requestCount: 2,
      responseCount: 2,
      requests: [
        { terminalComplete: true, accountingValid: true },
        {
          terminalComplete: true,
          accountingValid: field === "extra-assistant",
          rawUsage: { cacheRead: 7950 },
        },
      ],
    });
  });

  it("retains raw and normalized evidence for a real cache assertion failure without private text", async () => {
    const exchanges = conversation(true);
    expect(() => verifyCacheConversation(exchanges, sonnet, "text-followup", 1)).toThrow(
      "breakpoint",
    );
    const rows = captured(exchanges);
    const evidence = await collectCacheFailureEvidence(
      { ...reader, getSessionEvents: () => rows },
      "private-session",
      sonnet,
      persisted(exchanges),
      "text-followup",
    );
    expect(evidence).toMatchObject({
      captureComplete: true,
      requestCount: 2,
      lifecycle: "transient",
      requests: [
        {
          rawUsage: { cacheWrite: 7950 },
          normalizedUsage: { cacheWrite: 7950, input: 50 },
          carriers: [
            {
              contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
              markerHash: expect.any(String),
            },
          ],
        },
        {
          rawUsage: { cacheRead: 7950 },
        },
      ],
      reuse: [{ request: 2, actualPrefix: 7950, minimumColdGrowth: 1024 }],
    });
    expect(evidence.reuse[0]!.minimumPrefix).toBeGreaterThan(7000);
    const output = JSON.stringify(evidence);
    for (const privateValue of [
      "private-session",
      "private-flow",
      "private-response",
      "private-usage",
      "unique long user seed",
      "turn one",
    ]) {
      expect(output).not.toContain(privateValue);
    }
  });

  it("reports failed continuations and the first read growth instead of only the final cache hit", async () => {
    const exchanges = [
      conversation()[0]!,
      conversation()[0]!,
      conversation()[0]!,
      conversation()[1]!,
    ];
    const evidence = await collectCacheFailureEvidence(
      { ...reader, getSessionEvents: () => captured(exchanges) },
      "session",
      sonnet,
      persisted(exchanges),
      "dependent-reads",
    );
    expect(evidence.reuse.map((entry) => entry.actualPrefix)).toEqual([0, 0, 7950]);
    expect(evidence.firstReadReuse).toEqual({ minimum: 1024, actual: 0 });
  });

  it("reports the first differing semantic atom without publishing its contents", async () => {
    const exchanges = conversation();
    const messages = exchanges[1]!.request.messages as ReturnType<typeof message>[];
    messages[0]!.content = [{ type: "text", text: "private changed text" }];
    const evidence = await collectCacheFailureEvidence(
      { ...reader, getSessionEvents: () => captured(exchanges) },
      "session",
      sonnet,
      persisted(exchanges),
      "text-followup",
    );
    expect(evidence.history).toMatchObject({
      projectionValid: true,
      mismatch: {
        request: 2,
        atomOrdinal: 0,
        previousCount: 1,
        currentCount: 3,
        previous: { type: "text", bytes: expect.any(Number), hash: expect.any(String) },
        current: { type: "text", bytes: expect.any(Number), hash: expect.any(String) },
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("private changed text");
    expect(() => verifyCacheConversation(exchanges, sonnet, "text-followup", 1)).toThrow(
      '"atomOrdinal":0',
    );
  });

  it("distinguishes a post-header capture failure without inferring a provider failure cause", async () => {
    const rows = captured(conversation()).slice(0, 1);
    const failed = {
      kind: "error",
      direction: "local",
      flowId: "private-flow-0",
      path: "/v1/messages",
      errorText: "private clone read detail",
    };
    const capture = { ...reader, getSessionEvents: () => [...rows, failed] };
    const evidence = await collectCacheFailureEvidence(
      capture,
      "session",
      sonnet,
      [],
      "text-followup",
    );
    expect(evidence.captureErrors).toEqual([
      {
        request: 1,
        classification: "response-body-capture",
        stage: "after-response-headers",
        cause: "unavailable",
        disposition: "failed",
        errorTextBytes: Buffer.byteLength(failed.errorText),
        errorTextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    try {
      readCacheCaptureRows(capture, "session");
      expect.unreachable("capture errors must stop the scenario");
    } catch (error) {
      expect(error).toMatchObject({ observation: evidence.captureErrors[0] });
      expect(JSON.stringify(error)).not.toContain("private");
    }
    expect(JSON.stringify(evidence)).not.toContain("private");
  });

  it("reports incomplete and unreadable capture as unavailable, never complete zero-usage proof", async () => {
    const rows = captured(conversation()).slice(0, 3);
    const partial = await collectCacheFailureEvidence(
      { ...reader, getSessionEvents: () => rows },
      "session",
      sonnet,
      [],
      "text-followup",
    );
    expect(partial).toMatchObject({
      captureComplete: false,
      requestCount: 2,
      responseCount: 1,
      requests: [{ terminalComplete: true }, { terminalComplete: false, rawUsage: null }],
      reuse: [],
    });
    const failed = await collectCacheFailureEvidence(
      {
        ...reader,
        getSessionEvents: () => {
          throw new Error("private database path");
        },
      },
      "session",
      sonnet,
      [],
      "text-followup",
    );
    expect(failed).toMatchObject({ captureReadFailed: true, captureComplete: false });
    expect(JSON.stringify(failed)).not.toContain("private database path");
  });

  it("marks request and capture truncation explicitly", async () => {
    const rows = captured(Array.from({ length: 9 }, () => conversation()[0]!));
    const evidence = await collectCacheFailureEvidence(
      { ...reader, getSessionEvents: () => rows },
      "session",
      sonnet,
      [],
      "text-followup",
    );
    expect(evidence).toMatchObject({
      requestCount: 9,
      omittedRequestCount: 1,
      captureComplete: false,
    });
    const overflow = await collectCacheFailureEvidence(
      {
        ...reader,
        getSessionEvents: () => Array.from({ length: 512 }, () => ({ kind: "unknown" })),
      },
      "session",
      sonnet,
      [],
      "text-followup",
    );
    expect(overflow).toMatchObject({ captureLimitReached: true, captureComplete: false });
  });

  it.each(["never-spawned", "confirmed-stopped"] as const)(
    "removes an empty parent after %s",
    async (process) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
      await stopGatewayPromptCacheFixture({ stop: async () => ({ process, errors: [] }) }, root);
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["unconfirmed", "confirmed-stopped"] as const)(
    "retains the parent and original assertion when %s cleanup fails",
    async (process) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
      const original = new Error("cache invariant failed");
      const cleanup = new Error("stop failed");
      try {
        const failure = await runQaGatewayFixture(
          async () => {
            throw original;
          },
          () =>
            stopGatewayPromptCacheFixture(
              { stop: async () => ({ process, errors: [cleanup] }) },
              root,
            ),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors[0]).toBe(original);
        expect((failure as AggregateError).errors[1].errors).toContain(cleanup);
        expect((await fs.stat(root)).isDirectory()).toBe(true);
      } finally {
        await fs.rm(root, { recursive: true });
      }
    },
  );

  it("preserves owner-retained child artifacts even after a confirmed stop", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
    try {
      await fs.mkdir(path.join(root, "retained-child"));
      await stopGatewayPromptCacheFixture(
        { stop: async () => ({ process: "confirmed-stopped", errors: [] }) },
        root,
      );
      expect(await fs.readdir(root)).toEqual(["retained-child"]);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it.each([
    { process: "unconfirmed", diagnostic: false },
    { process: "unconfirmed", diagnostic: true },
    { process: "confirmed-stopped", diagnostic: true },
  ] as const)(
    "preserves early budget-stop failure after final cleanup succeeds: $process/$diagnostic",
    async ({ process, diagnostic }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
      const original = new Error("request budget reached");
      const cleanup = new Error("early stop failed");
      const budgetStop = Promise.resolve({
        process,
        errors: diagnostic ? [cleanup] : [],
      });
      let reported = false;
      try {
        const failure = await runQaGatewayFixture(
          async () => {
            throw original;
          },
          async () => assertGatewayPromptCacheStopped(await budgetStop),
          () => {
            reported = true;
          },
          () =>
            stopGatewayPromptCacheFixture(
              { stop: async () => ({ process: "confirmed-stopped", errors: [] }) },
              root,
            ),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors[0]).toBe(original);
        expect((failure as AggregateError).errors[1]).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors[1].errors).toEqual(diagnostic ? [cleanup] : []);
        expect(reported).toBe(true);
        await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("retains state when stop is unconfirmed even without diagnostic errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
    try {
      await expect(
        stopGatewayPromptCacheFixture(
          { stop: async () => ({ process: "unconfirmed", errors: [] }) },
          root,
        ),
      ).rejects.toThrow("retained");
      expect((await fs.stat(root)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("preserves the original assertion and state when stop itself rejects", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-cleanup-test-"));
    const original = new Error("cache assertion");
    const cleanup = new Error("stop rejected");
    try {
      const failure = await runQaGatewayFixture(
        async () => {
          throw original;
        },
        () =>
          stopGatewayPromptCacheFixture(
            {
              stop: async () => {
                throw cleanup;
              },
            },
            root,
          ),
      ).catch((error: unknown) => error);
      expect((failure as AggregateError).errors).toEqual([original, cleanup]);
      expect((await fs.stat(root)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });
});
