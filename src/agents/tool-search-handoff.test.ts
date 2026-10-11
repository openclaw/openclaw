import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { runAgentLoop } from "../../packages/agent-core/src/agent-loop.js";
import type { StreamFn } from "../../packages/agent-core/src/types.js";
import type { AssistantMessage, Message } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createToolLoopBatchAdmission } from "./embedded-agent-runner/run/tool-loop-recovery.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";
import {
  wrapToolDefinition,
  createToolDefinitionFromAgentTool,
} from "./sessions/tools/tool-definition-wrapper.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";
import { getToolInvocationMetadata } from "./tool-invocation-metadata.js";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
} from "./tool-search.js";
import { gatewayStub, validArgs } from "./tools/ask-user-tool.gateway.test-fixture.js";
import { createAskUserTool } from "./tools/ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./tools/ask-user-tool.test-support.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
afterEach(resetPendingAskUserQuestionsForTest);

function deferredFixture() {
  const abort = new AbortController();
  const gateway = gatewayStub(async (method, _options, params) => {
    if (method === "question.request") {
      return { id: params.id, durable: true };
    }
    throw new Error(`Unexpected waiter ${method}`);
  });
  const target = createAskUserTool({
    sessionKey: "agent:main:deferred-handoff",
    runId: "asking",
    agentId: "main",
    gatewayCall: gateway.call,
    questionPrompt: { send: async () => {} },
    nativeQuestionHandoff: () => {
      abort.abort({ code: "sessions_yield", turnHandoff: true });
    },
  });
  const execute = vi.spyOn(target, "execute");
  const ordinary = {
    name: "lookup",
    label: "lookup",
    description: "lookup",
    parameters: Type.Object({}),
    execute: vi.fn(async () => jsonResult({ status: "ok" })),
  };
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [target, ordinary] });
  const dispatcher = expectDefined(
    createToolSearchTools({ catalogRef, abortSignal: abort.signal }).find(
      (tool) => tool.name === "tool_call",
    ),
    "native dispatcher",
  );
  return { abort, execute, dispatcher, target, catalogRef };
}

it.each([false, true])(
  "serializes the exact deferred question before direct effects with loop detection %s",
  async (enabled) => {
    const f = deferredFixture();
    const hook = {
      agentId: "main",
      sessionKey: `handoff:${enabled}`,
      sessionId: "session",
      runId: `handoff:${enabled}`,
      loopDetection: { enabled },
    };
    const dispatcher = wrapToolWithAbortSignal(
      wrapToolWithBeforeToolCallHook(f.dispatcher, hook),
      f.abort.signal,
    );
    const exec = vi.fn(async () => jsonResult({ status: "executed" }));
    const tools: AnyAgentTool[] = [
      dispatcher,
      {
        name: "exec",
        label: "exec",
        description: "exec",
        parameters: Type.Object({}),
        execute: exec,
      },
    ];
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "question",
            name: "tool_call",
            arguments: { id: "ask_user", args: validArgs },
          },
          { type: "toolCall", id: "effect", name: "exec", arguments: {} },
        ],
        api: "faux",
        provider: "faux",
        model: "faux",
        usage: createZeroUsageFixture(),
        stopReason: "toolUse",
        timestamp: 1,
      };
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };
    const messages = await runAgentLoop(
      [{ role: "user", content: "ask first", timestamp: 0 }],
      {
        systemPrompt: "",
        messages: [],
        tools: toToolDefinitions(tools, hook, f.abort.signal).map((definition) =>
          wrapToolDefinition(definition),
        ),
      },
      {
        model: {
          id: "faux",
          name: "faux",
          api: "faux",
          provider: "faux",
          baseUrl: "https://example.test",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 1000,
        },
        convertToLlm: (entries) => entries as Message[],
        beforeToolBatch: createToolLoopBatchAdmission(hook),
      },
      () => {},
      f.abort.signal,
      streamFn,
    );
    expect(f.execute).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled();
    expect(
      messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "question",
      ),
    ).toMatchObject({ isError: false, details: { result: { details: { status: "waiting" } } } });
  },
);

it("uses exact registered target metadata without making all tool_call invocations sequential", () => {
  const f = deferredFixture();
  expect(getToolInvocationMetadata(f.dispatcher, { id: "ask_user", args: {} })).toMatchObject({
    executionMode: "sequential",
    ownsTurnHandoff: true,
  });
  expect(getToolInvocationMetadata(f.dispatcher, { id: "lookup", args: {} })).toEqual({
    executionMode: undefined,
    ownsTurnHandoff: false,
  });
  expect(getToolInvocationMetadata(f.dispatcher, { id: "missing", args: {} })).toEqual({
    ownsTurnHandoff: false,
  });
});

it("rejects a same-name unregistered handoff lookalike and a per-call forged handoff", async () => {
  const f = deferredFixture();
  const lookalike = wrapToolWithAbortSignal(
    {
      name: "ask_user",
      label: "ask",
      description: "ask",
      parameters: Type.Object({}),
      execute: async () => {
        f.abort.abort({ code: "sessions_yield", turnHandoff: true });
        return jsonResult({ status: "waiting" });
      },
    },
    f.abort.signal,
  );
  await expect(lookalike.execute("fake", {})).rejects.toMatchObject({ name: "AbortError" });
  const fresh = deferredFixture();
  const callAbort = new AbortController();
  const pending = new Promise<never>(() => {});
  fresh.target.execute = () => pending;
  const dispatcher = wrapToolWithAbortSignal(fresh.dispatcher, fresh.abort.signal);
  const result = dispatcher.execute("forged", { id: "ask_user", args: {} }, callAbort.signal);
  callAbort.abort({ code: "sessions_yield", turnHandoff: true });
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(fresh.abort.signal.aborted).toBe(false);
});

it.each(["execute", "prepared"] as const)(
  "preserves actual nested creator handoff through %s adapter",
  async (mode) => {
    const f = deferredFixture();
    const args = { id: "ask_user", args: validArgs };
    if (mode === "prepared") {
      attachInternalToolExecutionPreparer(f.dispatcher, async (params) => ({
        kind: "ready",
        args: params.args,
        execute: () => f.dispatcher.execute(params.toolCallId, params.args, params.signal),
        dispose() {},
      }));
    }
    const source = wrapToolWithAbortSignal(f.dispatcher, f.abort.signal);
    const definition = expectDefined(
      toToolDefinitions([source], undefined, f.abort.signal)[0],
      "native definition",
    );
    const wrapped = wrapToolDefinition(
      createToolDefinitionFromAgentTool(wrapToolDefinition(definition)),
    );
    const result =
      mode === "execute"
        ? await wrapped.execute(`nested:${mode}`, args)
        : await (async () => {
            const prepare = expectDefined(
              getInternalToolExecutionPreparer(wrapped),
              "native preparer",
            );
            const prepared = await prepare({
              toolCallId: `nested:${mode}`,
              args,
            });
            if (prepared.kind !== "ready") {
              throw new Error("Expected ready native invocation");
            }
            try {
              return await prepared.execute();
            } finally {
              prepared.dispose();
            }
          })();
    expect(result).toMatchObject({ details: { result: { details: { status: "waiting" } } } });
    expect(f.abort.signal.aborted).toBe(true);
    expect(f.execute).toHaveBeenCalledOnce();
  },
);
