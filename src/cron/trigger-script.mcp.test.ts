import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import {
  bindSessionMcpRuntimeTestScheduler,
  getSessionMcpRuntimeTestManager,
} from "../agents/agent-bundle-mcp-manager.test-support.js";
import * as mcpClientLifecycle from "../agents/mcp-client-lifecycle.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(bindSessionMcpRuntimeTestScheduler);
afterEach(disposeAllSessionMcpRuntimes);

// Minimal stdio MCP server: records each start, and each call reports the serving pid.
// With a port it ignores SIGTERM and stdin EOF and holds a socket until killed; "hang" skips replies.
const SOURCES_SERVER = `
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";
const [startLog, port, mode] = process.argv.slice(2);
fs.appendFileSync(startLog, "start\\n");
if (port) {
  process.on("SIGTERM", () => {});
  net.connect(Number(port), "127.0.0.1");
}
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (mode === "hang") continue;
  if (message.method === "initialize") reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "sources", version: "1" } });
  if (message.method === "tools/list") reply(message.id, { tools: [
    { name: "list_sources", inputSchema: { type: "object", properties: { since: { type: "string" } } } },
    { name: "delete_source", inputSchema: { type: "object" } },
  ] });
  if (message.method === "tools/call") reply(message.id, { structuredContent: { pid: process.pid, tool: message.params.name, since: message.params.arguments?.since ?? null, sources: [] }, content: [{ type: "text", text: "listed" }] });
}
`;

function createMcpFixture(params: { extra?: Partial<OpenClawConfig>; serverArgs?: string[] } = {}) {
  const root = tempDirs.make("openclaw-cron-mcp-");
  const serverPath = path.join(root, "sources.mjs");
  const startLog = path.join(root, "starts.log");
  fs.writeFileSync(serverPath, SOURCES_SERVER);
  const command = (args: string[]) => ({ command: process.execPath, args });
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    plugins: { enabled: false },
    mcp: {
      servers: {
        sources: command([serverPath, startLog, ...(params.serverArgs ?? [])]),
        // Safe server names may themselves contain the `__` separator.
        team__sources: command([serverPath, startLog]),
        broken: command(["-e", "process.exit(3)"]),
      },
    },
    ...params.extra,
  };
  const runtime = createCronScriptRuntime({ config });
  return {
    evaluate: (input: Partial<Parameters<typeof runtime.evaluateTrigger>[0]> = {}) =>
      runtime.evaluateTrigger({
        jobId: "mcp-trigger",
        script: QUIET_HOUR_SCRIPT,
        state: null,
        ...input,
      }),
    starts: () =>
      (fs.existsSync(startLog) ? fs.readFileSync(startLog, "utf8").split("\n") : []).filter(Boolean)
        .length,
  };
}

const QUIET_HOUR_SCRIPT = `
const listed = await MCP.sources.listSources({ since: trigger.state?.cursor ?? "start" });
return {
  fire: false,
  state: {
    cursor: "next",
    listed: listed.structuredContent,
    deleteVisible: typeof MCP.sources.deleteSource === "function",
  },
};
`;

it.each([
  { server: "sources", tool: "list_sources", cursor: "c1" },
  { server: "team__sources", tool: "*", cursor: null },
] as const)(
  "calls authorized MCP tools and retires the runtime ($server/$tool)",
  async ({ server, tool, cursor }) => {
    const fixture = createMcpFixture({
      extra: tool === "*" ? { tools: { deny: ["team__sources__delete_source"] } } : undefined,
    });
    const result = await fixture.evaluate({
      script: QUIET_HOUR_SCRIPT.replaceAll(
        "MCP.sources",
        server === "sources" ? "MCP.sources" : "MCP.teamSources",
      ),
      state: cursor === null ? null : { cursor },
      toolsAllow: [`${server}__${tool}`],
    });
    expect(result).toMatchObject({
      kind: "evaluated",
      fire: false,
      state: {
        cursor: "next",
        listed: { tool: "list_sources", since: cursor ?? "start", sources: [] },
        deleteVisible: false,
      },
    });
    const state = "state" in result ? (result.state as { listed: { pid: number } }) : undefined;
    expect(() => process.kill(state?.listed.pid ?? 0, 0)).toThrow();
    expect(fixture.starts()).toBe(1);
    expect(getSessionMcpRuntimeTestManager().listRuntimeKeys()).toEqual([]);
  },
);

it.each([
  { caps: "a wildcard", toolsAllow: ["*"] },
  { caps: "no toolsAllow", toolsAllow: undefined },
])("starts no MCP server for $caps", async ({ toolsAllow }) => {
  const fixture = createMcpFixture();
  await expect(
    fixture.evaluate({ script: "return { fire: false, state: typeof MCP };", toolsAllow }),
  ).resolves.toEqual({ kind: "evaluated", fire: false, state: "undefined" });
  expect(fixture.starts()).toBe(0);
  expect(getSessionMcpRuntimeTestManager().listRuntimeKeys()).toEqual([]);
});

it("runs past a failed named server and names it when the script fails", async () => {
  const fixture = createMcpFixture();
  const toolsAllow = ["sources__list_sources", "broken__*"];
  await expect(fixture.evaluate({ toolsAllow })).resolves.toMatchObject({
    kind: "evaluated",
    fire: false,
  });
  await expect(
    fixture.evaluate({
      script: "await MCP.broken.ping({}); return { fire: false };",
      toolsAllow,
    }),
  ).resolves.toMatchObject({
    kind: "error",
    code: "internal_error",
    error: expect.stringContaining('MCP server "broken" is unavailable'),
  });
  expect(getSessionMcpRuntimeTestManager().listRuntimeKeys()).toEqual([]);
});

it.each(["evaluated", "aborted"] as const)(
  "returns an %s evaluation while a stubborn MCP server keeps retiring",
  async (outcome) => {
    // Forced shutdown takes 3 s; a finished evaluation waits at most the 1 s cleanup grace.
    const dispose = mcpClientLifecycle.disposeMcpClient;
    const disposing = vi
      .spyOn(mcpClientLifecycle, "disposeMcpClient")
      .mockImplementation((session) => dispose(session, 3_000));
    const connected = createDeferred<net.Socket>();
    const listener = net.createServer((socket) => connected.resolve(socket));
    await new Promise<void>((resolve) => {
      listener.listen(0, "127.0.0.1", resolve);
    });
    try {
      const port = (listener.address() as AddressInfo).port;
      const fixture = createMcpFixture({
        serverArgs: [`${port}`, outcome === "aborted" ? "hang" : "reply"],
      });
      const controller = new AbortController();
      const evaluation = fixture.evaluate({
        script: "await MCP.sources.listSources({}); return { fire: false };",
        toolsAllow: ["sources__*"],
        abortSignal: controller.signal,
      });
      // The server holds this socket until it is killed, so its close proves retirement.
      const socket = await connected.promise;
      let retired = false;
      const closed = createDeferred();
      socket.once("close", () => {
        retired = true;
        closed.resolve();
      });
      if (outcome === "aborted") {
        controller.abort();
      }

      const result = await evaluation;

      expect(result.kind === "error" ? result.code : result.kind).toBe(outcome);
      expect(retired).toBe(false);
      await closed.promise;
    } finally {
      disposing.mockRestore();
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
      });
    }
  },
);
