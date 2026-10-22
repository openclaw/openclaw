import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/config.js";
import type { acquireStandalonePluginToolRegistry } from "../plugins/tools.js";
import {
  createCodexSupervisionToolsMcpServer,
  serveCodexSupervisionToolsMcp,
} from "./codex-supervision-tools-serve.js";

const { acquireRegistry, resolveTools, getConfig } = vi.hoisted(() => ({
  acquireRegistry: vi.fn<typeof acquireStandalonePluginToolRegistry>(),
  resolveTools: vi.fn<() => AnyAgentTool[]>(() => []),
  getConfig: vi.fn<() => OpenClawConfig>(() => ({})),
}));

// mock-isolation: MCP supervision fixtures provide config without starting a real config owner.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getConfig,
  captureRuntimeConfigAsyncReader: () => async () => getConfig(),
}));
vi.mock("../plugins/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/tools.js")>()),
  acquireStandalonePluginToolRegistry: acquireRegistry,
}));
vi.mock("./tools-stdio-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools-stdio-server.js")>();
  const serve: typeof actual.serveRegisteredToolsMcpServer = async (params) => {
    const { LegacyPluginSdkResourceHost } = await import("../plugins/legacy-sdk-resource-host.js");
    const host = new LegacyPluginSdkResourceHost();
    const acquisition = await host.run(params.acquireRegistry);
    try {
      await params.createServer(acquisition.resolveTools(), host).close();
    } finally {
      await acquisition.release();
      await host.close();
    }
  };
  return { ...actual, serveRegisteredToolsMcpServer: serve };
});

const TOOL_NAMES = [
  "codex_endpoint_probe",
  "codex_sessions_list",
  "codex_session_read",
  "codex_session_send",
  "codex_session_interrupt",
] as const;

const createTools = (): AnyAgentTool[] =>
  TOOL_NAMES.map((name) => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: vi.fn<AnyAgentTool["execute"]>(),
  }));

describe("createCodexSupervisionToolsMcpServer", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    acquireRegistry.mockReset().mockImplementation(async () => ({
      resolveTools,
      release: async () => {},
    }));
    getConfig.mockReset().mockReturnValue({});
    resolveTools.mockReset().mockReturnValue(createTools());
  });

  it("fails closed when the external Codex plugin tools are unavailable", () => {
    const createMissing = () => createCodexSupervisionToolsMcpServer({ tools: [] });
    expect(createMissing).toThrow("Install or update @openclaw/codex");
  });

  it("lists official tools through the trusted standalone owner context", async () => {
    await serveCodexSupervisionToolsMcp();
    const server = createCodexSupervisionToolsMcpServer({ tools: createTools() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const identity = { name: "codex-supervision-owner-test", version: "0.0.0" };
    const client = new Client(identity, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      expect(acquireRegistry).toHaveBeenCalledWith(
        expect.objectContaining({ context: expect.objectContaining({ senderIsOwner: true }) }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("preserves endpoint config and translates legacy env policy at the standalone boundary", async () => {
    vi.stubEnv("OPENCLAW_CODEX_SUPERVISOR_ALLOW_RAW_TRANSCRIPTS", "1");
    vi.stubEnv("OPENCLAW_CODEX_SUPERVISOR_ALLOW_WRITE_CONTROLS", "1");

    const appServer = { transport: "websocket", url: "ws://127.0.0.1:4500" };
    const config = {
      plugins: {
        allow: [" CODEX "],
        deny: ["CoDeX"],
        entries: { " CODEX ": { config: { appServer, supervision: { enabled: false } } } },
      },
    };
    const original = structuredClone(config);
    getConfig.mockReturnValue(config);
    await serveCodexSupervisionToolsMcp();

    const plugins = acquireRegistry.mock.calls[0]?.[0]?.context.config?.plugins;
    expect(plugins).toMatchObject({ allow: ["codex"], deny: [] });
    expect(plugins?.entries?.codex).toMatchObject({
      enabled: true,
      config: {
        appServer: original.plugins.entries[" CODEX "].config.appServer,
        supervision: { enabled: true, allowRawTranscripts: true, allowWriteControls: true },
      },
    });
    expect(plugins?.entries).not.toHaveProperty(" CODEX ");
    expect(config).toEqual(original);
  });
});
