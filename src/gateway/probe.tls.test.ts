import { X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "../../packages/gateway-client/src/websocket.test-support.js";
import * as httpFixtures from "../../test/helpers/gateway-integration-fixtures.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { waitForGatewayReachable } from "../commands/onboard-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createSuiteTempRootTracker, withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "./minimal-gateway.test-helpers.js";
import { probeGateway } from "./probe.js";

const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
const correctPin = fingerprint.replaceAll(":", "").toLowerCase();
const wrongPin = "00".repeat(32);
const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-probe-tls-" });
const edgeAuthValue = "synthetic-probe-edge-auth";

function remoteConfig(url: string, tlsFingerprint?: string, token?: string): OpenClawConfig {
  return {
    gateway: {
      mode: "remote",
      remote: { url, token, tlsFingerprint, edgeAuth: { "X-Test-Edge-Auth": edgeAuthValue } },
    },
  };
}

async function startTlsProbeGateway() {
  const server = createServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
  const wss = new WebSocketServer({ server });
  const sockets = new Set<Socket>();
  const closedSockets: Promise<void>[] = [];
  const observed = { receivedBytes: 0, edgeAuthHeaders: [] as unknown[], connectFrames: 0 };
  const hello = buildMinimalGatewayHelloOkPayload({
    auth: { role: "operator", scopes: ["operator.read"] },
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    closedSockets.push(
      new Promise<void>((resolve) => {
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        });
      }),
    );
  });
  server.on("secureConnection", (socket) =>
    socket.on("data", (chunk: Buffer) => {
      observed.receivedBytes += chunk.byteLength;
    }),
  );
  wss.on("connection", (ws, request) => {
    observed.edgeAuthHeaders.push(request.headers["x-test-edge-auth"]);
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (raw) => {
      const frame = parseMinimalGatewayRequestFrame(raw);
      if (frame.type !== "req" || frame.method !== "connect" || !frame.id) {
        return;
      }
      observed.connectFrames += 1;
      sendMinimalGatewayResponse(ws, frame.id, hello);
    });
  });
  const url = await httpFixtures.listenLoopback(server, "wss");
  return {
    url,
    observed,
    observeTransport: () => {
      const { receivedBytes, connectFrames } = observed;
      const headerCount = observed.edgeAuthHeaders.length;
      return (ok: boolean) => {
        if (ok) {
          expect(observed.receivedBytes).toBeGreaterThan(receivedBytes);
          expect(observed.edgeAuthHeaders.slice(headerCount)).toEqual([edgeAuthValue]);
        } else {
          expect.soft(observed.receivedBytes - receivedBytes).toBe(0);
          expect.soft(observed.edgeAuthHeaders.slice(headerCount)).toEqual([]);
        }
        expect(observed.connectFrames - connectFrames).toBe(ok ? 1 : 0);
      };
    },
    drain: async () => Promise.all(closedSockets),
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeMinimalGatewayServer(wss);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

afterEach(resetSecretRedactionRegistryForTest);

it.each([
  { name: "saved pin", savedPin: wrongPin, explicitPin: undefined, outcome: "mismatch" },
  { name: "explicit pin", savedPin: correctPin, explicitPin: wrongPin, outcome: "mismatch" },
  { name: "matching pin", savedPin: correctPin, explicitPin: undefined, outcome: "connected" },
  { name: "CA validation", savedPin: undefined, explicitPin: undefined, outcome: "untrusted" },
])("validates $name before upgrade", async ({ savedPin, explicitPin, outcome }) => {
  await withTestDir({ prefix: "openclaw-probe-tls-" }, async (stateDir) => {
    await using gateway = await startTlsProbeGateway();
    const expectTransport = gateway.observeTransport();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const config = remoteConfig(gateway.url, savedPin, "synthetic-probe-token");
    const bootstrap = await resolveGatewayClientBootstrap({
      config,
      authPolicy: "probe",
      explicitTlsFingerprint: explicitPin,
      env,
    });
    expect(bootstrap.tlsFingerprint).toBe(explicitPin ?? savedPin);
    const result = await probeGateway({
      url: bootstrap.url,
      auth: bootstrap.auth,
      tlsFingerprint: bootstrap.tlsFingerprint,
      config,
      timeoutMs: 2_000,
      includeDetails: false,
      env,
    });
    await gateway.drain();

    if (outcome === "connected") {
      expect(result).toMatchObject({ ok: true, error: null });
      expectTransport(true);
      return;
    }
    expect(result).toMatchObject({ ok: false, connectLatencyMs: null });
    expect(result.error).toMatch(
      outcome === "mismatch" ? /fingerprint mismatch/i : /certificate|self.signed/i,
    );
    expectTransport(false);
  });
});

describe("Gateway probe TLS trust", () => {
  let gateway: Awaited<ReturnType<typeof startTlsProbeGateway>>;
  let url: string;

  beforeAll(async () => {
    await tempDirs.setup();
    gateway = await startTlsProbeGateway();
    url = `${gateway.url}/gateway`;
  });

  afterAll(async () => {
    await gateway[Symbol.asyncDispose]();
    await tempDirs.cleanup();
  });

  it.each([
    ["malformed saved pin", "invalid", undefined, false, false, "SHA-256 fingerprint"],
    ["changed endpoint", fingerprint, undefined, true, false, "certificate"],
    ["explicit pin override", wrongPin, fingerprint, false, true, undefined],
  ] as const)(
    "enforces %s before sending Gateway credentials",
    async (_name, savedPin, explicitPin, changed, ok, error) => {
      const expectTransport = gateway.observeTransport();
      const result = await probeGateway({
        url,
        config: remoteConfig(changed ? `${url}/other` : ` ${url} `, savedPin),
        tlsFingerprint: explicitPin,
        auth: { token: "test-probe-token" },
        timeoutMs: 2_000,
        detailLevel: "none",
        env: { OPENCLAW_STATE_DIR: await tempDirs.make("state") },
      });

      await gateway.drain();

      expect(result.ok, result.error ?? undefined).toBe(ok);
      expectTransport(ok);
      if (error) {
        expect(result.error).toContain(error);
      }
    },
  );

  it("retains saved TLS trust through the health readiness polling path", async () => {
    const before = gateway.observed.connectFrames;
    const result = await withEnvAsync(
      { OPENCLAW_STATE_DIR: await tempDirs.make("polling-state") },
      () =>
        waitForGatewayReachable({
          url,
          config: { gateway: { mode: "remote", remote: { url, tlsFingerprint: fingerprint } } },
          token: "test-probe-token",
          deadlineMs: 2_000,
          probeTimeoutMs: 2_000,
        }),
    );
    expect(result).toEqual({ ok: true });
    await gateway.drain();
    expect(gateway.observed.connectFrames - before).toBe(1);
  });
});
