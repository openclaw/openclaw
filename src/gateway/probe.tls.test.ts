import { X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { WebSocketServer } from "../../packages/gateway-client/src/websocket.test-support.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { waitForGatewayReachable } from "../commands/onboard-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `wss://127.0.0.1:${(server.address() as AddressInfo).port}`,
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

let gateway: Awaited<ReturnType<typeof startTlsProbeGateway>>;
beforeAll(async () => {
  gateway = await startTlsProbeGateway();
});
afterAll(async () => {
  await gateway[Symbol.asyncDispose]();
});
afterEach(resetSecretRedactionRegistryForTest);

it.each([
  ["saved pin", wrongPin, undefined, true, false, /fingerprint mismatch/i],
  ["explicit pin", correctPin, wrongPin, true, false, /fingerprint mismatch/i],
  ["matching pin", correctPin, undefined, true, false, null],
  ["CA validation", undefined, undefined, true, false, /certificate|self.signed/i],
  ["malformed saved pin", "invalid", undefined, false, false, /SHA-256 fingerprint/],
  ["changed endpoint", fingerprint, undefined, false, true, /certificate/],
  ["explicit pin override", wrongPin, fingerprint, false, false, null],
] as const)(
  "validates %s before sending Gateway credentials",
  async (_name, savedPin, explicitPin, bootstrap, changed, error) => {
    await withTestDir({ prefix: "openclaw-probe-tls-" }, async (stateDir) => {
      const url = `${gateway.url}/gateway`;
      const expectTransport = gateway.observeTransport();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const config = remoteConfig(
        changed ? `${url}/other` : ` ${url} `,
        savedPin,
        "test-probe-token",
      );
      const connection = bootstrap
        ? await resolveGatewayClientBootstrap({
            config,
            authPolicy: "probe",
            explicitTlsFingerprint: explicitPin,
            env,
          })
        : { url, auth: { token: "test-probe-token" }, tlsFingerprint: explicitPin };
      if (bootstrap) {
        expect(connection.tlsFingerprint).toBe(explicitPin ?? savedPin);
      }
      const result = await probeGateway({
        ...connection,
        config,
        timeoutMs: 2_000,
        detailLevel: "none",
        env,
      });
      await gateway.drain();
      if (error) {
        expect(result).toMatchObject({ ok: false, connectLatencyMs: null });
        expect(result.error).toMatch(error);
      } else {
        expect(result).toMatchObject({ ok: true, error: null });
      }
      expectTransport(error === null);
    });
  },
);

it("retains saved TLS trust through the health readiness polling path", async () => {
  await withTestDir({ prefix: "openclaw-probe-tls-" }, async (stateDir) => {
    const url = `${gateway.url}/gateway`;
    const before = gateway.observed.connectFrames;
    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
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
