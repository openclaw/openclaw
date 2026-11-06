import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { WORKER_PUBLIC_INGRESS_PATH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { captureEnv, setTestEnvValue, withEnv } from "../test-utils/env.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler } from "./server-http-upgrades.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import {
  classifyGatewayStaleInstall,
  registerGatewayInstallationReplacementHandler,
} from "./stale-install.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  readConnectChallengeNonce,
} from "./test-helpers.server.js";
import { readClientResponseBody } from "./test-http-response.js";
import { withTempConfig } from "./test-temp-config.js";

installGatewayTestHooks({ scope: "suite" });
await import("./server.js");
afterEach(resetGatewayWorkAdmission);

async function withUpgradeServer(
  options: Pick<
    Parameters<typeof attachGatewayUpgradeHandler>[0],
    "workerIngressEnabled" | "isStartupPending"
  >,
  run: (
    port: number,
    accepted: ReturnType<typeof vi.fn<(socket: WebSocket) => void>>,
  ) => Promise<void>,
  onConnection: (socket: WebSocket) => void = (socket) => socket.close(),
) {
  setRuntimeConfigSnapshot({});
  const clients = new GatewayClientRegistry();
  const resolvedAuth = { mode: "none" as const, allowTailscale: false };
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ maxPayload: 1024, noServer: true });
  const accepted = vi.fn(onConnection);
  wss.on("connection", accepted);
  attachGatewayUpgradeHandler({
    httpServer,
    wss,
    clients,
    resolvedAuth,
    preauthConnectionBudget: withEnv(
      { OPENCLAW_MAX_PREAUTH_CONNECTIONS_PER_IP: "1" },
      createPreauthConnectionBudget,
    ),
    ...options,
  });
  try {
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await run(port, accepted);
  } finally {
    const closed = once(wss, "close");
    wss.close();
    await closed;
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    clearRuntimeConfigSnapshot();
  }
}

async function withSuspension(suspended: boolean | undefined, run: () => Promise<void>) {
  const suspension =
    suspended === undefined ? undefined : tryBeginGatewaySuspendAdmission(() => {});
  try {
    if (suspended) {
      expect(suspension?.commit()).toBe(true);
    }
    await run();
  } finally {
    if (suspended) {
      suspension?.release();
    } else {
      suspension?.rollback();
    }
  }
}

async function withGateway(
  run: (harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>) => Promise<void>,
  suspended?: boolean,
) {
  const harness = await createGatewaySuiteHarness();
  try {
    await withSuspension(suspended, () => run(harness));
  } finally {
    await harness.close();
  }
}

async function closeSocket(ws: WebSocket) {
  const closed = once(ws, "close");
  ws.close();
  await closed;
}

async function expectUnavailable(port: number, body: string, path = "/") {
  await expect(requestUpgradeRejection(port, path)).resolves.toEqual({ status: 503, body });
}

async function requestUpgradeRejection(
  port: number,
  path = "/",
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGVzdC1rZXktMDEyMzQ1Ng==",
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });
    req.once("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("expected websocket upgrade to be rejected"));
    });
    req.once("response", (res) => {
      void readClientResponseBody(res).then(resolve, reject);
    });
    req.once("error", reject);
  });
}

describe("gateway pre-auth hardening", () => {
  it("rejects unattributable proxy traffic on the public worker path", () =>
    withUpgradeServer({ workerIngressEnabled: true }, async (port, accepted) => {
      const response = await requestUpgradeRejection(port, WORKER_PUBLIC_INGRESS_PATH, {
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "gateway.example",
      });
      expect(response).toMatchObject({
        status: 403,
        body: expect.stringContaining("proxy_attribution_required"),
      });
      expect(accepted).not.toHaveBeenCalled();
    }));

  it.each([false, true])("rejects worker upgrades (suspended: %s)", (suspended) =>
    withUpgradeServer({ workerIngressEnabled: suspended }, (port) =>
      withSuspension(suspended || undefined, () =>
        expectUnavailable(
          port,
          suspended ? "Worker websocket admission closed" : "Worker websocket ingress unavailable",
          WORKER_PUBLIC_INGRESS_PATH,
        ),
      ),
    ),
  );

  it.each([false, true])("gates core upgrades by suspension readiness (prepared: %s)", (prepared) =>
    withGateway(async (harness) => {
      if (prepared) {
        const ws = await harness.openWs();
        await expect(readConnectChallengeNonce(ws)).resolves.toEqual(expect.any(String));
        await closeSocket(ws);
      } else {
        await expectUnavailable(harness.port, "Gateway websocket admission closed");
      }
    }, prepared),
  );

  it.each([false, true])(
    "explains core websocket refusal during restart drain (replacement=%s)",
    (replacement) =>
      withGateway(async (harness) => {
        const dispose = registerGatewayInstallationReplacementHandler(() => {});
        if (replacement) {
          classifyGatewayStaleInstall(
            Object.assign(new Error("own chunk missing"), {
              code: "ERR_MODULE_NOT_FOUND",
              url: new URL("./missing-runtime.mjs", import.meta.url).href,
            }),
          );
        }
        markGatewayRestartDraining();
        try {
          await expectUnavailable(
            harness.port,
            replacement
              ? expect.stringContaining("Installation replaced: running")
              : "Gateway websocket admission closed",
          );
        } finally {
          dispose();
        }
      }),
  );

  it("opens only the startup generation core preauth transport during restart drain", () =>
    withUpgradeServer(
      { isStartupPending: () => true, workerIngressEnabled: true },
      async (port) => {
        markGatewayRestartDraining();
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const challenge = readConnectChallengeNonce(ws);
        try {
          await expect(challenge).resolves.toBe("startup-preauth");
          await expectUnavailable(
            port,
            "Worker websocket admission closed",
            WORKER_PUBLIC_INGRESS_PATH,
          );
        } finally {
          await closeSocket(ws);
        }
      },
      (socket) => {
        socket.send(
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "startup-preauth", ts: Date.now() },
          }),
        );
      },
    ));

  it("rejects oversized pre-auth connect frames before application-level auth responses", async () => {
    resetDiagnosticEventsForTest();
    const events: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onDiagnosticEvent((event) => events.push(event));
    try {
      await withGateway(async (harness) => {
        const ws = await harness.openWs();
        await readConnectChallengeNonce(ws);
        const closed = once(ws, "close");
        ws.send(
          JSON.stringify({
            type: "req",
            id: "oversized-connect",
            method: "connect",
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              client: { id: "test", version: "1.0.0", platform: "test", mode: "test" },
              pathEnv: "A".repeat(MAX_PREAUTH_PAYLOAD_BYTES + 1024),
              role: "operator",
            },
          }),
        );
        await expect(closed.then(([code]) => code)).resolves.toBe(1009);
        expect(events.find((event) => event.type === "payload.large")).toMatchObject({
          type: "payload.large",
          surface: "gateway.ws.preauth",
          action: "rejected",
          limitBytes: MAX_PREAUTH_PAYLOAD_BYTES,
          reason: "preauth_frame_limit",
        });
      });
    } finally {
      stopDiagnostics();
      resetDiagnosticEventsForTest();
    }
  });

  it("rejects excess simultaneous unauthenticated sockets when trusted proxy headers are missing", async () => {
    const env = captureEnv(["OPENCLAW_TEST_MAX_PREAUTH_CONNECTIONS_PER_IP"]);
    const previousAuth = testState.gatewayAuth;
    setTestEnvValue("OPENCLAW_TEST_MAX_PREAUTH_CONNECTIONS_PER_IP", "1");
    testState.gatewayAuth = { mode: "none" };
    try {
      await withTempConfig({
        cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
        prefix: "openclaw-preauth-proxy-",
        run: async () =>
          withGateway(async (harness) => {
            const firstWs = await harness.openWs();
            await readConnectChallengeNonce(firstWs);
            await expectUnavailable(harness.port, "Too many unauthenticated sockets");
            firstWs.close();
          }),
      });
    } finally {
      env.restore();
      testState.gatewayAuth = previousAuth;
    }
  });
});
