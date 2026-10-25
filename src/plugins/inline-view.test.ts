import assert from "node:assert/strict";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { projectMcpCallToolResult } from "../agents/mcp-content.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "../agents/tool-search.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { projectChatDisplayMessagesWithState } from "../gateway/chat-display-projection.core.js";
import { projectPluginInlineView } from "../gateway/chat-display-projection.inline-view.js";
import { sanitizeChatHistoryMessage } from "../gateway/chat-display-projection.sanitize.js";
import { listControlUiPluginDescriptors } from "../gateway/control-ui-plugin-tabs.js";
import { prepareAgentWirePayload } from "../gateway/server-chat-live-text.js";
import { createChatRunState } from "../gateway/server-chat-state.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";
import {
  bindPluginToolCallbacks,
  createPluginToolFactoryResolver,
} from "./tool-factory-runtime.js";

const view = {
  pluginId: "incidents",
  viewId: "incident",
  version: 1,
  summary: "Showing incident INC-42.",
  payload: { incidentId: "INC-42" },
};
const expectedInvocation = (toolCallId: string) => ({
  pluginId: "incidents",
  toolName: "show_incident",
  toolCallId,
});
function searchRuntime(tool: AnyAgentTool) {
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [tool] });
  return new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig());
}

function fixture(version = 1, frozenProxy = false) {
  const builder = createTestPluginRegistry(createPluginRuntimeMock());
  const record = createPluginRecord({
    id: "incidents",
    name: "Incident tools",
    origin: "bundled",
    contracts: { tools: ["show_incident"] },
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const registerVersion = (descriptorVersion: number) =>
    api.session.controls.registerControlUiDescriptor({
      id: "incident",
      surface: "inline",
      label: "Incident dashboard",
      version: descriptorVersion,
    });
  registerVersion(version);
  const source: AnyAgentTool = {
    name: "show_incident",
    label: "Show incident",
    description: "Show an incident",
    parameters: Type.Object({}),
    execute: async () =>
      api.inlineView(view.viewId, view.payload, { version: view.version, summary: view.summary }),
  };
  api.registerTool(frozenProxy ? new Proxy(Object.freeze(source), {}) : source);
  const entry = builder.registry.tools[0]!;
  // Resolve the admitted factory result, not the original plugin-owned object.
  const { resolved } = createPluginToolFactoryResolver((error) => assert.fail(error)).resolve(
    entry,
    {},
    [source.name],
  );
  assert(resolved && !Array.isArray(resolved));
  const tool = bindPluginToolCallbacks(entry, builder.registry, resolved);
  return { ...builder, api, tool, registerVersion };
}

describe("native inline tool results", () => {
  it("binds frozen Proxy tools through registered factories and rejects retired calls", async () => {
    const { registry, tool } = fixture(1, true);
    const direct = await tool.execute("direct-proxy", {});
    expect(asOptionalRecord(direct.details)?.pluginInlineViewInvocation).toEqual(
      expectedInvocation("direct-proxy"),
    );
    registry.plugins[0]!.enabled = false;
    await expect(tool.execute("retired-proxy", {})).rejects.toThrow("no longer active");
  });

  it("advertises inline mounts only to the current viewer scopes and Labs policy", () => {
    const { registry } = fixture();
    const registration = registry.controlUiDescriptors[0]!;
    registration.descriptor.requiredScopes = ["operator.write"];
    const previous = getRuntimeConfigSnapshot();
    try {
      withPluginRuntimeRegistryScope(registry, () => {
        expect(listControlUiPluginDescriptors(["operator.read"])).toEqual([]);
        expect(listControlUiPluginDescriptors(["operator.write"])).toHaveLength(1);
        registry.plugins[0]!.origin = "workspace";
        setRuntimeConfigSnapshot({
          gateway: { controlUi: { experimental: { customPlugins: false } } },
        });
        expect(listControlUiPluginDescriptors(["operator.admin"])).toEqual([]);
        setRuntimeConfigSnapshot({
          gateway: { controlUi: { experimental: { customPlugins: true } } },
        });
        expect(listControlUiPluginDescriptors(["operator.admin"])).toHaveLength(1);
      });
    } finally {
      if (previous) {
        setRuntimeConfigSnapshot(previous);
      } else {
        clearRuntimeConfigSnapshot();
      }
    }
  });
  it("binds canonical plugin identity and enforces JSON/UTF-8/summary bounds without rewriting data", () => {
    const { api } = fixture();
    const inline = (payload: Parameters<typeof api.inlineView>[1], summary = "Showing incident.") =>
      api.inlineView("incident", payload, { version: 1, summary });
    const payload = { incidentId: "INC-42", text: "<script>text is plugin data</script>" };
    const result = inline(payload);
    expect(result.details.pluginInlineView).toEqual({
      ...view,
      summary: "Showing incident.",
      payload,
    });
    expect(result.details.pluginInlineView.payload).toBe(payload);
    expect(inline("a".repeat(16_382))).toBeDefined();
    for (const value of [
      "a".repeat(16_383),
      "😀".repeat(4096),
      Number.NaN,
      { invalid: undefined },
      {
        toJSON() {
          return "hidden";
        },
      },
    ]) {
      expect(() => inline(value as never)).toThrow("plain JSON");
    }
    expect(() => inline({}, " ")).toThrow("summary");
    expect(() => inline({}, "a".repeat(4097))).toThrow("4 KiB");
    expect(() => inline({}, "x" + "\n".repeat(2048))).toThrow("4 KiB");
  });

  it.each([0, -1, 65536, 1.5, Number.NaN, undefined])(
    "rejects missing or invalid version %j",
    (version) => {
      const { api, registry } = fixture(version === undefined ? 0 : version);
      expect(registry.controlUiDescriptors).toEqual([]);
      expect(() =>
        api.inlineView("incident", {}, { version: version!, summary: "Fallback." }),
      ).toThrow("version");
    },
  );

  it("registers explicit older versions alongside newer interfaces", () => {
    const { registerVersion, registry } = fixture();
    registerVersion(2);
    registerVersion(1);
    expect(registry.controlUiDescriptors.map((entry) => entry.descriptor.version)).toEqual([1, 2]);
  });

  it("projects direct live and persisted results identically without changing the stored envelope", async () => {
    const { registry, tool } = fixture();
    const result = await tool.execute("direct-1", {});
    const raw = JSON.stringify(result);
    const message = {
      role: "toolResult",
      toolName: tool.name,
      toolCallId: "direct-1",
      ...result,
      timestamp: 100,
    };
    withPluginRuntimeRegistryScope(registry, () => {
      const history = asOptionalRecord(sanitizeChatHistoryMessage(message).message);
      const live = prepareAgentWirePayload(
        {
          runId: "run",
          seq: 1,
          ts: 100,
          stream: "tool",
          data: { phase: "result", name: tool.name, toolCallId: "direct-1", result },
        },
        "run",
        createChatRunState(),
        () => true,
      );
      const expected = {
        ...view,
        type: "plugin_view",
        toolCallId: "direct-1",
        toolName: "show_incident",
      };
      expect(asOptionalRecord(history?.details)?.pluginView).toEqual(expected);
      expect(asOptionalRecord(asOptionalRecord(live.data.result)?.details)?.pluginView).toEqual(
        expected,
      );
    });
    expect(JSON.stringify(result)).toBe(raw);
  });

  it("keeps a real Tool Search child identity and summary through snapshot and nested history projection", async () => {
    const { registry, tool } = fixture();
    const { result } = await searchRuntime(tool).call(
      tool.name,
      {},
      { parentToolCallId: "outer-exec" },
    );
    const owner = asOptionalRecord(asOptionalRecord(result.details)?.pluginInlineViewInvocation)!;
    expect(owner.toolCallId).toBe("tool_call:outer-exec:show_incident:1");
    const activity = createNestedToolActivity({
      runId: "run",
      scopeId: "scope",
      afterEntryId: null,
      startOrder: 1,
      parentToolCallId: "outer-exec",
      toolCallId: String(owner.toolCallId),
      toolName: tool.name,
      input: {},
      result,
      isError: false,
      startedAt: 100,
      timestamp: 110,
    });
    withPluginRuntimeRegistryScope(registry, () => {
      const projected = projectChatDisplayMessagesWithState([activity]).messages;
      expect(JSON.stringify(projected)).toContain('"type":"plugin_view"');
      expect(JSON.stringify(projected)).toContain('"summary":"Showing incident INC-42."');
      expect(
        projectPluginInlineView(result.details, { toolCallId: "outer-exec", toolName: "exec" }),
      ).toBeUndefined();
    });
  });

  it("preserves the entire record without a renderer and never admits unbound MCP data", async () => {
    const original = fixture();
    const result = await original.tool.execute("one", {});
    const invocation = { toolCallId: "one", toolName: "show_incident" };
    const wire = JSON.stringify(result);
    const saved = JSON.parse(wire);
    const empty = createTestPluginRegistry().registry;
    withPluginRuntimeRegistryScope(empty, () => {
      expect(projectPluginInlineView(saved.details, invocation)).toEqual({
        ...view,
        type: "plugin_view",
        ...invocation,
      });
    });
    expect(
      projectPluginInlineView(
        original.api.inlineView("incident", {}, { version: 1, summary: "Unbound." }).details,
        invocation,
      ),
    ).toBeUndefined();
    const mcp = projectMcpCallToolResult({
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result.details,
    });
    expect(projectPluginInlineView(mcp.details, invocation)).toBeUndefined();
  });
});
