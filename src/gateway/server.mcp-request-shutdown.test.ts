import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { getOrCreateSessionMcpRuntime } from "../agents/agent-bundle-mcp-manager.test-support.js";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { fetchMcpAppView } from "../agents/mcp-ui-resource.js";
import { writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

const testLifetime = createFixtureLifetime();
// Register after Gateway hooks so this join precedes their shared-state reset.
afterEach(() => testLifetime.cleanup());

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
const mcpConfig = (servers: Record<string, McpServerConfig>): OpenClawConfig => ({
  mcp: { apps: { enabled: true }, servers },
});
async function prepareView(runtime: SessionMcpRuntime, serverName: string, toolName: string) {
  return expectDefined(
    await fetchMcpAppView({
      runtime,
      agentId: "main",
      serverName,
      toolName,
      uiResourceUri: `ui://${serverName}/app`,
      toolInput: {},
      toolResult: { content: [] },
      allowedAppToolNames: new Set([toolName]),
    }),
    "prepared MCP App view",
  );
}

async function writeShutdownServer(
  root: string,
  enteredPath: string,
  receipts: FixtureReceiptChannel,
) {
  const serverPath = path.join(root, "server.mjs");
  await fs.writeFile(
    serverPath,
    `import { writeFileSync } from "node:fs";
  import { createInterface } from "node:readline";
  ${fixtureReceiptClientSource(receipts.endpoint)}
  const enteredPath = ${JSON.stringify(enteredPath)};
  const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      send(request.id, {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "shutdown-fixture", version: "1.0.0" },
      });
    } else if (request.method === "tools/list") {
      send(request.id, { tools: [{ name: "blocked_tool", inputSchema: { type: "object", properties: {} } }] });
    } else if (request.method === "resources/read") {
      send(request.id, { contents: [{
        uri: "ui://shutdown/app", mimeType: "text/html;profile=mcp-app",
        text: "<!doctype html><title>Shutdown fixture</title>", _meta: { ui: {} },
      }] });
    } else if (request.method === "tools/call") {
      writeFileSync(enteredPath, "entered");
      sendReceipt(enteredPath, "entered");
    }
  });
  input.on("close", () => process.exit(0));
`,
  );
  return { command: process.execPath, args: [serverPath] };
}

describe("MCP App request shutdown", () => {
  let receipts: FixtureReceiptChannel;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await receipts?.close();
  });

  it("cancels the MCP request before joining its received handler", ({ signal }) =>
    testLifetime.run(async () => {
      const callFinished = createDeferredCore();
      let gateway: GatewayHarness | undefined;
      let ws: WebSocket | undefined;
      let runtime: SessionMcpRuntime | undefined;
      let closing: Promise<void> | undefined;
      let emergencyCleanup: Promise<void> | undefined;
      let emergencyTimer: ReturnType<typeof setTimeout> | undefined;
      let emergencyUsed = false;
      let callStarted = false;
      let callSettled = false;
      let restoreCall: (() => void) | undefined;
      const releaseFailingCandidate = () => {
        emergencyUsed = true;
        emergencyCleanup ??= runtime?.dispose();
        // Keep the original promise for finally; prevent an unobserved timer rejection.
        void emergencyCleanup?.catch(() => undefined);
      };
      signal.addEventListener("abort", releaseFailingCandidate, { once: true });
      try {
        gateway = await createGatewaySuiteHarness({
          serverOptions: { bind: "loopback", auth: { mode: "none" } },
        });
        await gateway.server.startupSettled;
        const root = testLifetime.createTempDir("mcp-shutdown-", resolveStateDir());
        const enteredPath = path.join(root, "tool-entered");
        const server = await writeShutdownServer(root, enteredPath, receipts);
        const cfg = mcpConfig({
          shutdown: {
            ...server,
            codex: { defaultToolsApprovalMode: "approve" },
            // Shutdown must cancel before this supported operator deadline.
            requestTimeoutMs: 600_000,
          },
        });
        await writeConfigFile(cfg);
        ws = await gateway.openWs();
        await connectOk(ws, { scopes: ["operator.admin"] });
        const sessionKey = `agent:main:mcp-shutdown-${randomUUID()}`;
        const created = await rpcReq<{ sessionId: string }>(ws, "sessions.create", {
          agentId: "main",
          key: sessionKey,
        });
        expect(created, JSON.stringify(created.error)).toMatchObject({ ok: true });
        const sessionId = expectDefined(created.payload, "created shutdown session").sessionId;
        runtime = await getOrCreateSessionMcpRuntime({
          sessionId,
          sessionKey,
          workspaceDir: root,
          cfg,
        });
        const view = await prepareView(runtime, "shutdown", "blocked_tool");
        const callTool = runtime.callTool.bind(runtime);
        const call = vi.spyOn(runtime, "callTool").mockImplementation(async (...args) => {
          callStarted = true;
          try {
            return await callTool(...args);
          } finally {
            // The watchdog covers MCP cancellation, not unrelated Gateway teardown.
            clearTimeout(emergencyTimer);
            callSettled = true;
            callFinished.resolve();
          }
        });
        restoreCall = () => call.mockRestore();

        const response = rpcReq(ws, "mcp.app.callTool", {
          sessionKey,
          agentId: "main",
          viewId: view.viewId,
          toolName: "blocked_tool",
        });
        // Receipt delivery is independent of the MCP transport. If the call settles
        // first, its durable marker decides whether the upstream operation entered.
        await withinTest(
          Promise.race([
            receipts.waitFor(enteredPath, "entered"),
            response.then((reply) => {
              throw new Error(
                `MCP request settled before its upstream receipt: ${JSON.stringify(reply)}`,
              );
            }),
            callFinished.promise.then(async () => {
              expect(await fs.readFile(enteredPath, "utf8")).toBe("entered");
            }),
          ]),
          signal,
        );
        expect(callStarted).toBe(true);
        expect(callSettled).toBe(false);

        // The failure escape disposes through the real owner. It cannot make a broken
        // candidate pass, and it releases the native child before fixture restoration.
        emergencyTimer = setTimeout(releaseFailingCandidate, 5_000);
        closing = gateway.server.close({ reason: "MCP cancellation ordering", drainTimeoutMs: 0 });
        await closing;
        const settledAtClose = callSettled;
        await callFinished.promise;
        expect(emergencyUsed, "Gateway close must reach its MCP cancellation owner").toBe(false);
        expect(
          settledAtClose,
          "The native MCP request must settle before Gateway close returns",
        ).toBe(true);
      } finally {
        await testLifetime.verifyCleanup(async () => {
          clearTimeout(emergencyTimer);
          signal.removeEventListener("abort", releaseFailingCandidate);
          await runtime?.dispose();
          if (callStarted) {
            await callFinished.promise;
          }
          await emergencyCleanup;
          ws?.terminate();
          await (closing ?? gateway?.server.close({ drainTimeoutMs: 0 }));
          restoreCall?.();
        });
      }
    }));
});
