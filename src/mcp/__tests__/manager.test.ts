/**
 * MCP Manager Tests — Phase 6
 *
 * Integration tests for the McpManager orchestrator.
 * TDD: tests written first, implementation follows.
 */

import { describe, it, expect } from "vitest";
import type { McpClientBase } from "../client-base.js";
import type { McpClientStatus, McpToolInfo } from "../client-base.js";
import type { McpConfig, McpServerConfig } from "../config.js";
import { McpManager } from "../manager.js";

// ─── Mock Client ───

class MockMcpClient {
  readonly name: string;
  readonly config: McpServerConfig;
  private _status: McpClientStatus = "disconnected";
  private _tools: McpToolInfo[];
  private _resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  private _resourceContents: Record<string, string>;
  connectError?: Error;
  disconnectError?: Error;
  connectDelay?: number;

  constructor(
    name: string,
    config: McpServerConfig,
    opts: {
      tools?: McpToolInfo[];
      resources?: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
      resourceContents?: Record<string, string>;
      connectError?: Error;
      disconnectError?: Error;
      connectDelay?: number;
    } = {},
  ) {
    this.name = name;
    this.config = config;
    this._tools = opts.tools ?? [];
    this._resources = opts.resources ?? [];
    this._resourceContents = opts.resourceContents ?? {};
    this.connectError = opts.connectError;
    this.disconnectError = opts.disconnectError;
    this.connectDelay = opts.connectDelay;
  }

  async connect(): Promise<void> {
    this._status = "connecting";
    if (this.connectDelay) {
      await new Promise((r) => setTimeout(r, this.connectDelay));
    }
    if (this.connectError) {
      this._status = "error";
      throw this.connectError;
    }
    this._status = "ready";
  }

  async disconnect(): Promise<void> {
    if (this.disconnectError) {
      throw this.disconnectError;
    }
    this._status = "closed";
  }

  getStatus(): McpClientStatus {
    return this._status;
  }

  getDiscoveredTools(): McpToolInfo[] {
    return this._tools;
  }

  async callTool(name: string, _args: Record<string, unknown>) {
    return { content: [{ type: "text", text: `result from ${name}` }] };
  }

  async listResources() {
    return { resources: this._resources };
  }

  async readResource(params: { uri: string }) {
    const text = this._resourceContents[params.uri] ?? "content";
    return { contents: [{ text }] };
  }

  getRestartCount(): number {
    return 0;
  }
}

// ─── Factory for injecting mock clients ───

function createMockFactory(clients: Map<string, MockMcpClient>) {
  return (name: string, _config: McpServerConfig): McpClientBase => {
    const client = clients.get(name);
    if (!client) {
      throw new Error(`No mock client for ${name}`);
    }
    return client as unknown as McpClientBase;
  };
}

// ─── Tests ───

describe("McpManager", () => {
  it("starts multiple servers in parallel", async () => {
    const clients = new Map<string, MockMcpClient>();
    clients.set(
      "server-a",
      new MockMcpClient(
        "server-a",
        { command: "a" },
        {
          tools: [
            {
              name: "tool1",
              description: "Tool 1",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      ),
    );
    clients.set(
      "server-b",
      new MockMcpClient(
        "server-b",
        { command: "b" },
        {
          tools: [
            {
              name: "tool2",
              description: "Tool 2",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      ),
    );

    const config: McpConfig = {
      servers: {
        "server-a": { command: "a" },
        "server-b": { command: "b" },
      },
    };

    const manager = new McpManager(config, { clientFactory: createMockFactory(clients) });
    await manager.start();

    const tools = manager.getTools();
    expect(tools.length).toBe(2);
    expect(tools.map((t) => t.name)).toContain("mcp_server-a_tool1");
    expect(tools.map((t) => t.name)).toContain("mcp_server-b_tool2");

    await manager.shutdown();
  });

  it("one server fails → others still start", async () => {
    const clients = new Map<string, MockMcpClient>();
    clients.set(
      "good",
      new MockMcpClient(
        "good",
        { command: "good" },
        {
          tools: [{ name: "t1", inputSchema: { type: "object", properties: {} } }],
        },
      ),
    );
    clients.set(
      "bad",
      new MockMcpClient(
        "bad",
        { command: "bad" },
        {
          connectError: new Error("connection failed"),
        },
      ),
    );

    const config: McpConfig = {
      servers: {
        good: { command: "good" },
        bad: { command: "bad" },
      },
    };

    const manager = new McpManager(config, { clientFactory: createMockFactory(clients) });
    await manager.start();

    const tools = manager.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("mcp_good_t1");

    await manager.shutdown();
  });

  it("disabled server → skipped", async () => {
    const clients = new Map<string, MockMcpClient>();
    clients.set(
      "active",
      new MockMcpClient(
        "active",
        { command: "a" },
        {
          tools: [{ name: "t1", inputSchema: { type: "object", properties: {} } }],
        },
      ),
    );

    const config: McpConfig = {
      servers: {
        active: { command: "a" },
        inactive: { command: "b", enabled: false },
      },
    };

    const manager = new McpManager(config, { clientFactory: createMockFactory(clients) });
    await manager.start();

    const tools = manager.getTools();
    expect(tools.length).toBe(1);

    await manager.shutdown();
  });

  it("getTools() excludes tools from failed servers", async () => {
    const clients = new Map<string, MockMcpClient>();
    clients.set(
      "ok",
      new MockMcpClient(
        "ok",
        { command: "ok" },
        {
          tools: [{ name: "t1", inputSchema: { type: "object", properties: {} } }],
        },
      ),
    );
    clients.set(
      "fail",
      new MockMcpClient(
        "fail",
        { command: "fail" },
        {
          connectError: new Error("nope"),
          tools: [{ name: "t2", inputSchema: { type: "object", properties: {} } }],
        },
      ),
    );

    const config: McpConfig = {
      servers: {
        ok: { command: "ok" },
        fail: { command: "fail" },
      },
    };

    const manager = new McpManager(config, { clientFactory: createMockFactory(clients) });
    await manager.start();

    const tools = manager.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("mcp_ok_t1");

    await manager.shutdown();
  });

  it("getResourceContext() aggregates resources from all servers", async () => {
    const clients = new Map<string, MockMcpClient>();
    clients.set(
      "s1",
      new MockMcpClient(
        "s1",
        { command: "s1" },
        {
          tools: [],
          resources: [{ uri: "file:///a.txt", name: "a.txt" }],
          resourceContents: { "file:///a.txt": "content A" },
        },
      ),
    );
    clients.set(
      "s2",
      new MockMcpClient(
        "s2",
        { command: "s2" },
        {
          tools: [],
          resources: [{ uri: "file:///b.txt", name: "b.txt" }],
          resourceContents: { "file:///b.txt": "content B" },
        },
      ),
    );

    const config: McpConfig = {
      servers: {
        s1: { command: "s1" },
        s2: { command: "s2" },
      },
    };

    const manager = new McpManager(config, { clientFactory: createMockFactory(clients) });
    await manager.start();

    const context = await manager.getResourceContext();
    expect(context).toContain("s1");
    expect(context).toContain("s2");
    expect(context).toContain("a.txt");
    expect(context).toContain("b.txt");

    await manager.shutdown();
  });

  it("getResourceContext() skips servers with resources: false", async () => {
    const clients = new Map<string, MockMcpClient>();
    clients.set(
      "with-res",
      new MockMcpClient(
        "with-res",
        { command: "a" },
        {
          tools: [],
          resources: [{ uri: "file:///a.txt", name: "a.txt" }],
          resourceContents: { "file:///a.txt": "hello" },
        },
      ),
    );
    clients.set(
      "no-res",
      new MockMcpClient(
        "no-res",
        { command: "b", resources: false },
        {
          tools: [],
          resources: [{ uri: "file:///b.txt", name: "b.txt" }],
          resourceContents: { "file:///b.txt": "world" },
        },
      ),
    );

    const config: McpConfig = {
      servers: {
        "with-res": { command: "a" },
        "no-res": { command: "b", resources: false },
      },
    };

    const manager = new McpManager(config, { clientFactory: createMockFactory(clients) });
    await manager.start();

    const context = await manager.getResourceContext();
    expect(context).toContain("a.txt");
    expect(context).not.toContain("b.txt");

    await manager.shutdown();
  });

  it("shutdown() stops all servers", async () => {
    const clients = new Map<string, MockMcpClient>();
    const c1 = new MockMcpClient("s1", { command: "a" }, { tools: [] });
    const c2 = new MockMcpClient("s2", { command: "b" }, { tools: [] });
    clients.set("s1", c1);
    clients.set("s2", c2);

    const config: McpConfig = {
      servers: { s1: { command: "a" }, s2: { command: "b" } },
    };

    const manager = new McpManager(config, { clientFactory: createMockFactory(clients) });
    await manager.start();
    await manager.shutdown();

    expect(c1.getStatus()).toBe("closed");
    expect(c2.getStatus()).toBe("closed");
  });

  it("shutdown() handles errors from individual servers", async () => {
    const clients = new Map<string, MockMcpClient>();
    const c1 = new MockMcpClient("s1", { command: "a" }, { tools: [] });
    c1.disconnectError = new Error("disconnect failed");
    const c2 = new MockMcpClient("s2", { command: "b" }, { tools: [] });
    clients.set("s1", c1);
    clients.set("s2", c2);

    const config: McpConfig = {
      servers: { s1: { command: "a" }, s2: { command: "b" } },
    };

    const manager = new McpManager(config, { clientFactory: createMockFactory(clients) });
    await manager.start();

    // Should not throw even though s1 disconnect fails
    await expect(manager.shutdown()).resolves.not.toThrow();
    expect(c2.getStatus()).toBe("closed");
  });

  it("getStatus() returns per-server status + tool count", async () => {
    const clients = new Map<string, MockMcpClient>();
    clients.set(
      "s1",
      new MockMcpClient(
        "s1",
        { command: "a" },
        {
          tools: [
            { name: "t1", inputSchema: { type: "object", properties: {} } },
            { name: "t2", inputSchema: { type: "object", properties: {} } },
          ],
        },
      ),
    );
    clients.set(
      "s2",
      new MockMcpClient(
        "s2",
        { command: "b" },
        {
          connectError: new Error("fail"),
        },
      ),
    );

    const config: McpConfig = {
      servers: { s1: { command: "a" }, s2: { command: "b" } },
    };

    const manager = new McpManager(config, { clientFactory: createMockFactory(clients) });
    await manager.start();

    const status = manager.getStatus();
    expect(status).toHaveLength(2);

    const s1Status = status.find((s) => s.name === "s1")!;
    expect(s1Status.status).toBe("ready");
    expect(s1Status.toolCount).toBe(2);

    const s2Status = status.find((s) => s.name === "s2")!;
    expect(s2Status.status).toBe("error");
    expect(s2Status.toolCount).toBe(0);

    await manager.shutdown();
  });

  it("creates StdioMcpClient for stdio transport", async () => {
    const config: McpConfig = {
      servers: {
        test: { command: "echo", transport: "stdio" },
      },
    };

    // Use default factory — just verify it doesn't throw on construction
    // (actual connection would fail without a real server)
    const manager = new McpManager(config);
    const status = manager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].name).toBe("test");
  });

  it("creates SseMcpClient for sse transport", async () => {
    const config: McpConfig = {
      servers: {
        test: { url: "http://localhost:1234", transport: "sse" },
      },
    };

    const manager = new McpManager(config);
    const status = manager.getStatus();
    expect(status).toHaveLength(1);
  });

  it("creates SseMcpClient for http transport", async () => {
    const config: McpConfig = {
      servers: {
        test: { url: "http://localhost:1234", transport: "http" },
      },
    };

    const manager = new McpManager(config);
    const status = manager.getStatus();
    expect(status).toHaveLength(1);
  });

  it("handles empty config (no servers)", async () => {
    const manager = new McpManager({});
    await manager.start();

    expect(manager.getTools()).toEqual([]);
    expect(await manager.getResourceContext()).toBe("");
    expect(manager.getStatus()).toEqual([]);

    await manager.shutdown();
  });

  it("handles config with empty servers object", async () => {
    const manager = new McpManager({ servers: {} });
    await manager.start();

    expect(manager.getTools()).toEqual([]);
    await manager.shutdown();
  });

  it("uses custom toolPrefix from config", async () => {
    const clients = new Map<string, MockMcpClient>();
    clients.set(
      "my-server",
      new MockMcpClient(
        "my-server",
        { command: "a", toolPrefix: "custom" },
        {
          tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }],
        },
      ),
    );

    const config: McpConfig = {
      servers: {
        "my-server": { command: "a", toolPrefix: "custom" },
      },
    };

    const manager = new McpManager(config, { clientFactory: createMockFactory(clients) });
    await manager.start();

    const tools = manager.getTools();
    expect(tools[0].name).toBe("mcp_custom_search");

    await manager.shutdown();
  });
});
