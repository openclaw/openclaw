import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  type ToolsCatalogResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { listCoreToolFactoryDescriptors } from "../../agents/core-tool-factory-descriptors.js";
import { filterToolsByPolicy } from "../../agents/tool-policy-match.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";
import {
  ensureStandalonePluginToolRegistryLoaded,
  resolvePluginTools,
} from "../../plugins/tools.js";
import * as userProfileList from "../../state/user-profile-list.js";
import { toolsCatalogHandlers } from "./tools-catalog.js";

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  listAgentIds: vi.fn(() => ["main"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace-main"),
  resolveAgentDir: vi.fn(() => "/tmp/agents/main/agent"),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../../plugins/tools.js", () => ({
  ensureStandalonePluginToolRegistryLoaded: vi.fn(),
  resolvePluginTools: vi.fn(),
}));

const getActivePluginRegistryMock = vi.hoisted(() => vi.fn<() => unknown>(() => null));
vi.mock("../../plugins/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/runtime.js")>();
  return {
    ...actual,
    getActivePluginRegistry: () =>
      getActivePluginRegistryMock() as ReturnType<typeof actual.getActivePluginRegistry>,
  };
});

type RespondCall = [boolean, unknown?, { code: number; message: string }?];
type CatalogPayload = ToolsCatalogResult;

function createInvokeParams(params: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await expectDefined(
        toolsCatalogHandlers["tools.catalog"],
        'toolsCatalogHandlers["tools.catalog"] test invariant',
      )({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => config } as never,
        client: null,
        req: { type: "req", id: "req-1", method: "tools.catalog" },
        isWebchatConnect: () => false,
      }),
  };
}

function respondCall(respond: ReturnType<typeof vi.fn>): RespondCall {
  const call = respond.mock.calls[0] as RespondCall | undefined;
  if (!call) {
    throw new Error("expected respond call");
  }
  return call;
}

function expectInvalidRequest(respond: ReturnType<typeof vi.fn>, message: string) {
  const call = respondCall(respond);
  expect(call[0]).toBe(false);
  expect(call[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  expect(call[2]?.message).toContain(message);
}

function expectCatalogPayload(respond: ReturnType<typeof vi.fn>): CatalogPayload {
  const call = respondCall(respond);
  expect(call[0]).toBe(true);
  return call[1] as CatalogPayload;
}

describe("tools.catalog handler", () => {
  beforeEach(() => {
    const voiceCall = {
      name: "voice_call",
      label: "voice_call",
      description: "Plugin calling tool",
      parameters: Type.Object({
        destination: Type.String({ description: "Call destination." }),
        note: Type.Optional(Type.String({ description: "Optional call note.", default: "hidden" })),
      }),
      execute: async () => ({ content: [], details: {} }),
    };
    const matrixRoom = {
      name: "matrix_room",
      label: "matrix_room",
      displaySummary: "Summarized Matrix room helper.",
      description: "Matrix room helper\n\nACTIONS:\n- join\n- leave",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    };
    setPluginToolMeta(voiceCall, { pluginId: "voice-call", optional: true });
    setPluginToolMeta(matrixRoom, { pluginId: "matrix", optional: false });
    vi.mocked(resolvePluginTools).mockReturnValue([voiceCall, matrixRoom]);
    getActivePluginRegistryMock.mockReturnValue(null);
    vi.mocked(ensureStandalonePluginToolRegistryLoaded).mockReturnValue(undefined);
  });

  it.each([
    [{ extra: true }, "invalid tools.catalog params"],
    [{ agentId: "unknown-agent" }, "unknown agent id"],
  ] as const)("rejects %j", async (params, message) => {
    const { respond, invoke } = createInvokeParams(params);
    await invoke();
    expectInvalidRequest(respond, message);
  });

  it.each([false, true])("projects configurable core tools (capabilities=%s)", async (enabled) => {
    using identityCount = vi
      .spyOn(userProfileList, "hasMultipleSessionSharingIdentities")
      .mockReturnValue(enabled);
    const { respond, invoke } = createInvokeParams(
      { includePlugins: false },
      enabled ? {} : { tools: { swarm: false } },
    );
    await invoke();
    const payload = expectCatalogPayload(respond);
    expect(payload.agentId).toBe("main");
    const groups = payload.groups;
    const tools = groups.flatMap((group) => group.tools);
    const ids = tools.map((tool) => tool.id);
    expect(groups.some((group) => group.source === "plugin")).toBe(false);
    expect(
      groups
        .find((group) => group.id === "media")
        ?.tools.map((tool) => `${tool.source}:${tool.id}`),
    ).toContain("core:tts");
    expect(tools.filter((tool) => tool.id === "openclaw")).toEqual([
      {
        id: "openclaw",
        label: "openclaw",
        description: "Delegate OpenClaw setup and repair",
        source: "core",
        defaultProfiles: [],
      },
    ]);
    expect(ids.includes("agents_wait")).toBe(enabled);
    expect(ids.includes("personal_instructions")).toBe(enabled);
    if (enabled) {
      // Collector output is required by its per-run schema, not operator tool policy.
      const configurableTools = listCoreToolFactoryDescriptors().filter(
        (tool) => tool.name !== "structured_output",
      );
      expect(filterToolsByPolicy(configurableTools, { allow: ["*"], deny: ids })).toEqual([]);
    }
    expect(identityCount).toHaveBeenCalled();
  });

  it.each([false, true])(
    "projects plugin tools from their discovery registry (metadata=%s)",
    async (metadata) => {
      const toolRegistry = createEmptyPluginRegistry();
      if (metadata) {
        toolRegistry.toolMetadata.push({
          pluginId: "voice-call",
          source: "fixture",
          metadata: {
            toolName: "voice_call",
            displayName: "Voice Call",
            description: "Place a voice call",
            risk: "high",
            tags: ["calling"],
          },
        });
        const activeRegistry = createEmptyPluginRegistry();
        activeRegistry.toolMetadata.push({
          pluginId: "voice-call",
          source: "fixture",
          metadata: {
            toolName: "voice_call",
            displayName: "Wrong Workspace Voice Call",
            risk: "low",
          },
        });
        getActivePluginRegistryMock.mockReturnValue(activeRegistry);
        vi.mocked(ensureStandalonePluginToolRegistryLoaded).mockReturnValue(toolRegistry);
      }
      const { respond, invoke } = createInvokeParams({});
      await invoke();
      const groups = expectCatalogPayload(respond).groups.filter(
        (group) => group.source === "plugin",
      );
      expect(groups.length).toBeGreaterThan(0);
      const tools = groups.flatMap((group) => group.tools);
      expect(tools.find((tool) => tool.id === "voice_call")).toEqual({
        id: "voice_call",
        label: metadata ? "Voice Call" : "voice_call",
        description: metadata ? "Place a voice call" : "Plugin calling tool",
        fullDescription: metadata ? "Place a voice call" : "Plugin calling tool",
        parameters: [
          { name: "destination", required: true, type: "string", description: "Call destination." },
          { name: "note", required: false, type: "string", description: "Optional call note." },
        ],
        source: "plugin",
        pluginId: "voice-call",
        optional: true,
        risk: metadata ? "high" : undefined,
        tags: metadata ? ["calling"] : undefined,
        defaultProfiles: [],
      });
      expect(tools.find((tool) => tool.id === "matrix_room")?.description).toBe(
        "Summarized Matrix room helper.",
      );
      const context = {
        config: {},
        workspaceDir: "/tmp/workspace-main",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
      };
      expect(ensureStandalonePluginToolRegistryLoaded).toHaveBeenCalledWith({
        context,
        toolAllowlist: ["group:plugins"],
        allowGatewaySubagentBinding: true,
      });
      expect(resolvePluginTools).toHaveBeenCalledWith(
        expect.objectContaining({
          context,
          toolAllowlist: ["group:plugins"],
          allowGatewaySubagentBinding: true,
          suppressNameConflicts: true,
          runtimeRegistry: metadata ? toolRegistry : undefined,
          existingToolNames: expect.any(Set),
        }),
      );
      expect(vi.mocked(resolvePluginTools).mock.calls[0]?.[0].existingToolNames?.has("tts")).toBe(
        true,
      );
    },
  );

  it("sorts private mixed groups without changing source order or metadata aliases", async () => {
    const registry = createEmptyPluginRegistry();
    const tags = ["fixture"];
    const tools = ["resolved_z", "resolved_a"].map((name) => {
      const tool = {
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        execute: vi.fn(async () => ({ content: [], details: {} })),
      };
      setPluginToolMeta(tool, { pluginId: "z-resolved", optional: true });
      Object.freeze(tool);
      return tool;
    });
    registry.toolMetadata.push({
      pluginId: "z-resolved",
      source: "fixture",
      metadata: { toolName: "resolved_a", tags },
    });
    const factory = vi.fn(() => null);
    registry.tools.push(
      {
        pluginId: "b",
        pluginName: "Same",
        source: "fixture",
        names: ["b_z", "resolved_z", "tts", "b_a"],
        factory,
        optional: true,
      },
      {
        pluginId: "c",
        pluginName: "Same",
        source: "fixture",
        names: [],
        declaredNames: new Set(["b_a", "c_a"]),
        factory,
        optional: true,
      },
    );
    for (const entry of registry.tools) {
      Object.freeze(entry.names);
      Object.freeze(entry);
    }
    Object.freeze(tags);
    Object.freeze(tools);
    Object.freeze(registry.tools);
    vi.mocked(resolvePluginTools).mockReturnValue(tools);
    vi.mocked(ensureStandalonePluginToolRegistryLoaded).mockReturnValue(registry);
    const first = createInvokeParams({});
    await first.invoke();
    const groups = expectCatalogPayload(first.respond).groups.filter(
      (group) => group.source === "plugin",
    );
    expect(groups.map((group) => group.id)).toEqual(["plugin:b", "plugin:c", "plugin:z-resolved"]);
    expect(groups.map((group) => group.tools.map((tool) => tool.id))).toEqual([
      ["b_a", "b_z"],
      ["c_a"],
      ["resolved_a", "resolved_z"],
    ]);
    const resolved = expectDefined(groups[2], "resolved group");
    expect(expectDefined(resolved.tools[0], "resolved_a").tags).toBe(tags);
    const original = structuredClone(groups);
    resolved.tools.reverse();
    expectDefined(groups[0], "declared group").tools.pop();
    const second = createInvokeParams({});
    await second.invoke();
    const repeated = expectCatalogPayload(second.respond).groups.filter(
      (group) => group.source === "plugin",
    );
    expect(repeated).toEqual(original);
    expect(repeated[0]).not.toBe(groups[0]);
    expect(expectDefined(repeated[2], "repeated resolved group").tools[0]?.tags).toBe(tags);
    expect(tools.map((tool) => tool.name)).toEqual(["resolved_z", "resolved_a"]);
    expect(registry.tools.map((entry) => entry.names)).toEqual([
      ["b_z", "resolved_z", "tts", "b_a"],
      [],
    ]);
    expect(Array.from(registry.tools[1]?.declaredNames ?? [])).toEqual(["b_a", "c_a"]);
    expect(factory).not.toHaveBeenCalled();
    for (const tool of tools) {
      expect(tool.execute).not.toHaveBeenCalled();
    }
  });

  it.each(["load", "resolve"] as const)(
    "propagates %s failure without publishing a partial catalog",
    async (stage) => {
      const failure = new Error("synthetic producer failure");
      vi.mocked(
        stage === "load" ? ensureStandalonePluginToolRegistryLoaded : resolvePluginTools,
      ).mockImplementationOnce(() => {
        throw failure;
      });
      const { respond, invoke } = createInvokeParams({});
      await expect(invoke()).rejects.toBe(failure);
      expect(respond).not.toHaveBeenCalled();
    },
  );
});
