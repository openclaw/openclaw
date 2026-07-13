// MCP app tests cover explicit resource loading and Codex-facing metadata.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, test } from "vitest";
import {
  loadOpenClawMcpAppResource,
  OPENCLAW_SESSION_APP_MIME_TYPE,
  OPENCLAW_SESSION_APP_URI,
  openClawMcpServerInfo,
  registerOpenClawMcpApp,
} from "./session-app.js";
import { OpenClawSessionTools } from "./session-tools.js";
import { registerSessionMcpTools } from "./session-tools-registration.js";

const tempDirs: string[] = [];
const openServers: Array<{ client: Client; server: McpServer }> = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }),
  );
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createAppFile(contents = "<!doctype html><title>OpenClaw</title>") {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-app-"));
  tempDirs.push(cwd);
  await fs.mkdir(path.join(cwd, "assets"));
  await fs.writeFile(path.join(cwd, "assets", "session.html"), contents, "utf8");
  return cwd;
}

describe("OpenClaw MCP app resource", () => {
  test("loads one explicit cwd-contained app file with a byte cap", async () => {
    const cwd = await createAppFile();

    await expect(
      loadOpenClawMcpAppResource({ cwd, resourcePath: "assets/session.html" }),
    ).resolves.toBe("<!doctype html><title>OpenClaw</title>");

    const outside = path.join(path.dirname(cwd), "outside-openclaw-app.html");
    await fs.writeFile(outside, "outside", "utf8");
    tempDirs.push(outside);
    await expect(
      loadOpenClawMcpAppResource({ cwd, resourcePath: "../outside-openclaw-app.html" }),
    ).rejects.toThrow("must stay within the plugin root");

    const escapedLink = path.join(cwd, "assets", "escaped.html");
    try {
      await fs.symlink(outside, escapedLink);
      await expect(
        loadOpenClawMcpAppResource({ cwd, resourcePath: "assets/escaped.html" }),
      ).rejects.toThrow();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") {
        throw error;
      }
    }

    await fs.writeFile(path.join(cwd, "assets", "huge.html"), "x".repeat(1_048_577), "utf8");
    await expect(
      loadOpenClawMcpAppResource({ cwd, resourcePath: "assets/huge.html" }),
    ).rejects.toThrow();
  });

  test("advertises themed server icons, app resource, and exact Codex entrypoints", async () => {
    const html = "<!doctype html><title>OpenClaw</title>";
    const service = new OpenClawSessionTools({
      request: async () => ({ sessions: [] }),
      access: () => ({
        methods: new Set(["sessions.list", "chat.history", "sessions.create"]),
        scopes: new Set(["operator.read", "operator.write"]),
      }),
    });
    const server = new McpServer(openClawMcpServerInfo());
    registerOpenClawMcpApp(server, {
      html,
      open: async () => await service.open(),
    });
    registerSessionMcpTools(server, service, { appResourceUri: OPENCLAW_SESSION_APP_URI });
    const client = new Client({ name: "openclaw-app-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    openServers.push({ client, server });

    const serverInfo = client.getServerVersion();
    expect(serverInfo?.title).toBe("OpenClaw");
    expect(serverInfo?.icons).toEqual([
      expect.objectContaining({
        src: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
        mimeType: "image/svg+xml",
        theme: "light",
      }),
      expect.objectContaining({
        src: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
        mimeType: "image/svg+xml",
        theme: "dark",
      }),
    ]);

    const tools = await client.listTools();
    const listTool = tools.tools.find((tool) => tool.name === "openclaw_sessions_list");
    expect(listTool?.annotations?.readOnlyHint).toBe(true);
    expect(listTool?.["_meta"]).toMatchObject({ ui: { visibility: ["app"] } });
    const globalTool = tools.tools.find((tool) => tool.name === "openclaw");
    expect(globalTool?.["_meta"]).toEqual({
      "openai/ui": { entrypoints: [{ type: "global" }] },
      ui: { resourceUri: OPENCLAW_SESSION_APP_URI, visibility: ["app"] },
    });
    const detailTool = tools.tools.find((tool) => tool.name === "openclaw_session_detail");
    expect(detailTool?.title).toBe("OpenClaw");
    expect(detailTool?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        session_id: expect.any(Object),
        mode: expect.any(Object),
      },
    });
    expect(detailTool?.["_meta"]).toEqual({
      "openai/ui": {
        entrypoints: [
          {
            type: "sidebar-collection",
            listTool: "openclaw_sessions_list",
            replacesGlobal: true,
            create: {
              title: "New OpenClaw session",
              toolArguments: { mode: "new", chrome: "detail" },
            },
          },
        ],
      },
      ui: { resourceUri: OPENCLAW_SESSION_APP_URI, visibility: ["app"] },
    });

    const resources = await client.listResources();
    expect(resources.resources).toEqual([
      expect.objectContaining({
        uri: OPENCLAW_SESSION_APP_URI,
        mimeType: OPENCLAW_SESSION_APP_MIME_TYPE,
        _meta: { ui: { prefersBorder: false } },
      }),
    ]);
    const resource = await client.readResource({ uri: OPENCLAW_SESSION_APP_URI });
    expect(resource.contents).toEqual([
      {
        uri: OPENCLAW_SESSION_APP_URI,
        mimeType: OPENCLAW_SESSION_APP_MIME_TYPE,
        text: html,
        _meta: { ui: { prefersBorder: false } },
      },
    ]);

    const opened = await client.callTool({ name: "openclaw", arguments: {} });
    expect(opened.structuredContent).toMatchObject({
      items: [],
      capabilities: { list: true, read: true, create: true },
    });
  });
});
