import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  disposeAllSessionMcpRuntimes,
  getSessionMcpRuntimeManagerForTesting,
  setSessionMcpRuntimeScheduler,
} from "../agents/agent-bundle-mcp-manager-api.js";
import { testing as mcpRuntimeTesting } from "../agents/agent-bundle-mcp-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let scheduler: GatewayScheduler;

beforeEach(async () => {
  scheduler = createTestGatewayScheduler();
  await setSessionMcpRuntimeScheduler(scheduler);
});

afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await scheduler.stop();
});

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
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    plugins: { enabled: false },
    mcp: {
      servers: {
        sources: {
          command: process.execPath,
          args: [serverPath, startLog, ...(params.serverArgs ?? [])],
        },
        // Safe server names may themselves contain the `__` separator.
        team__sources: { command: process.execPath, args: [serverPath, startLog] },
        broken: { command: process.execPath, args: ["-e", "process.exit(3)"] },
      },
    },
    ...params.extra,
  };
  return {
    config,
    starts: () =>
      (fs.existsSync(startLog) ? fs.readFileSync(startLog, "utf8").split("\n") : []).filter(Boolean)
        .length,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

describe("cron script MCP namespace", () => {
  it.each([
    { mode: "trigger", server: "sources", tool: "list_sources", cursor: "c1" },
    { mode: "payload", server: "sources", tool: "list_sources", cursor: "c1" },
    { mode: "trigger", server: "team__sources", tool: "*", cursor: null },
  ] as const)(
    "calls authorized MCP tools and retires the runtime ($mode, $server/$tool)",
    async ({ mode, server, tool, cursor }) => {
      const fixture = createMcpFixture({
        extra: tool === "*" ? { tools: { deny: ["team__sources__delete_source"] } } : undefined,
      });
      const runtime = createCronScriptRuntime({ config: fixture.config });
      const input = {
        jobId: `mcp-${mode}`,
        script: QUIET_HOUR_SCRIPT.replaceAll(
          "MCP.sources",
          server === "sources" ? "MCP.sources" : "MCP.teamSources",
        ),
        state: cursor === null ? null : { cursor },
        toolsAllow: [`${server}__${tool}`],
      };

      const result =
        mode === "trigger"
          ? await runtime.evaluateTrigger(input)
          : await runtime.executePayload(input);

      expect(result).toMatchObject({
        ...(mode === "trigger" ? { kind: "evaluated", fire: false } : { kind: "completed" }),
        state: {
          cursor: "next",
          listed: { tool: "list_sources", since: cursor ?? "start", sources: [] },
          deleteVisible: false,
        },
      });
      const state = "state" in result ? (result.state as { listed: { pid: number } }) : undefined;
      expect(isProcessAlive(state?.listed.pid ?? 0)).toBe(false);
      expect(fixture.starts()).toBe(1);
      expect(getSessionMcpRuntimeManagerForTesting().listRuntimeKeys()).toEqual([]);
    },
  );

  it.each([
    { caps: "a wildcard", toolsAllow: ["*"], script: "typeof MCP" },
    { caps: "no toolsAllow", toolsAllow: undefined, script: "typeof MCP" },
    { caps: "a script that never mentions it", toolsAllow: ["sources__*"], script: '"undefined"' },
  ])("starts no MCP server for $caps", async ({ toolsAllow, script }) => {
    const fixture = createMcpFixture();
    const runtime = createCronScriptRuntime({ config: fixture.config });

    await expect(
      runtime.evaluateTrigger({
        jobId: "mcp-not-named",
        script: `return { fire: false, state: ${script} };`,
        state: null,
        toolsAllow,
      }),
    ).resolves.toEqual({ kind: "evaluated", fire: false, state: "undefined" });
    expect(fixture.starts()).toBe(0);
    expect(getSessionMcpRuntimeManagerForTesting().listRuntimeKeys()).toEqual([]);
  });

  it("runs past a failed named server and names it when the script fails", async () => {
    const runtime = createCronScriptRuntime({ config: createMcpFixture().config });
    const toolsAllow = ["sources__list_sources", "broken__*"];

    await expect(
      runtime.evaluateTrigger({
        jobId: "mcp-broken",
        script: QUIET_HOUR_SCRIPT,
        state: null,
        toolsAllow,
      }),
    ).resolves.toMatchObject({ kind: "evaluated", fire: false });
    const result = await runtime.evaluateTrigger({
      jobId: "mcp-broken",
      script: "await MCP.broken.ping({}); return { fire: false };",
      state: null,
      toolsAllow,
    });

    expect(result).toMatchObject({ kind: "error", code: "internal_error" });
    expect(result.kind === "error" ? result.error : "").toContain(
      'MCP server "broken" is unavailable',
    );
    expect(getSessionMcpRuntimeManagerForTesting().listRuntimeKeys()).toEqual([]);
  });

  it.each(["evaluated", "aborted"] as const)(
    "returns an %s evaluation while a stubborn MCP server keeps retiring",
    async (outcome) => {
      // Forced shutdown takes 3 s; a finished evaluation waits at most the 1 s cleanup grace.
      mcpRuntimeTesting.setBundleMcpDisposeTimeoutMsForTest(3_000);
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
        const runtime = createCronScriptRuntime({ config: fixture.config });
        const controller = new AbortController();
        const evaluation = runtime.evaluateTrigger({
          jobId: `mcp-stubborn-${outcome}`,
          script: "await MCP.sources.listSources({}); return { fire: false };",
          state: null,
          toolsAllow: ["sources__*"],
          abortSignal: controller.signal,
        });
        // The server holds this socket until it is killed, so its close proves retirement.
        const socket = await connected.promise;
        let retired = false;
        const closed = new Promise<void>((resolve) => {
          socket.once("close", () => {
            retired = true;
            resolve();
          });
        });
        if (outcome === "aborted") {
          controller.abort();
        }

        const result = await evaluation;

        expect(result.kind === "error" ? result.code : result.kind).toBe(outcome);
        expect(retired).toBe(false);
        await closed;
      } finally {
        mcpRuntimeTesting.setBundleMcpDisposeTimeoutMsForTest();
        await new Promise<void>((resolve) => {
          listener.close(() => resolve());
        });
      }
    },
  );
});
