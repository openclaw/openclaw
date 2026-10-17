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
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";
import {
  ensureStandalonePluginToolRegistryLoaded as loadRegistry,
  resolvePluginTools as resolveTools,
} from "../../plugins/tools.js";
import * as profiles from "../../state/user-profile-list.js";
import { toolsCatalogHandlers } from "./tools-catalog.js";

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  listAgentIds: vi.fn(() => ["main"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/workspace"),
  resolveAgentDir: vi.fn(() => "/agent"),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../../plugins/tools.js", () => ({
  ensureStandalonePluginToolRegistryLoaded: vi.fn(),
  resolvePluginTools: vi.fn(),
}));

const getActivePluginRegistryMock = vi.hoisted(() =>
  vi.fn<() => PluginRegistry | null>(() => null),
);
vi.mock("../../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/runtime.js")>()),
  getActivePluginRegistry: getActivePluginRegistryMock,
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];
type ToolMetadata = PluginRegistry["toolMetadata"][number]["metadata"];

async function invokeCatalog(
  params: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
  respond = vi.fn(),
) {
  const handler = expectDefined(toolsCatalogHandlers["tools.catalog"], "tools.catalog handler");
  await handler({
    params,
    respond: respond as never,
    context: { getRuntimeConfig: () => config } as never,
    client: null,
    req: { type: "req", id: "req-1", method: "tools.catalog" },
    isWebchatConnect: () => false,
  });
  return expectDefined(respond.mock.calls[0] as RespondCall | undefined, "expected respond call");
}

async function catalog(params: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const [ok, payload] = await invokeCatalog(params, config);
  expect(ok).toBe(true);
  return payload as ToolsCatalogResult;
}

async function pluginGroups() {
  return (await catalog()).groups.filter((group) => group.source === "plugin");
}

function makeTool(name: string, description = name, parameters = Type.Object({})) {
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  return { name, label: name, description, parameters, execute };
}

function metadataRegistry(pluginId: string, metadata: ToolMetadata) {
  const registry = createEmptyPluginRegistry();
  registry.toolMetadata.push({ pluginId, source: "fixture", metadata });
  return registry;
}

describe("tools.catalog handler", () => {
  beforeEach(() => {
    vi.spyOn(profiles, "hasMultipleResidentSessionSharingIdentities").mockReturnValue(false);
    const voiceCall = makeTool(
      "voice_call",
      "Plugin calling tool",
      Type.Object({
        destination: Type.String({ description: "Call destination." }),
        note: Type.Optional(Type.String({ description: "Optional call note.", default: "hidden" })),
      }),
    );
    const matrixRoom = {
      ...makeTool("matrix_room", "Matrix room helper\n\nACTIONS:\n- join\n- leave"),
      displaySummary: "Room summary",
    };
    setPluginToolMeta(voiceCall, { pluginId: "voice-call", optional: true });
    setPluginToolMeta(matrixRoom, { pluginId: "matrix", optional: false });
    vi.mocked(resolveTools).mockReturnValue([voiceCall, matrixRoom]);
    getActivePluginRegistryMock.mockReturnValue(null);
    vi.mocked(loadRegistry).mockReturnValue(undefined);
  });

  it.each([
    [{ extra: true }, "invalid tools.catalog params"],
    [{ agentId: "unknown-agent" }, "unknown agent id"],
  ] as const)("rejects %j", async (params, message) => {
    const call = await invokeCatalog(params);
    expect(call[0]).toBe(false);
    expect(call[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call[2]?.message).toContain(message);
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("projects core tools (swarm=%s, multipleProfiles=%s)", async (swarm, multipleProfiles) => {
    vi.mocked(profiles.hasMultipleResidentSessionSharingIdentities).mockReturnValue(
      multipleProfiles,
    );
    const config = swarm ? {} : { tools: { swarm: false } };
    const { agentId, groups } = await catalog({ includePlugins: false }, config);
    expect(agentId).toBe("main");
    const tools = groups.flatMap((group) => group.tools);
    const ids = tools.map((tool) => tool.id);
    expect(groups.some((group) => group.source === "plugin")).toBe(false);
    const media = groups.find((group) => group.id === "media")?.tools;
    expect(media?.map((tool) => `${tool.source}:${tool.id}`)).toContain("core:tts");
    expect(tools.filter((tool) => tool.id === "openclaw")).toEqual([
      {
        id: "openclaw",
        label: "openclaw",
        description: "Delegate OpenClaw setup and repair",
        source: "core",
        defaultProfiles: [],
      },
    ]);
    expect(ids.includes("agents_wait")).toBe(swarm);
    expect(ids.includes("personal_instructions")).toBe(multipleProfiles);
    if (swarm && multipleProfiles) {
      // Collector output is required by its per-run schema, not operator tool policy.
      const configurableTools = listCoreToolFactoryDescriptors().filter(
        (tool) => tool.name !== "structured_output",
      );
      expect(filterToolsByPolicy(configurableTools, { allow: ["*"], deny: ids })).toEqual([]);
    }
  });

  it.each([false, true])("projects plugin discovery metadata=%s", async (metadata) => {
    const toolRegistry = metadataRegistry("voice-call", {
      toolName: "voice_call",
      displayName: "Voice Call",
      description: "Place a voice call",
      risk: "high",
      tags: ["calling"],
    });
    if (metadata) {
      getActivePluginRegistryMock.mockReturnValue(
        metadataRegistry("voice-call", {
          toolName: "voice_call",
          displayName: "Wrong Workspace Voice Call",
          risk: "low",
        }),
      );
      vi.mocked(loadRegistry).mockReturnValue(toolRegistry);
    }
    const groups = await pluginGroups();
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
    expect(tools.find((tool) => tool.id === "matrix_room")?.description).toBe("Room summary");
    const discovery = {
      context: { config: {}, workspaceDir: "/workspace", agentDir: "/agent", agentId: "main" },
      toolAllowlist: ["group:plugins"],
      allowGatewaySubagentBinding: true,
    };
    expect(loadRegistry).toHaveBeenCalledWith(discovery);
    expect(resolveTools).toHaveBeenCalledWith(
      expect.objectContaining({
        ...discovery,
        suppressNameConflicts: true,
        runtimeRegistry: metadata ? toolRegistry : undefined,
        existingToolNames: expect.any(Set),
      }),
    );
    expect(vi.mocked(resolveTools).mock.calls[0]?.[0].existingToolNames?.has("tts")).toBe(true);
  });

  it("sorts private mixed groups without changing source order or metadata aliases", async () => {
    const tags = ["fixture"];
    const registry = metadataRegistry("z-resolved", { toolName: "resolved_a", tags });
    const tools = ["resolved_z", "resolved_a"].map((name) => {
      const tool = makeTool(name);
      setPluginToolMeta(tool, { pluginId: "z-resolved", optional: true });
      return Object.freeze(tool);
    });
    const factory = vi.fn(() => null);
    registry.tools.push(
      ...[
        { pluginId: "b", names: ["b_z", "resolved_z", "tts", "b_a"] },
        { pluginId: "c", names: [], declaredNames: new Set(["b_a", "c_a"]) },
      ].map((entry) =>
        Object.assign(entry, { pluginName: "Same", source: "fixture", factory, optional: true }),
      ),
    );
    for (const entry of registry.tools) {
      Object.freeze(entry.names);
      Object.freeze(entry);
    }
    [tags, tools, registry.tools].forEach(Object.freeze);
    vi.mocked(resolveTools).mockReturnValue(tools);
    vi.mocked(loadRegistry).mockReturnValue(registry);
    const groups = await pluginGroups();
    expect(groups.map((group) => [group.id, group.tools.map((tool) => tool.id)])).toEqual([
      ["plugin:b", ["b_a", "b_z"]],
      ["plugin:c", ["c_a"]],
      ["plugin:z-resolved", ["resolved_a", "resolved_z"]],
    ]);
    const resolved = expectDefined(groups[2], "resolved group");
    expect(expectDefined(resolved.tools[0], "resolved_a").tags).toBe(tags);
    const original = structuredClone(groups);
    resolved.tools.reverse();
    expectDefined(groups[0], "declared group").tools.pop();
    const repeated = await pluginGroups();
    expect(repeated).toEqual(original);
    expect(repeated[0]).not.toBe(groups[0]);
    expect(expectDefined(repeated[2], "repeated resolved group").tools[0]?.tags).toBe(tags);
    expect(Array.from(registry.tools[1]?.declaredNames ?? [])).toEqual(["b_a", "c_a"]);
    expect(factory).not.toHaveBeenCalled();
    for (const tool of tools) {
      expect(tool.execute).not.toHaveBeenCalled();
    }
  });

  it.each(["load", "resolve"] as const)(
    "propagates %s failure without partial publication",
    async (stage) => {
      const failure = new Error("synthetic producer failure");
      vi.mocked(stage === "load" ? loadRegistry : resolveTools).mockImplementationOnce(() => {
        throw failure;
      });
      const respond = vi.fn();
      await expect(invokeCatalog({}, {}, respond)).rejects.toBe(failure);
      expect(respond).not.toHaveBeenCalled();
    },
  );
});
