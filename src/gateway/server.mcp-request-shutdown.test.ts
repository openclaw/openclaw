import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { getOrCreateSessionMcpRuntime } from "../agents/agent-bundle-mcp-manager.test-support.js";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { fetchMcpAppView, getMcpAppViewLease } from "../agents/mcp-ui-resource.js";
import { writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { issueOperatorToken } from "./device-authz.test-helpers.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

describe("MCP App request shutdown", () => {
  it("cancels the MCP request before joining its received handler", async ({ signal }) => {
    const callFinished = createDeferredCore();
    let gateway: GatewayHarness | undefined;
    let ws: WebSocket | undefined;
    let runtime: SessionMcpRuntime | undefined;
    let root: string | undefined;
    let closing: Promise<void> | undefined;
    let emergencyCleanup: Promise<void> | undefined;
    let emergencyTimer: ReturnType<typeof setTimeout> | undefined;
    let emergencyUsed = false;
    let callStarted = false;
    let callSettled = false;
    const restorers: Array<() => void> = [];
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
      root = await fs.mkdtemp(path.join(resolveStateDir(), "mcp-shutdown-"));
      const serverPath = path.join(root, "server.mjs");
      const enteredPath = path.join(root, "tool-entered");
      await fs.writeFile(
        serverPath,
        `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
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
    // A real upstream operation remains pending until its transport is closed.
    writeFileSync(enteredPath, "entered");
  }
});
input.on("close", () => process.exit(0));
`,
      );
      const sessionId = `mcp-shutdown-${randomUUID()}`;
      const sessionKey = `agent:main:${sessionId}`;
      runtime = await getOrCreateSessionMcpRuntime({
        sessionId,
        sessionKey,
        workspaceDir: root,
        cfg: {
          mcp: {
            apps: { enabled: true },
            servers: {
              shutdown: {
                command: process.execPath,
                args: [serverPath],
                // Existing supported operator setting; shutdown must cancel before this deadline.
                requestTimeoutMs: 600_000,
              },
            },
          },
        },
      });
      const view = expectDefined(
        await fetchMcpAppView({
          runtime,
          agentId: "main",
          serverName: "shutdown",
          toolName: "blocked_tool",
          uiResourceUri: "ui://shutdown/app",
          toolInput: {},
          toolResult: { content: [] },
          allowedAppToolNames: new Set(["blocked_tool"]),
        }),
        "prepared MCP App view",
      );
      const callTool = runtime.callTool.bind(runtime);
      const call = vi.spyOn(runtime, "callTool").mockImplementation(async (...args) => {
        callStarted = true;
        try {
          return await callTool(...args);
        } finally {
          callSettled = true;
          callFinished.resolve();
        }
      });
      restorers.push(() => call.mockRestore());

      ws = await gateway.openWs();
      await connectOk(ws, { scopes: ["operator.admin"] });
      ws.send(
        JSON.stringify({
          type: "req",
          id: "pending-app-tool",
          method: "mcp.app.callTool",
          params: { sessionKey, agentId: "main", viewId: view.viewId, toolName: "blocked_tool" },
        }),
      );
      await vi.waitFor(async () => expect(await fs.readFile(enteredPath, "utf8")).toBe("entered"), {
        timeout: 5_000,
      });
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
      clearTimeout(emergencyTimer);
      signal.removeEventListener("abort", releaseFailingCandidate);
      await runtime?.dispose();
      if (callStarted) {
        await callFinished.promise;
      }
      await emergencyCleanup;
      ws?.terminate();
      await (closing ?? gateway?.server.close({ drainTimeoutMs: 0 }));
      for (const restore of restorers) {
        restore();
      }
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });
});

function ticketFromStandaloneUrl(url: string | undefined): string {
  const ticket = url?.split("#", 2)[1];
  if (!ticket) {
    throw new Error("expected an MCP App standalone ticket");
  }
  return ticket;
}

async function connectPairedOperator(params: {
  gateway: GatewayHarness;
  scopes: string[];
}): Promise<WebSocket> {
  const issued = await issueOperatorToken({
    name: `mcp-app-authority-${randomUUID()}`,
    approvedScopes: params.scopes,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
  const ws = await params.gateway.openWs();
  await connectOk(ws, {
    skipDefaultAuth: true,
    deviceIdentityPath: issued.identityPath,
    deviceToken: issued.token,
    scopes: params.scopes,
  });
  return ws;
}

async function callStandaloneTool(params: {
  port: number;
  ticket: string;
  label: string;
}): Promise<Response> {
  return await fetch(`http://127.0.0.1:${params.port}/__openclaw__/mcp-app/view`, {
    method: "POST",
    headers: {
      Authorization: `MCP-App ${params.ticket}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      method: "tools/call",
      params: { name: "mutate", arguments: { label: params.label } },
    }),
  });
}

describe("MCP App standalone ticket authority", () => {
  it("binds paired operator scope, separates ticket strength, and revalidates live grants", async () => {
    let gateway: GatewayHarness | undefined;
    let runtime: SessionMcpRuntime | undefined;
    let writer: WebSocket | undefined;
    let reader: WebSocket | undefined;
    let root: string | undefined;
    try {
      await writeConfigFile({ mcp: { apps: { enabled: true } } });
      gateway = await createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "none" } },
      });
      await gateway.server.startupSettled;

      root = await fs.mkdtemp(path.join(resolveStateDir(), "mcp-app-authority-"));
      const serverPath = path.join(root, "server.mjs");
      const markerPath = path.join(root, "tool-calls.jsonl");
      await fs.writeFile(
        serverPath,
        `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const markerPath = ${JSON.stringify(markerPath)};
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "authority-fixture", version: "1.0.0" },
    });
  } else if (request.method === "tools/list") {
    send(request.id, { tools: [{
      name: "mutate",
      inputSchema: { type: "object", properties: { label: { type: "string" } } },
      _meta: { ui: { resourceUri: "ui://authority/app", visibility: ["app"] } },
    }] });
  } else if (request.method === "resources/read") {
    send(request.id, { contents: [{
      uri: "ui://authority/app",
      mimeType: "text/html;profile=mcp-app",
      text: "<!doctype html><title>Authority fixture</title>",
      _meta: { ui: {} },
    }] });
  } else if (request.method === "tools/call") {
    appendFileSync(markerPath, JSON.stringify(request.params.arguments) + "\\n");
    send(request.id, { content: [{ type: "text", text: "mutated" }] });
  }
});
input.on("close", () => process.exit(0));
`,
      );

      const sessionId = `mcp-app-authority-${randomUUID()}`;
      const sessionKey = `agent:main:${sessionId}`;
      runtime = await getOrCreateSessionMcpRuntime({
        sessionId,
        sessionKey,
        workspaceDir: root,
        cfg: {
          mcp: {
            apps: { enabled: true },
            servers: {
              authority: { command: process.execPath, args: [serverPath] },
            },
          },
        },
      });
      const prepared = expectDefined(
        await fetchMcpAppView({
          runtime,
          agentId: "main",
          serverName: "authority",
          toolName: "mutate",
          uiResourceUri: "ui://authority/app",
          toolInput: {},
          toolResult: { content: [] },
          allowedAppToolNames: new Set(["mutate"]),
        }),
        "prepared MCP App view",
      );

      writer = await connectPairedOperator({
        gateway,
        scopes: ["operator.read", "operator.write"],
      });
      reader = await connectPairedOperator({ gateway, scopes: ["operator.read"] });
      const viewParams = { sessionKey, agentId: "main", viewId: prepared.viewId };
      const writerView = await rpcReq<{ standaloneUrl?: string }>(
        writer,
        "mcp.app.view",
        viewParams,
      );
      const readerView = await rpcReq<{ standaloneUrl?: string }>(
        reader,
        "mcp.app.view",
        viewParams,
      );
      if (!writerView.ok) {
        throw new Error(`writer view failed: ${JSON.stringify(writerView.error)}`);
      }
      if (!readerView.ok) {
        throw new Error(`reader view failed: ${JSON.stringify(readerView.error)}`);
      }
      expect(writerView).toMatchObject({ ok: true });
      expect(readerView).toMatchObject({ ok: true });
      const writerTicket = ticketFromStandaloneUrl(writerView.payload?.standaloneUrl);
      const readerTicket = ticketFromStandaloneUrl(readerView.payload?.standaloneUrl);
      expect(readerTicket).not.toBe(writerTicket);

      const directReaderCall = await rpcReq(reader, "mcp.app.callTool", {
        ...viewParams,
        toolName: "mutate",
        arguments: { label: "direct-reader" },
      });
      expect(directReaderCall.ok).toBe(false);
      expect(await fs.readFile(markerPath, "utf8").catch(() => "")).toBe("");

      const readerStandaloneCall = await callStandaloneTool({
        port: gateway.port,
        ticket: readerTicket,
        label: "standalone-reader",
      });
      expect(readerStandaloneCall.status).toBe(403);
      expect(await fs.readFile(markerPath, "utf8").catch(() => "")).toBe("");

      const writerStandaloneCall = await callStandaloneTool({
        port: gateway.port,
        ticket: writerTicket,
        label: "standalone-writer",
      });
      expect(writerStandaloneCall.status).toBe(200);
      expect(await writerStandaloneCall.json()).toMatchObject({ ok: true });
      expect(await fs.readFile(markerPath, "utf8")).toBe('{"label":"standalone-writer"}\n');

      const liveView = expectDefined(
        getMcpAppViewLease(prepared.viewId, runtime),
        "live MCP App view",
      );
      liveView.authorizeAppInteraction = async () => false;
      const revokedCall = await callStandaloneTool({
        port: gateway.port,
        ticket: writerTicket,
        label: "revoked-writer",
      });
      expect(revokedCall.status).toBe(403);
      expect(await fs.readFile(markerPath, "utf8")).toBe('{"label":"standalone-writer"}\n');
    } finally {
      writer?.terminate();
      reader?.terminate();
      await runtime?.dispose();
      await gateway?.close();
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });
});
