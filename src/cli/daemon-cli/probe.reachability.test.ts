import { once } from "node:events";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { dashboardCommand } from "../../commands/dashboard.js";
import { baseConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
  startMinimalRealGateway,
} from "../../gateway/minimal-gateway.test-helpers.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { probeGatewayStatus } from "./probe.js";
import type { DaemonStatus } from "./status.gather.js";

const { gatherStatus, confirm, startGateway, installGateway, target } = vi.hoisted(() => ({
  gatherStatus: vi.fn(),
  confirm: vi.fn(),
  startGateway: vi.fn(),
  installGateway: vi.fn(),
  target: { url: "ws://127.0.0.1:18789" },
}));
vi.mock("./status.gather.js", () => ({ gatherDaemonStatus: gatherStatus }));
vi.mock("../prompt.js", () => ({ promptYesNo: confirm }));
vi.mock("./lifecycle.js", () => ({ runDaemonStart: startGateway }));
vi.mock("./install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install.js")>()),
  runDaemonInstall: installGateway,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => ({ ...baseConfigSnapshot, sourceConfig: {} }),
}));
vi.mock("../../commands/control-ui-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/control-ui-handoff.js")>()),
  resolveControlUiHandoffTarget: async () => ({
    port: Number(new URL(target.url).port),
    bind: "loopback",
    links: { httpUrl: "http://127.0.0.1/", wsUrl: target.url },
    authMode: "token",
    includeTokenInUrl: false,
    dashboardUrl: "http://127.0.0.1/",
    documentUrl: "http://127.0.0.1/",
    probeUrl: target.url,
  }),
  waitForControlUiDocument: async () => ({ ready: true }),
  issueControlUiBrowserHandoff: async () => ({ browserUrl: "http://127.0.0.1/" }),
}));
vi.mock("../../infra/clipboard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/clipboard.js")>()),
  copyToClipboard: async () => true,
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function createListener(connection: (ws: WebSocket) => void, rejectUpgrade = false) {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    ...(rejectUpgrade ? { verifyClient: () => false } : {}),
  });
  cleanups.push(() => closeMinimalGatewayServer(wss));
  wss.on("connection", connection);
  await once(wss, "listening");
  const address = wss.address();
  assert(address && typeof address !== "string");
  return `ws://127.0.0.1:${address.port}`;
}

function serveStatus(ws: WebSocket, auth: unknown[], error?: string) {
  sendMinimalGatewayConnectChallenge(ws);
  ws.on("message", (data) => {
    const frame = parseMinimalGatewayRequestFrame(data);
    if (frame.method === "connect") {
      auth.push(frame.params?.auth);
      sendMinimalGatewayResponse(
        ws,
        frame.id!,
        buildMinimalGatewayHelloOkPayload({
          methods: ["status"],
          auth: { role: "operator", scopes: ["operator.read"] },
        }),
      );
    } else if (error) {
      ws.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: "UNAVAILABLE", message: error },
        }),
      );
    } else {
      sendMinimalGatewayResponse(ws, frame.id!, { status: "ok" });
    }
  });
}

async function createState(options?: Parameters<typeof createOpenClawTestState>[0]) {
  const state = await createOpenClawTestState(options);
  cleanups.push(() => state.cleanup());
  return state;
}

async function stateFiles(stateDir: string) {
  return (await listDirectoryTreeStrict(stateDir)).map((entry) => entry.relativePath);
}

async function checkDashboardReadiness(url: string, rpc: NonNullable<DaemonStatus["rpc"]>) {
  target.url = url;
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
  await dashboardCommand(runtime, { noOpen: true });
  expect(confirm).not.toHaveBeenCalled();
  expect(startGateway).not.toHaveBeenCalled();
  expect(installGateway).not.toHaveBeenCalled();
  const output = runtime.log.mock.calls.flat().join("\n");
  return { ready: output.includes("Dashboard URL:"), output };
}

describe("Gateway reachability over real sockets", () => {
  it.each([{}, { token: "service-token" }, { password: "service-password" }])(
    "freezes resolved service auth %j without pairing writes",
    async (auth) => {
      const state = await createState({
        env: {
          OPENCLAW_GATEWAY_TOKEN: "ambient-token",
          OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
        },
      });
      const connectAuth: unknown[] = [];
      const url = await createListener((ws) => serveStatus(ws, connectAuth));
      const before = await stateFiles(state.stateDir);
      const rpc = await probeGatewayStatus({
        url,
        ...auth,
        config: {
          gateway: {
            mode: "local",
            auth: { mode: "none", token: "config-token" },
            remote: { token: "remote-token", password: "remote-password" },
          },
        },
        timeoutMs: 2_000,
        json: true,
        requireRpc: true,
      });
      expect(rpc, JSON.stringify(rpc)).toMatchObject({ ok: true });
      expect(connectAuth.at(-1) ?? {}).toEqual(auth);
      expect(await stateFiles(state.stateDir)).toEqual(before);
    },
  );

  it.each(["terminate", "policy-close", "silent", "upgrade-rejected"] as const)(
    "does not start a second service or accept a %s listener",
    async (mode) => {
      await createState();
      const url = await createListener((ws) => {
        if (mode === "terminate") {
          ws.terminate();
        } else if (mode === "policy-close") {
          ws.close(1008, "pairing required");
        }
      }, mode === "upgrade-rejected");
      const rpc = await probeGatewayStatus({ url, config: {}, timeoutMs: 400, json: true });
      assert(!rpc.ok);
      expect(rpc.gatewayReached).toBeUndefined();
      if (mode === "terminate") {
        expect(rpc.error).toContain("gateway closed (1006)");
      }
      const { ready, output } = await checkDashboardReadiness(url, rpc);
      expect(ready).toBe(false);
      expect(output).toContain("Gateway check failed:");
      expect(output).not.toContain("Gateway is not running");
      expect(output).not.toContain("gateway start");
    },
  );

  it("preserves the accepted handshake when a subsequent status RPC fails", async () => {
    await createState();
    const url = await createListener((ws) => serveStatus(ws, [], "synthetic status failure"));
    const rpc = await probeGatewayStatus({
      url,
      urlOverride: url,
      token: "synthetic-token",
      config: {},
      timeoutMs: 2_000,
      json: true,
      requireRpc: true,
    });
    expect(rpc).toMatchObject({
      ok: false,
      gatewayReached: true,
      error: "synthetic status failure",
      capability: "read_only",
      server: { version: "test", connId: "conn-test" },
    });
    expect((await checkDashboardReadiness(url, rpc)).ready).toBe(true);
  });

  it("accepts a real Gateway auth rejection as reachable without starting another service", async ({
    signal,
  }) => {
    const gateway = await startMinimalRealGateway({
      signal,
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const rejected = await probeGatewayStatus({
      url: gateway.url,
      token: "synthetic-wrong-token",
      config: {},
      timeoutMs: 5_000,
      json: true,
    });
    expect(rejected).toMatchObject({
      ok: false,
      gatewayReached: true,
      connectFailure: { kind: "auth-rejected" },
    });
    expect((await checkDashboardReadiness(gateway.url, rejected)).ready).toBe(true);
    const accepted = await probeGatewayStatus({
      url: gateway.url,
      token: gateway.token,
      config: {},
      timeoutMs: 5_000,
      json: true,
    });
    expect(accepted.ok).toBe(true);
    expect((await checkDashboardReadiness(gateway.url, accepted)).ready).toBe(true);
  });
});
