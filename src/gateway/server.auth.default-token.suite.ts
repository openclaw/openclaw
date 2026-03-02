import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  connectReq,
  ConnectErrorDetailCodes,
  createSignedDevice,
  expectHelloOkServerVersion,
  getFreePort,
  getHandshakeTimeoutMs,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  NODE_CLIENT,
  onceMessage,
  openWs,
  PROTOCOL_VERSION,
  readConnectChallengeNonce,
  resolveGatewayTokenOrEnv,
  rpcReq,
  sendRawConnectReq,
  startGatewayServer,
  TEST_OPERATOR_CLIENT,
  waitForWsClose,
  withRuntimeVersionEnv,
} from "./server.auth.shared.js";

export function registerDefaultAuthTokenSuite(): void {
  describe("default auth (token)", () => {
    let server: Awaited<ReturnType<typeof startGatewayServer>>;
    let port: number;

    beforeAll(async () => {
      port = await getFreePort();
      server = await startGatewayServer(port);
    });

    afterAll(async () => {
      await server.close();
    });

    test("closes silent handshakes after timeout", async () => {
      vi.useRealTimers();
      const prevHandshakeTimeout = process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
      process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS = "20";
      try {
        const ws = await openWs(port);
        const handshakeTimeoutMs = getHandshakeTimeoutMs();
        const closed = await waitForWsClose(ws, handshakeTimeoutMs + 500);
        expect(closed).toBe(true);
      } finally {
        if (prevHandshakeTimeout === undefined) {
          delete process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
        } else {
          process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS = prevHandshakeTimeout;
        }
      }
    });

    test("connect (req) handshake returns hello-ok payload", async () => {
      const { CONFIG_PATH, STATE_DIR } = await import("../config/config.js");
      const ws = await openWs(port);

      const res = await connectReq(ws);
      expect(res.ok).toBe(true);
      const payload = res.payload as
        | {
            type?: unknown;
            snapshot?: { configPath?: string; stateDir?: string };
          }
        | undefined;
      expect(payload?.type).toBe("hello-ok");
      expect(payload?.snapshot?.configPath).toBe(CONFIG_PATH);
      expect(payload?.snapshot?.stateDir).toBe(STATE_DIR);

      ws.close();
    });

    test("connect (req) handshake resolves server version from env precedence", async () => {
      for (const testCase of [
        {
          env: {
            OPENCLAW_VERSION: " ",
            OPENCLAW_SERVICE_VERSION: "2.4.6-service",
            npm_package_version: "1.0.0-package",
          },
          expectedVersion: "2.4.6-service",
        },
        {
          env: {
            OPENCLAW_VERSION: "9.9.9-cli",
            OPENCLAW_SERVICE_VERSION: "2.4.6-service",
            npm_package_version: "1.0.0-package",
          },
          expectedVersion: "9.9.9-cli",
        },
        {
          env: {
            OPENCLAW_VERSION: " ",
            OPENCLAW_SERVICE_VERSION: "\t",
            npm_package_version: "1.0.0-package",
          },
          expectedVersion: "1.0.0-package",
        },
      ]) {
        await withRuntimeVersionEnv(testCase.env, async () =>
          expectHelloOkServerVersion(port, testCase.expectedVersion),
        );
      }
    });

    test("device-less auth matrix", async () => {
      const token = resolveGatewayTokenOrEnv();
      const matrix: Array<{
        name: string;
        opts: Parameters<typeof connectReq>[1];
        expectConnectOk: boolean;
        expectConnectError?: string;
        expectStatusOk?: boolean;
        expectStatusError?: string;
      }> = [
        {
          name: "operator + valid shared token => connected with preserved scopes",
          opts: { role: "operator", token, device: null },
          expectConnectOk: true,
          expectStatusOk: true,
        },
        {
          name: "node + valid shared token => rejected without device",
          opts: { role: "node", token, device: null, client: NODE_CLIENT },
          expectConnectOk: false,
          expectConnectError: "device identity required",
        },
        {
          name: "operator + invalid shared token => unauthorized",
          opts: { role: "operator", token: "wrong", device: null },
          expectConnectOk: false,
          expectConnectError: "unauthorized",
        },
      ];

      for (const scenario of matrix) {
        const ws = await openWs(port);
        try {
          const res = await connectReq(ws, scenario.opts);
          expect(res.ok, scenario.name).toBe(scenario.expectConnectOk);
          if (!scenario.expectConnectOk) {
            expect(res.error?.message ?? "", scenario.name).toContain(
              String(scenario.expectConnectError ?? ""),
            );
            continue;
          }
          if (scenario.expectStatusOk !== undefined) {
            const status = await rpcReq(ws, "status");
            expect(status.ok, scenario.name).toBe(scenario.expectStatusOk);
            if (!scenario.expectStatusOk && scenario.expectStatusError) {
              expect(status.error?.message ?? "", scenario.name).toContain(
                scenario.expectStatusError,
              );
            }
          }
        } finally {
          ws.close();
        }
      }
    });

    test("keeps health available but admin status restricted when scopes are empty", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, { scopes: [] });
        expect(res.ok).toBe(true);
        const status = await rpcReq(ws, "status");
        expect(status.ok).toBe(false);
        expect(status.error?.message).toContain("missing scope");
        const health = await rpcReq(ws, "health");
        expect(health.ok).toBe(true);
      } finally {
        ws.close();
      }
    });

    test("does not grant admin when scopes are omitted", async () => {
      const ws = await openWs(port);
      const token = resolveGatewayTokenOrEnv();
      const nonce = await readConnectChallengeNonce(ws);

      const { randomUUID } = await import("node:crypto");
      const os = await import("node:os");
      const path = await import("node:path");
      // Fresh identity: avoid leaking prior scopes (presence merges lists).
      const { identity, device } = await createSignedDevice({
        token,
        scopes: [],
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
        identityPath: path.join(os.tmpdir(), `openclaw-test-device-${randomUUID()}.json`),
        nonce,
      });

      const connectRes = await sendRawConnectReq(ws, {
        id: "c-no-scopes",
        token,
        device,
      });
      expect(connectRes.ok).toBe(true);
      const helloOk = connectRes.payload as
        | {
            snapshot?: {
              presence?: Array<{ deviceId?: unknown; scopes?: unknown }>;
            };
          }
        | undefined;
      const presence = helloOk?.snapshot?.presence;
      expect(Array.isArray(presence)).toBe(true);
      const mine = presence?.find((entry) => entry.deviceId === identity.deviceId);
      expect(mine).toBeTruthy();
      const presenceScopes = Array.isArray(mine?.scopes) ? mine?.scopes : [];
      expect(presenceScopes).toEqual([]);
      expect(presenceScopes).not.toContain("operator.admin");

      const status = await rpcReq(ws, "status");
      expect(status.ok).toBe(false);
      expect(status.error?.message).toContain("missing scope");
      const health = await rpcReq(ws, "health");
      expect(health.ok).toBe(true);

      ws.close();
    });

    test("rejects device signature when scopes are omitted but signed with admin", async () => {
      const ws = await openWs(port);
      const token = resolveGatewayTokenOrEnv();
      const nonce = await readConnectChallengeNonce(ws);

      const { device } = await createSignedDevice({
        token,
        scopes: ["operator.admin"],
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
        nonce,
      });

      const connectRes = await sendRawConnectReq(ws, {
        id: "c-no-scopes-signed-admin",
        token,
        device,
      });
      expect(connectRes.ok).toBe(false);
      expect(connectRes.error?.message ?? "").toContain("device signature invalid");
      expect(connectRes.error?.details?.code).toBe(
        ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_INVALID,
      );
      expect(connectRes.error?.details?.reason).toBe("device-signature");
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    test("sends connect challenge on open", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const evtPromise = onceMessage<{
        type?: string;
        event?: string;
        payload?: Record<string, unknown> | null;
      }>(ws, (o) => o.type === "event" && o.event === "connect.challenge");
      await new Promise<void>((resolve) => ws.once("open", resolve));
      const evt = await evtPromise;
      const nonce = (evt.payload as { nonce?: unknown } | undefined)?.nonce;
      expect(typeof nonce).toBe("string");
      ws.close();
    });

    test("rejects protocol mismatch", async () => {
      const ws = await openWs(port);
      try {
        const res = await connectReq(ws, {
          minProtocol: PROTOCOL_VERSION + 1,
          maxProtocol: PROTOCOL_VERSION + 2,
        });
        expect(res.ok).toBe(false);
      } catch {
        // If the server closed before we saw the frame, that's acceptable.
      }
      ws.close();
    });

    test("rejects non-connect first request", async () => {
      const ws = await openWs(port);
      ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
      const res = await onceMessage<{ type?: string; id?: string; ok?: boolean; error?: unknown }>(
        ws,
        (o) => o.type === "res" && o.id === "h1",
      );
      expect(res.ok).toBe(false);
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    test("requires nonce for device auth", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { host: "example.com" },
      });
      await new Promise<void>((resolve) => ws.once("open", resolve));

      const { device } = await createSignedDevice({
        token: "secret",
        scopes: ["operator.admin"],
        clientId: TEST_OPERATOR_CLIENT.id,
        clientMode: TEST_OPERATOR_CLIENT.mode,
        nonce: "nonce-not-sent",
      });
      const { nonce: _nonce, ...deviceWithoutNonce } = device;
      const res = await connectReq(ws, {
        token: "secret",
        device: deviceWithoutNonce,
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("must have required property 'nonce'");
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    test("returns nonce-required detail code when nonce is blank", async () => {
      const ws = await openWs(port);
      const token = resolveGatewayTokenOrEnv();
      const nonce = await readConnectChallengeNonce(ws);
      const { device } = await createSignedDevice({
        token,
        scopes: ["operator.admin"],
        clientId: TEST_OPERATOR_CLIENT.id,
        clientMode: TEST_OPERATOR_CLIENT.mode,
        nonce,
      });

      const connectRes = await sendRawConnectReq(ws, {
        id: "c-blank-nonce",
        token,
        device: { ...device, nonce: "   " },
      });
      expect(connectRes.ok).toBe(false);
      expect(connectRes.error?.message ?? "").toContain("device nonce required");
      expect(connectRes.error?.details?.code).toBe(
        ConnectErrorDetailCodes.DEVICE_AUTH_NONCE_REQUIRED,
      );
      expect(connectRes.error?.details?.reason).toBe("device-nonce-missing");
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    test("returns nonce-mismatch detail code when nonce does not match challenge", async () => {
      const ws = await openWs(port);
      const token = resolveGatewayTokenOrEnv();
      const nonce = await readConnectChallengeNonce(ws);
      const { device } = await createSignedDevice({
        token,
        scopes: ["operator.admin"],
        clientId: TEST_OPERATOR_CLIENT.id,
        clientMode: TEST_OPERATOR_CLIENT.mode,
        nonce,
      });

      const connectRes = await sendRawConnectReq(ws, {
        id: "c-wrong-nonce",
        token,
        device: { ...device, nonce: `${nonce}-stale` },
      });
      expect(connectRes.ok).toBe(false);
      expect(connectRes.error?.message ?? "").toContain("device nonce mismatch");
      expect(connectRes.error?.details?.code).toBe(
        ConnectErrorDetailCodes.DEVICE_AUTH_NONCE_MISMATCH,
      );
      expect(connectRes.error?.details?.reason).toBe("device-nonce-mismatch");
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    });

    test("invalid connect params surface in response and close reason", async () => {
      const ws = await openWs(port);
      const closeInfoPromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      ws.send(
        JSON.stringify({
          type: "req",
          id: "h-bad",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "bad-client",
              version: "dev",
              platform: "web",
              mode: "webchat",
            },
            device: {
              id: 123,
              publicKey: "bad",
              signature: "bad",
              signedAt: "bad",
            },
          },
        }),
      );

      const res = await onceMessage<{
        ok: boolean;
        error?: { message?: string };
      }>(
        ws,
        (o) => (o as { type?: string }).type === "res" && (o as { id?: string }).id === "h-bad",
      );
      expect(res.ok).toBe(false);
      expect(String(res.error?.message ?? "")).toContain("invalid connect params");

      const closeInfo = await closeInfoPromise;
      expect(closeInfo.code).toBe(1008);
      expect(closeInfo.reason).toContain("invalid connect params");
    });
  });
}
