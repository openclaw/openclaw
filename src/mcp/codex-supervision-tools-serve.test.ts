// Codex supervision MCP tests cover the retired Supervisor command bridge.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  createCodexSupervisionToolsMcpServer,
  serveCodexSupervisionToolsMcp,
} from "./codex-supervision-tools-serve.js";

const acquireStandalonePluginToolRegistryMock = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/tools.js").acquireStandalonePluginToolRegistry>(),
);
const resolvePluginToolsMock = vi.hoisted(() => vi.fn<() => AnyAgentTool[]>(() => []));
const getRuntimeConfigMock = vi.hoisted(() =>
  vi.fn<() => import("../config/config.js").OpenClawConfig>(() => ({})),
);

vi.mock("../config/config.js", () => ({ getRuntimeConfig: getRuntimeConfigMock }));
vi.mock("../plugins/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/tools.js")>();
  return {
    ...actual,
    acquireStandalonePluginToolRegistry: acquireStandalonePluginToolRegistryMock,
  };
});
vi.mock("./tools-stdio-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools-stdio-server.js")>();
  const serve: typeof actual.serveRegisteredToolsMcpServer = async (params) => {
    const { LegacyPluginSdkResourceHost } = await import("../plugins/legacy-sdk-resource-host.js");
    const host = new LegacyPluginSdkResourceHost();
    const acquisition = await host.run(params.acquireRegistry);
    try {
      const server = params.createServer(acquisition.resolveTools(), host);
      await server.close();
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

function createTools(): AnyAgentTool[] {
  return TOOL_NAMES.map(
    (name) =>
      ({
        name,
        label: name,
        description: name,
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      }) as unknown as AnyAgentTool,
  );
}

describe("createCodexSupervisionToolsMcpServer", () => {
  beforeEach(() => {
    acquireStandalonePluginToolRegistryMock.mockReset().mockImplementation(async () => ({
      resolveTools: resolvePluginToolsMock,
      release: async () => {},
    }));
    getRuntimeConfigMock.mockReset().mockReturnValue({});
    resolvePluginToolsMock.mockReset();
    resolvePluginToolsMock.mockReturnValue([]);
  });

  it("fails closed when the external Codex plugin tools are unavailable", () => {
    expect(() =>
      createCodexSupervisionToolsMcpServer({
        tools: [],
      }),
    ).toThrow("Install or update @openclaw/codex");
  });

  it("lists official tools through the trusted standalone owner context", async () => {
    resolvePluginToolsMock.mockReturnValue(createTools());
    await serveCodexSupervisionToolsMcp();
    const server = createCodexSupervisionToolsMcpServer({ tools: createTools() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "codex-supervision-owner-test", version: "0.0.0" },
      { capabilities: {} },
    );

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      expect(acquireStandalonePluginToolRegistryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ senderIsOwner: true }),
        }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("preserves normalized Codex endpoint config while forcing bridge activation", async () => {
    resolvePluginToolsMock.mockReturnValue(createTools());

    getRuntimeConfigMock.mockReturnValue({
      plugins: {
        allow: [" CODEX "],
        deny: ["CoDeX"],
        entries: {
          " CODEX ": {
            config: {
              appServer: { transport: "websocket", url: "ws://127.0.0.1:4500" },
              supervision: { enabled: false },
            },
          },
        },
      },
    });
    await serveCodexSupervisionToolsMcp();

    const context = acquireStandalonePluginToolRegistryMock.mock.calls[0]?.[0]?.context;
    expect(context?.config?.plugins).toMatchObject({
      allow: ["codex"],
      deny: [],
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: { transport: "websocket", url: "ws://127.0.0.1:4500" },
            supervision: { enabled: true },
          },
        },
      },
    });
    expect(context?.config?.plugins?.entries).not.toHaveProperty(" CODEX ");
  });
});
