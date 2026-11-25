import { once } from "node:events";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
  testState,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

// The public artifact crosses the plugin boundary without importing its compiler graph.
type QaGatewayFixture = {
  baseUrl: string;
  pid: number | null;
  call(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
};
type QaGatewayFixtureOwner = {
  start(params: {
    repoRoot: string;
    providerMode: "mock-openai";
    controlUiEnabled: boolean;
    transportBaseUrl: string;
    command: {
      executablePath: string;
      argsPrefix: string[];
      tempParentDir: string;
      usePackagedPlugins: boolean;
    };
    onListening: (context: { token: string }) => Promise<void>;
  }): Promise<QaGatewayFixture>;
  stop(): Promise<{ process: string; errors: unknown[] }>;
};

const qaModule = "../../extensions/qa-lab/api.js";
const { createQaGatewayChild } = (await import(qaModule)) as {
  createQaGatewayChild: () => QaGatewayFixtureOwner;
};
installGatewayTestHooks({ scope: "suite" });

type ProxySnapshot = { events: Array<{ kind: string; key?: string }> };
const dirs = createTempDirTracker();
const owner = createQaGatewayChild();
let child: Awaited<ReturnType<typeof owner.start>>;
let backend: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
let observer: WebSocket | undefined;
let childPid: number | null;
let token: string;

async function control(action = "snapshot"): Promise<ProxySnapshot> {
  const response = await fetch(`${child.baseUrl}/__fixture`, {
    method: "POST",
    headers: { "x-qa-fixture-token": token, "content-type": "application/json" },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`proxy control failed: ${response.status}`);
  }
  return (await response.json()) as ProxySnapshot;
}

beforeAll(async () => {
  vi.stubEnv("OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_LIVE_SETUP_TOKEN_VALUE", undefined);
  const root = dirs.make("qa-rpc-replay-");
  const backendPortClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const backendPort = backendPortClaim.port;
  let claimHandedOff = false;
  try {
    child = await owner.start({
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      controlUiEnabled: false,
      transportBaseUrl: "http://127.0.0.1:1",
      command: {
        executablePath: process.execPath,
        argsPrefix: [
          path.resolve("test/fixtures/qa-gateway-rpc-proxy.mjs"),
          String(backendPort),
          process.cwd(),
          path.join(root, "proxy-events.jsonl"),
        ],
        tempParentDir: root,
        usePackagedPlugins: true,
      },
      onListening: async (context) => {
        token = context.token;
        testState.gatewayAuth = { mode: "token", token };
        vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", token);
        claimHandedOff = true;
        backend = await startTestGatewayServer(backendPortClaim, {
          auth: { mode: "token", token },
        });
      },
    });
  } finally {
    if (!claimHandedOff) {
      await backendPortClaim.release();
    }
  }
  childPid = child.pid;
  observer = new WebSocket(`ws://127.0.0.1:${backendPort}`);
  trackConnectChallengeNonce(observer);
  await once(observer, "open");
  await connectOk(observer, { token, scopes: ["operator.admin"] });
  // Family loading is fixture preparation, not the RPC's behavior deadline.
  await rpcReq(observer, "sessions.create", { displayName: "QA replay setup" }, 30_000);
  await rpcReq(observer, "sessions.describe", { key: "main" }, 30_000);
}, 180_000);

afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  let stopped = false;
  try {
    const result = await owner.stop();
    stopped = result.process === "confirmed-stopped";
    cleanupErrors.push(...result.errors);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (observer && observer.readyState !== WebSocket.CLOSED) {
    const closed = once(observer, "close");
    observer.terminate();
    await closed;
  }
  try {
    await backend?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  dirs.cleanup();
  vi.unstubAllEnvs();
  expect(cleanupErrors).toEqual([]);
  expect(stopped).toBe(true);
}, 30_000);

it("does not replay a committed create after losing its response", async () => {
  testState.gatewayAuth = { mode: "token", token };
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", token);
  await control("reset");
  await control("drop-response");
  const request = child.call(
    "sessions.create",
    { displayName: "QA replay lost response" },
    { timeoutMs: 10_000 },
  );
  await expect.soft(request).rejects.toThrow("gateway closed (1006");
  await expect.soft(request).rejects.not.toThrow("label already in use");
  const { events } = await control();
  expect(events.filter((event) => event.kind === "response-dropped")).toHaveLength(1);
  expect(child.pid).toBe(childPid);
  expect.soft(events.filter((event) => event.kind === "mutation-request")).toHaveLength(1);
  const keys = events
    .filter((event) => event.kind === "mutation-success")
    .map((event) => event.key);
  expect.soft(keys).toHaveLength(1);
  for (const key of keys) {
    expect(typeof key).toBe("string");
    const read = await rpcReq<{ session: { key: string } | null }>(observer!, "sessions.describe", {
      key,
    });
    expect(read).toMatchObject({ ok: true, payload: { session: { key } } });
  }
});
