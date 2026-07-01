import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { createJsonRpcManifestPluginDefinition } from "./json-rpc-manifest-runtime.js";
import type { AnyAgentTool, OpenClawPluginApi } from "./types.js";

describe("createJsonRpcManifestPluginDefinition", () => {
  const tempDirs: string[] = [];
  const runtimeCleanups: Array<
    NonNullable<Parameters<OpenClawPluginApi["registerRuntimeLifecycle"]>[0]["cleanup"]>
  > = [];

  afterEach(async () => {
    for (const cleanup of runtimeCleanups.splice(0)) {
      await cleanup({ reason: "restart" });
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.OPENCLAW_JSON_RPC_TEST_SECRET;
  });

  it("registers OpenClaw descriptors synchronously and dispatches calls to a stdio JSON-RPC child", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "openclaw-json-rpc-plugin-"));
    tempDirs.push(rootDir);
    const childPath = path.join(rootDir, "child.mjs");
    writeFileSync(childPath, CHILD_RUNTIME, "utf8");

    const tools: AnyAgentTool[] = [];
    let hookHandler: ((event: unknown, context: unknown) => unknown) | undefined;
    let gatewayStopHandler: ((event: unknown, context: unknown) => unknown) | undefined;
    let route: Parameters<OpenClawPluginApi["registerHttpRoute"]>[0] | undefined;
    let gateway:
      | {
          method: string;
          handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
        }
      | undefined;
    const cleanupCallbacks: Array<
      NonNullable<Parameters<OpenClawPluginApi["registerRuntimeLifecycle"]>[0]["cleanup"]>
    > = [];

    const api = createTestPluginApi({
      id: "json-rpc-test",
      name: "JSON RPC Test",
      source: path.join(rootDir, "index.ts"),
      rootDir,
      pluginConfig: { greeting: "hello" },
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
      on(hookName, handler) {
        if (hookName === "gateway_start") {
          hookHandler = handler as (event: unknown, context: unknown) => unknown;
        }
        if (hookName === "gateway_stop") {
          gatewayStopHandler = handler as () => unknown;
        }
      },
      registerHttpRoute(params) {
        route = params;
      },
      registerGatewayMethod(method, handler) {
        gateway = { method, handler };
      },
      registerRuntimeLifecycle(lifecycle) {
        if (lifecycle.cleanup) {
          cleanupCallbacks.push(lifecycle.cleanup);
          runtimeCleanups.push(lifecycle.cleanup);
        }
      },
    });

    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-test",
      name: "JSON RPC Test",
      description: "Test plugin",
      process: {
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        inheritEnv: false,
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_echo",
          description: "Echo through JSON-RPC",
          parameters: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
        {
          type: "hook",
          hook: "gateway_start",
          description: "Gateway startup hook",
        },
        {
          type: "hook",
          hook: "gateway_stop",
          description: "Gateway shutdown hook",
        },
        {
          type: "httpRoute",
          path: "/plugins/json-rpc-test/echo",
          auth: "plugin",
        },
        {
          type: "gatewayMethod",
          method: "jsonRpcTest.status",
          scope: "operator.read",
        },
      ],
    });

    entry.register?.(api);

    expect(tools).toHaveLength(1);
    expect(route?.path).toBe("/plugins/json-rpc-test/echo");
    expect(gateway?.method).toBe("jsonRpcTest.status");

    await expect(tools[0]?.execute("tool-call-1", { value: "tool-value" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "tool:json_rpc_echo:tool-value:tool-call-1:1:1:hello",
        },
      ],
    });

    const gatewayResponses: unknown[] = [];
    await gateway?.handler({
      req: { id: "gateway-1", method: "jsonRpcTest.status" },
      params: { value: "gateway-value" },
      client: {
        connId: "conn-1",
        clientIp: "127.0.0.1",
        connect: { scopes: ["operator.read"] },
      },
      respond: (ok: boolean, payload?: unknown, error?: unknown) =>
        gatewayResponses.push({ ok, payload, error }),
    } as never);
    expect(gatewayResponses).toEqual([
      {
        ok: true,
        payload: {
          method: "jsonRpcTest.status",
          value: "gateway-value",
          initializeCount: 1,
        },
        error: undefined,
      },
    ]);

    const req = makeRequest("POST", "/plugins/json-rpc-test/echo", "http-body");
    const res = new TestResponse();
    await route?.handler(req, res as never);
    expect(res.statusCode).toBe(202);
    expect(res.bodyText()).toBe("POST:/plugins/json-rpc-test/echo:http-body:1");

    const event = {
      type: "gateway",
      action: "startup",
      sessionKey: "session-1",
      context: {},
      timestamp: new Date("2026-06-30T00:00:00.000Z"),
      messages: [],
    };
    await expect(hookHandler?.(event, { registrationMode: "full" })).resolves.toEqual({
      messages: ["hook:startup:1"],
    });

    await cleanupCallbacks[0]?.({ reason: "reset", sessionKey: "session-1" });
    await expect(tools[0]?.execute("tool-call-2", { value: "after-reset" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "tool:json_rpc_echo:after-reset:tool-call-2:1:2:hello",
        },
      ],
    });

    await expect(gatewayStopHandler?.({ action: "stop" }, {})).resolves.toEqual({
      messages: ["hook:stop:1"],
    });
    await expect(tools[0]?.execute("tool-call-after-stop", {})).rejects.toThrow(
      "JSON-RPC plugin process was disposed",
    );
  });

  it("does not inherit parent env when inheritEnv is false", async () => {
    process.env.OPENCLAW_JSON_RPC_TEST_SECRET = "parent-secret";
    const rootDir = mkdtempSync(path.join(tmpdir(), "openclaw-json-rpc-plugin-env-"));
    tempDirs.push(rootDir);
    const childPath = path.join(rootDir, "child.mjs");
    writeFileSync(childPath, ENV_RUNTIME, "utf8");

    const tools: AnyAgentTool[] = [];
    const api = createTestPluginApi({
      id: "json-rpc-env-test",
      name: "JSON RPC Env Test",
      source: path.join(rootDir, "index.ts"),
      rootDir,
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
      registerRuntimeLifecycle(lifecycle) {
        if (lifecycle.cleanup) {
          runtimeCleanups.push(lifecycle.cleanup);
        }
      },
    });

    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-env-test",
      name: "JSON RPC Env Test",
      description: "Test plugin env isolation",
      process: {
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        inheritEnv: false,
        timeoutMs: 1000,
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_env",
          description: "Read env",
        },
      ],
    });

    entry.register?.(api);

    await expect(tools[0]?.execute("tool-call-env", {})).resolves.toEqual({
      content: [{ type: "text", text: "missing" }],
    });
  });

  it("registers generic API descriptors and permits declared child-to-host calls", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "openclaw-json-rpc-plugin-api-"));
    tempDirs.push(rootDir);
    const childPath = path.join(rootDir, "child.mjs");
    writeFileSync(childPath, BIDIRECTIONAL_RUNTIME, "utf8");
    let command: Parameters<OpenClawPluginApi["registerCommand"]>[0] | undefined;
    const requestHeartbeat = vi.fn(() => ({ requested: true }));
    const api = createTestPluginApi({
      id: "json-rpc-api-test",
      name: "JSON RPC API Test",
      source: path.join(rootDir, "index.ts"),
      rootDir,
      runtime: {
        system: { requestHeartbeat },
      } as never,
      registerCommand(registration) {
        command = registration;
      },
      registerRuntimeLifecycle(lifecycle) {
        if (lifecycle.cleanup) {
          runtimeCleanups.push(lifecycle.cleanup);
        }
      },
    });
    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-api-test",
      name: "JSON RPC API Test",
      description: "Generic API registration test",
      process: { command: process.execPath, args: [childPath], cwd: rootDir },
      permissions: { host: ["runtime.system.requestHeartbeat"] },
      registrations: [
        {
          type: "api",
          method: "registerCommand",
          args: [
            {
              name: "rpc-command",
              description: "RPC command",
              handler: { $rpc: "plugin.command.handle" },
            },
          ],
        },
      ],
    });

    entry.register?.(api);
    await expect(command?.handler({ args: "hello" } as never)).resolves.toEqual({
      text: "heartbeat:hello:true",
    });
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "other",
      intent: "event",
      reason: "rpc-command",
    });
  });

  it("does not restart the child after plugin-wide cleanup", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "openclaw-json-rpc-plugin-dispose-"));
    tempDirs.push(rootDir);
    const childPath = path.join(rootDir, "child.mjs");
    writeFileSync(childPath, ENV_RUNTIME, "utf8");

    const tools: AnyAgentTool[] = [];
    let cleanup:
      | NonNullable<Parameters<OpenClawPluginApi["registerRuntimeLifecycle"]>[0]["cleanup"]>
      | undefined;
    const api = createTestPluginApi({
      id: "json-rpc-dispose-test",
      name: "JSON RPC Dispose Test",
      source: path.join(rootDir, "index.ts"),
      rootDir,
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
      registerRuntimeLifecycle(lifecycle) {
        cleanup = lifecycle.cleanup;
        if (lifecycle.cleanup) {
          runtimeCleanups.push(lifecycle.cleanup);
        }
      },
    });

    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-dispose-test",
      name: "JSON RPC Dispose Test",
      description: "Test plugin-wide cleanup",
      process: {
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        inheritEnv: false,
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_dispose",
          description: "Dispose",
        },
      ],
    });

    entry.register?.(api);

    await expect(tools[0]?.execute("tool-call-before-dispose", {})).resolves.toEqual({
      content: [{ type: "text", text: "missing" }],
    });
    await cleanup?.({ reason: "restart" });
    await expect(tools[0]?.execute("tool-call-after-dispose", {})).rejects.toThrow(
      "JSON-RPC plugin process was disposed",
    );
  });

  it("retries initialization after a child reports an initialization error", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "openclaw-json-rpc-plugin-retry-"));
    tempDirs.push(rootDir);
    const childPath = path.join(rootDir, "child.mjs");
    const markerPath = path.join(rootDir, "failed-once");
    writeFileSync(childPath, INIT_FAIL_ONCE_RUNTIME, "utf8");

    const tools: AnyAgentTool[] = [];
    const api = createTestPluginApi({
      id: "json-rpc-retry-test",
      name: "JSON RPC Retry Test",
      source: path.join(rootDir, "index.ts"),
      rootDir,
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
      registerRuntimeLifecycle(lifecycle) {
        if (lifecycle.cleanup) {
          runtimeCleanups.push(lifecycle.cleanup);
        }
      },
    });

    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-retry-test",
      name: "JSON RPC Retry Test",
      description: "Test plugin initialization retry",
      process: {
        command: process.execPath,
        args: [childPath, markerPath],
        cwd: rootDir,
        inheritEnv: false,
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_retry",
          description: "Retry init",
        },
      ],
    });

    entry.register?.(api);

    await expect(tools[0]?.execute("tool-call-fail", {})).rejects.toThrow("fail once");
    await expect(tools[0]?.execute("tool-call-retry", {})).resolves.toEqual({
      content: [{ type: "text", text: "initialized:1" }],
    });
  });

  it("does not let one aborted caller cancel shared initialization", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "openclaw-json-rpc-plugin-abort-"));
    tempDirs.push(rootDir);
    const childPath = path.join(rootDir, "child.mjs");
    writeFileSync(childPath, SLOW_INIT_RUNTIME, "utf8");

    const tools: AnyAgentTool[] = [];
    const api = createTestPluginApi({
      id: "json-rpc-abort-test",
      name: "JSON RPC Abort Test",
      source: path.join(rootDir, "index.ts"),
      rootDir,
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
      registerRuntimeLifecycle(lifecycle) {
        if (lifecycle.cleanup) {
          runtimeCleanups.push(lifecycle.cleanup);
        }
      },
    });

    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-abort-test",
      name: "JSON RPC Abort Test",
      description: "Test plugin initialization abort isolation",
      process: {
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        inheritEnv: false,
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_abort",
          description: "Abort isolation",
        },
      ],
    });

    entry.register?.(api);

    const controller = new AbortController();
    controller.abort();
    const aborted = tools[0]?.execute("tool-call-aborted", {}, controller.signal);
    const active = tools[0]?.execute("tool-call-active", {});

    await expect(aborted).rejects.toThrow("JSON-RPC plugin request aborted");
    await expect(active).resolves.toEqual({
      content: [{ type: "text", text: "active:tool-call-active" }],
    });
  });
});

function makeRequest(method: string, url: string, body: string): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), {
    method,
    url,
    headers: {
      "content-type": "text/plain",
    },
  }) as IncomingMessage;
}

class TestResponse extends Writable {
  statusCode = 200;
  readonly headers = new Map<string, number | string | string[]>();
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: number | string | string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    callback();
  }

  bodyText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

const CHILD_RUNTIME = `
import readline from "node:readline";

let initializeCount = 0;
let toolCallCount = 0;
let greeting = "missing";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  try {
    const result = handle(message.method, message.params);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { message: error instanceof Error ? error.message : String(error) },
    }) + "\\n");
  }
});

function handle(method, params) {
  if (method === "openclaw.initialize") {
    initializeCount += 1;
    greeting = params.pluginConfig.greeting;
    return { ok: true, protocolVersion: 1 };
  }
  if (method === "openclaw.tool.execute") {
    toolCallCount += 1;
    return {
      content: [{
        type: "text",
        text: \`tool:\${params.tool.name}:\${params.params.value}:\${params.toolCallId}:\${initializeCount}:\${toolCallCount}:\${greeting}\`,
      }],
    };
  }
  if (method === "openclaw.gateway.handle") {
    return {
      ok: true,
      payload: {
        method: params.method,
        value: params.params.value,
        initializeCount,
      },
    };
  }
  if (method === "openclaw.http.handle") {
    return {
      status: 202,
      headers: { "content-type": "text/plain" },
      bodyText: \`\${params.request.method}:\${params.request.url}:\${Buffer.from(params.request.bodyBase64, "base64").toString("utf8")}:\${initializeCount}\`,
    };
  }
  if (method === "openclaw.hook.handle") {
    return { messages: [\`hook:\${params.event.action}:\${initializeCount}\`] };
  }
  throw new Error(\`unexpected method: \${method}\`);
}
`;

const BIDIRECTIONAL_RUNTIME = `
import readline from "node:readline";

let nextId = 1;
const pending = new Map();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === "openclaw.initialize") {
    respond(message.id, { ok: true, protocolVersion: 1 });
    return;
  }
  if (message.method === "plugin.command.handle") {
    const hostResult = await request("openclaw.host.call", {
      method: "runtime.system.requestHeartbeat",
      args: [{ source: "other", intent: "event", reason: "rpc-command" }],
    });
    respond(message.id, {
      text: "heartbeat:" + message.params.args[0].args + ":" + hostResult.requested,
    });
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message.result);
  }
});

function request(method, params) {
  const id = "child-" + nextId++;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`;

const ENV_RUNTIME = `
import readline from "node:readline";

process.stderr.write("x".repeat(256 * 1024));

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  const text = message.method === "openclaw.tool.execute"
    ? (process.env.OPENCLAW_JSON_RPC_TEST_SECRET ?? "missing")
    : "ok";
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result: message.method === "openclaw.initialize"
      ? { ok: true, protocolVersion: 1 }
      : { content: [{ type: "text", text }] },
  }) + "\\n");
});
`;

const INIT_FAIL_ONCE_RUNTIME = `
import fs from "node:fs";
import readline from "node:readline";

const markerPath = process.argv[2];
let initializeCount = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "openclaw.initialize") {
    if (!fs.existsSync(markerPath)) {
      fs.writeFileSync(markerPath, "failed", "utf8");
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { message: "fail once" },
      }) + "\\n");
      return;
    }
    initializeCount += 1;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true, protocolVersion: 1 } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result: { content: [{ type: "text", text: \`initialized:\${initializeCount}\` }] },
  }) + "\\n");
});
`;

const SLOW_INIT_RUNTIME = `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "openclaw.initialize") {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true, protocolVersion: 1 } }) + "\\n");
    }, 25);
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result: { content: [{ type: "text", text: \`active:\${message.params.toolCallId}\` }] },
  }) + "\\n");
});
`;
