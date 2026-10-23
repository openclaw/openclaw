import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.js";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { withinTest } from "../helpers/promise.js";

type ScriptResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type GatewayFrame = {
  id: string;
  method: string;
  params?: InvokeParams;
  type: string;
};
type InvokeParams = { command?: string; idempotencyKey?: string };
type Report = {
  results: Array<{ error?: string; id: string; ok: boolean; payload?: unknown }>;
};
type PayloadMode = "empty" | "invalid-payload-json" | "primitive-device-info" | "valid";

let server: Server | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  if (wss) {
    await new Promise<void>((resolve) => {
      wss?.close(() => resolve());
    });
  }
  wss = undefined;
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
  server = undefined;
});

function invokePayload(command: string, mode: PayloadMode): unknown {
  if (mode === "primitive-device-info" && command === "device.info") {
    return "ok";
  }
  if (mode === "invalid-payload-json" && command === "device.status") {
    return { payloadJSON: "{" };
  }
  if (mode === "empty") {
    return {};
  }
  return command === "device.info" ? { systemName: "iOS", systemVersion: "18.0" } : { ok: true };
}

async function listenGateway(params: {
  mode: PayloadMode;
  invokeParams: InvokeParams[];
}): Promise<string> {
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as GatewayFrame;
      if (frame.type !== "req") {
        return;
      }
      const reply = (payload: unknown, ok = true) => {
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok,
            ...(ok ? { payload } : { error: payload }),
          }),
        );
      };
      if (frame.method === "connect") {
        return reply({ connected: true });
      }
      if (frame.method === "health") {
        return reply({ status: "ok" });
      }
      if (frame.method === "node.list") {
        return reply({
          nodes: [{ nodeId: "ios-node", platform: "iOS", connected: true }],
        });
      }
      if (frame.method === "node.invoke") {
        params.invokeParams.push(frame.params ?? {});
        return reply({
          ok: true,
          nodeId: "ios-node",
          command: frame.params?.command,
          payload: invokePayload(frame.params?.command ?? "", params.mode),
        });
      }
      reply(`unexpected method ${frame.method}`, false);
    });
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test websocket server did not get a TCP address");
  }
  return `ws://127.0.0.1:${address.port}`;
}

async function runGateway(mode: PayloadMode, signal: AbortSignal, status: number) {
  const invokeParams: InvokeParams[] = [];
  const url = await listenGateway({ mode, invokeParams });
  const result = await runScriptRaw(gatewayArgs(url), signal);
  expect(result).toMatchObject({ signal: null, status });
  const report: Report = JSON.parse(result.stdout);
  return { report, invokeParams };
}

const gatewayArgs = (url = "ws://127.0.0.1:9") => ["--url", url, "--token", "token", "--json"];

async function runScriptRaw(args: readonly string[], signal: AbortSignal): Promise<ScriptResult> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/dev/ios-node-e2e.ts", ...args],
    { stdio: "pipe" },
  );
  const stdout = createBoundedChildOutput();
  const stderr = createBoundedChildOutput();
  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  // Retain close from launch so abort cleanup joins the process and both output pipes.
  const closed = new Promise<ScriptResult>((resolve) => {
    child.once("close", (status, childSignal) => {
      resolve({
        status,
        signal: childSignal,
        stdout: stdout.text(),
        stderr: stderr.text(),
      });
    });
  });
  try {
    const result = await withinTest(closed, signal);
    if (spawnError) {
      throw spawnError;
    }
    return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  }
}

describe("ios-node-e2e", () => {
  it.for([
    [[...gatewayArgs(), "--wat"], "Unknown argument: --wat"],
    [["--url", "-h", "--token", "token"], "--url requires a value"],
    [
      [...gatewayArgs(), "--wait-seconds", "1e3"],
      expect.stringContaining("--wait-seconds must be a positive integer; got: 1e3"),
    ],
  ] as const)("rejects CLI args %j before connecting", async ([args, error], { signal }) => {
    const result = await runScriptRaw(args, signal);
    expect({ ...result, stderr: result.stderr.trim() }).toEqual({
      signal: null,
      status: 1,
      stdout: "",
      stderr: error,
    });
  });

  it("fails empty node invoke payloads instead of counting them as proof", async ({ signal }) => {
    const { report, invokeParams } = await runGateway("empty", signal, 10);
    expect(report.results[0]).toMatchObject({
      error: "device.info returned an empty object payload",
      id: "device.info",
      ok: false,
      payload: { ok: true, payload: {} },
    });
    expect(report.results.every((entry) => !entry.ok)).toBe(true);
    expect(invokeParams.length).toBeGreaterThan(0);
  });

  it.for([
    ["primitive-device-info", 0, "device.info", "device.info returned a string payload"],
    ["invalid-payload-json", 1, "device.status", "device.status returned no payload"],
  ] as const)("fails malformed %s payloads", async ([mode, index, id, error], { signal }) => {
    const { report } = await runGateway(mode, signal, 10);
    expect(report.results[index]).toMatchObject({ error, id, ok: false });
  });

  it("accepts non-empty node invoke payloads and sends idempotency keys", async ({ signal }) => {
    const { report, invokeParams } = await runGateway("valid", signal, 0);
    expect(report.results.every((entry) => entry.ok)).toBe(true);
    expect(invokeParams.map((params) => params.command)).toEqual([
      "device.info",
      "device.status",
      "system.notify",
      "contacts.search",
      "calendar.events",
      "reminders.list",
      "motion.pedometer",
      "photos.latest",
    ]);
    expect(invokeParams.every((params) => typeof params.idempotencyKey === "string")).toBe(true);
  });
});
