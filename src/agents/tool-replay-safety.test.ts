import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getInternalNativeInvocation } from "../../packages/agent-core/src/internal-hooks.js";
import { finalizeExecutedToolCall } from "../../packages/agent-core/src/tool-call-outcome.js";
import { runWithAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import {
  bindAgentToolReplaySafety,
  captureAgentToolInvocation,
  collectReplaySafeToolNames,
  collectSideEffectToolOwners,
  isAgentToolReplaySafe as replaySafe,
} from "./tool-replay-safety.js";
import type { AnyAgentTool } from "./tools/common.js";

const declared = (value: boolean) => ({ declaredReplaySafe: () => value });

describe("agent tool replay safety", () => {
  it.each([
    ["search", undefined, true],
    ["progress_card", undefined, false],
    ["process", undefined, false],
    ["vendor_widget", undefined, false],
    ["search", false, false],
    ["x_search", true, true],
    ["vendor_widget", true, false],
    ["vendor_widget", false, false],
    ["memory_search", true, false],
  ] as const)("classifies %s with owner declaration %s", (name, declaration, replay) => {
    const options = declaration === undefined ? undefined : declared(declaration);
    expect(replaySafe({ name }, options)).toBe(replay);
  });

  it("binds read-only recovery safety to the concrete variant rather than its historical name", () => {
    const reader = bindAgentToolReplaySafety({ name: "automations" }, "bounded-read");
    const ordinaryTool = { name: "automations" };

    expect(replaySafe(reader)).toBe(true);
    expect(replaySafe(ordinaryTool)).toBe(false);
    expect(replaySafe({ ...reader })).toBe(false);
    expect(replaySafe(reader, declared(false))).toBe(false);
    expect(collectReplaySafeToolNames([reader, ordinaryTool])).toEqual(new Set());
  });

  it("rejects duplicate names from name-only replay metadata", () => {
    const coreTool = { name: "search" };
    const pluginTool = { name: "search" };

    expect(
      collectReplaySafeToolNames([coreTool, pluginTool], {
        declaredReplaySafe: (tool) => (tool === pluginTool ? true : undefined),
      }),
    ).toEqual(new Set());
  });

  it("retains canonical owners only for unique side-effecting tool names", () => {
    const memoryStore = { name: "memory_store" };
    const unrelatedStore = { name: "vendor_store" };
    const shadowedStore = { name: "memory_store" };
    const options = {
      declaredOwner: (tool: { name?: string }) =>
        tool === memoryStore ? '["memory-lancedb","memory_store"]' : undefined,
    };
    expect(
      collectSideEffectToolOwners([memoryStore, unrelatedStore, shadowedStore], options),
    ).toEqual(new Map());
    expect(collectSideEffectToolOwners([memoryStore, unrelatedStore], options)).toEqual(
      new Map([["memory_store", '["memory-lancedb","memory_store"]']]),
    );
  });
});

it("qualifies only the bounded native owner and refuses accepted asynchronous or unknown sources", () => {
  const tool = bindAgentToolReplaySafety(createStubTool("read"), "bounded-read");
  const call = { type: "toolCall" as const, id: "native-read", name: "read", arguments: {} };
  const assistantMessage = makeAgentAssistantMessage({ turnId: "native-turn", content: [call] });
  const invoke = (source: AnyAgentTool, result: object, successful = true) => {
    runWithAgentToolExecutionContext({ assistantMessage, toolCall: call }, () =>
      captureAgentToolInvocation(source, "native-run")(result, successful),
    );
    return getInternalNativeInvocation(result)?.fact;
  };
  const shared = { content: [], details: {} };
  expect(invoke(tool, shared)).toMatchObject({
    qualification: "read",
    toolCallId: "native-read",
    turnId: "native-turn",
  });
  expect(invoke(createStubTool("read"), shared)).toMatchObject({ qualification: "unqualified" });
  expect(invoke(tool, { details: { async: true, status: "started" } })).toMatchObject({
    qualification: "unqualified",
  });
  expect(invoke(tool, shared, false)).toMatchObject({ qualification: "unqualified" });
  expect(invoke(createStubTool("different-source"), shared)).toBeUndefined();
  for (const declaration of [true, false]) {
    const plugin = bindAgentToolReplaySafety(createStubTool("read"), "bounded-read");
    setPluginToolMeta(plugin, { pluginId: "synthetic", optional: false, replaySafe: declaration });
    expect(invoke(plugin, shared)).toMatchObject({ qualification: "unqualified" });
  }
});

it.each(["delayed-replacement", "throw", "error"] as const)(
  "preserves captured native custody through %s outcome hooks",
  async (mode) => {
    const toolCall = { type: "toolCall" as const, id: "source-call", name: "read", arguments: {} };
    const assistantMessage = makeAgentAssistantMessage({
      turnId: "source-turn",
      content: [toolCall],
    });
    const result = { content: [{ type: "text" as const, text: "Native result" }], details: {} };
    const tool = bindAgentToolReplaySafety(
      {
        name: "read",
        label: "Read",
        description: "Synthetic read",
        parameters: Type.Object({}),
        execute: async () => result,
      },
      "bounded-read",
    );
    runWithAgentToolExecutionContext({ assistantMessage, toolCall }, () =>
      captureAgentToolInvocation(tool, "source-run")(result, true),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = finalizeExecutedToolCall(
      {
        assistantMessage,
        currentContext: { systemPrompt: "", messages: [], tools: [tool] },
        signal: undefined,
        config: {
          afterToolCall: async () => {
            entered.resolve();
            await release.promise;
            if (mode === "throw") {
              throw new Error("Hook failed");
            }
            return { content: [{ type: "text", text: "Hook output" }], isError: mode === "error" };
          },
        },
      },
      { kind: "prepared", toolCall, tool, args: {} },
      { result: await tool.execute(), isError: false, executionStarted: true },
      {},
    );
    await entered.promise;
    // A reused raw object acquires another invocation while the earlier hook waits.
    const otherCall = { ...toolCall, id: "other-call" };
    const otherAssistant = makeAgentAssistantMessage({
      turnId: "other-turn",
      content: [otherCall],
    });
    runWithAgentToolExecutionContext(
      { assistantMessage: otherAssistant, toolCall: otherCall },
      () => captureAgentToolInvocation(createStubTool("read"), "other-run")(result, true),
    );
    expect(getInternalNativeInvocation(result)?.fact.qualification).toBe("unqualified");
    release.resolve();
    const finalized = await pending;
    expect(finalized.isError).toBe(mode !== "delayed-replacement");
    expect(getInternalNativeInvocation(finalized.result)?.fact).toEqual(
      mode === "delayed-replacement"
        ? expect.objectContaining({
            runId: "source-run",
            turnId: "source-turn",
            toolCallId: "source-call",
            qualification: "read",
          })
        : undefined,
    );
    expect(getInternalNativeInvocation(result)?.fact).toMatchObject({
      runId: "other-run",
      qualification: "unqualified",
    });
  },
);
