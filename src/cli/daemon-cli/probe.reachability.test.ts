import { once } from "node:events";
import fs from "node:fs/promises";
import { afterEach, assert, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { ensureDashboardGatewayReady } from "../../commands/gateway-readiness.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
  startMinimalRealGateway,
} from "../../gateway/minimal-gateway.test-helpers.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { probeGatewayStatus } from "./probe.js";
import type { DaemonStatus } from "./status.gather.js";

const { gatherStatus, confirm, startGateway, installGateway } = vi.hoisted(() => ({
  gatherStatus: vi.fn(),
  confirm: vi.fn(),
  startGateway: vi.fn(),
  installGateway: vi.fn(),
}));
vi.mock("./status.gather.js", () => ({ gatherDaemonStatus: gatherStatus }));
vi.mock("../prompt.js", () => ({ promptYesNo: confirm }));
vi.mock("./lifecycle.js", () => ({ runDaemonStart: startGateway }));
vi.mock("./install.runtime.js", () => ({ runDaemonInstall: installGateway }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function createProbeServer(options: { rejectUpgrade?: boolean; ambientAuth?: boolean } = {}) {
  const state = await createOpenClawTestState({
    env: options.ambientAuth
      ? { OPENCLAW_GATEWAY_TOKEN: "ambient-token", OPENCLAW_GATEWAY_PASSWORD: "ambient-password" }
      : {},
  });
  cleanups.push(() => state.cleanup());
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    ...(options.rejectUpgrade ? { verifyClient: () => false } : {}),
  });
  cleanups.push(() => closeMinimalGatewayServer(wss));
  if (!wss.address()) {
    await once(wss, "listening");
  }
  const address = wss.address();
  assert(address && typeof address !== "string");
  return { state, wss, url: `ws://127.0.0.1:${address.port}` };
}

function probe(url: string, options: Partial<Parameters<typeof probeGatewayStatus>[0]> = {}) {
  return probeGatewayStatus({ url, config: {}, timeoutMs: 2_000, json: true, ...options });
}

function answerStatus(wss: WebSocketServer, fail = false) {
  let connectAuth: unknown;
  wss.on("connection", (ws) => {
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (frame.method === "connect") {
        connectAuth = frame.params?.auth;
        sendMinimalGatewayResponse(
          ws,
          frame.id!,
          buildMinimalGatewayHelloOkPayload({
            methods: ["status"],
            auth: { role: "operator", scopes: ["operator.read"] },
          }),
        );
      } else if (fail) {
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "UNAVAILABLE", message: "synthetic status failure" },
          }),
        );
      } else {
        sendMinimalGatewayResponse(ws, frame.id!, { status: "ok" });
      }
    });
  });
  return () => connectAuth;
}

async function checkDashboardReadiness(url: string, rpc: NonNullable<DaemonStatus["rpc"]>) {
  const port = Number(new URL(url).port);
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  gatherStatus.mockResolvedValue({
    service: {
      label: "synthetic stopped service",
      loaded: false,
      loadState: { status: "not-loaded" },
      loadedText: "loaded",
      notLoadedText: "not loaded",
      command: null,
      runtime: { status: "stopped" },
    },
    port: { port, status: "busy", listeners: [], hints: [] },
    rpc: { ...rpc, url },
    extraServices: [],
  } satisfies DaemonStatus);
  const result = await ensureDashboardGatewayReady({ runtime, interactive: true });
  for (const action of [confirm, startGateway, installGateway]) {
    expect(action).not.toHaveBeenCalled();
  }
  return { result, output: runtime.log.mock.calls.flat().join("\n") };
}

it.each([{}, { token: "service-token" }, { password: "service-password" }])(
  "freezes resolved service auth %j without pairing writes",
  async (auth) => {
    const { state, wss, url } = await createProbeServer({ ambientAuth: true });
    const connectAuth = answerStatus(wss);
    const before = await fs.readdir(state.stateDir, { recursive: true });
    const rpc = await probe(url, {
      ...auth,
      config: {
        gateway: {
          mode: "local",
          auth: { mode: "none", token: "config-token" },
          remote: { token: "remote-token", password: "remote-password" },
        },
      },
      requireRpc: true,
    });
    expect(rpc, JSON.stringify(rpc)).toMatchObject({ ok: true });
    expect(connectAuth() ?? {}).toEqual(auth);
    expect(await fs.readdir(state.stateDir, { recursive: true })).toEqual(before);
  },
);

it.each(["terminate", "policy-close", "silent", "upgrade-rejected"] as const)(
  "does not start a second service or accept a %s listener",
  async (mode) => {
    const { wss, url } = await createProbeServer({ rejectUpgrade: mode === "upgrade-rejected" });
    wss.on("connection", (ws) => {
      if (mode === "terminate") {
        ws.terminate();
      } else if (mode === "policy-close") {
        ws.close(1008, "pairing required");
      }
    });
    const rpc = await probe(url, { timeoutMs: 400 });
    assert(!rpc.ok);
    expect(rpc.gatewayReached).toBeUndefined();
    if (mode === "terminate") {
      expect(rpc.error).toContain("gateway closed (1006)");
    }
    const { result, output } = await checkDashboardReadiness(url, rpc);
    expect(result).toMatchObject({ ready: false, recoverable: false });
    expect(output).toContain("Gateway check failed:");
    expect(output).not.toMatch(/Gateway is not running|gateway start/);
  },
);

it("preserves the accepted handshake when a subsequent status RPC fails", async () => {
  const { wss, url } = await createProbeServer();
  answerStatus(wss, true);
  const rpc = await probe(url, {
    urlOverride: url,
    token: "synthetic-token",
    requireRpc: true,
  });
  expect(rpc).toMatchObject({
    ok: false,
    gatewayReached: true,
    error: "synthetic status failure",
    capability: "read_only",
    server: { version: "test", connId: "conn-test" },
  });
  expect((await checkDashboardReadiness(url, rpc)).result.ready).toBe(true);
});

it("accepts a real Gateway auth rejection as reachable without starting another service", async ({
  signal,
}) => {
  const gateway = await startMinimalRealGateway({
    signal,
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
  const rejected = await probe(gateway.url, { token: "synthetic-wrong-token", timeoutMs: 5_000 });
  expect(rejected).toMatchObject({
    ok: false,
    gatewayReached: true,
    connectFailure: { kind: "auth-rejected" },
  });
  expect((await checkDashboardReadiness(gateway.url, rejected)).result.ready).toBe(true);
  const accepted = await probe(gateway.url, { token: gateway.token, timeoutMs: 5_000 });
  expect(accepted.ok).toBe(true);
  expect((await checkDashboardReadiness(gateway.url, accepted)).result.ready).toBe(true);
});
