import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import http2 from "node:http2";
import net from "node:net";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { verifyDeviceSignature } from "./device-identity.js";
import { startProxy, stopProxy, type ProxyHandle } from "./net/proxy/proxy-lifecycle.js";
import {
  appendApnsResponseBodyCapture,
  createApnsResponseBodyCapture,
  getApnsResponseBodyCaptureText,
} from "./push-apns-http2.js";
import type { RelayApnsRegistration } from "./push-apns-store.js";
import {
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  sendApnsBackgroundWake,
  sendApnsExecApprovalAlert,
  sendApnsExecApprovalResolvedWake,
  sendApnsPluginApprovalAlert,
  sendApnsPluginApprovalResolvedWake,
  shouldClearStoredApnsRegistration,
} from "./push-apns.js";
import { mockApnsRelayFetch, mockApnsRelayIdentity } from "./push-apns.relay.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const testAuthPrivateKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
}).privateKey.export({
  format: "pem",
  type: "pkcs8",
});

function createDirectApnsSendFixture(
  nodeId: string,
  environment: "sandbox" | "production" = "sandbox",
  sendResult = { status: 200, apnsId: "test-apns-id", body: "" },
) {
  const send = vi.fn().mockResolvedValue(sendResult);
  return {
    send,
    requestSender: send,
    nodeId,
    registration: {
      nodeId,
      transport: "direct" as const,
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment,
      updatedAtMs: 1,
    },
    auth: { teamId: "TEAM123", keyId: "KEY123", privateKey: testAuthPrivateKey },
  };
}

function relayRegistration(
  nodeId: string,
  overrides: Partial<RelayApnsRegistration> = {},
): RelayApnsRegistration {
  return {
    nodeId,
    transport: "relay",
    relayHandle: "relay-handle-12345678",
    sendGrant: "send-grant-123",
    installationId: "install-123",
    topic: "ai.openclaw.ios",
    environment: "production",
    distribution: "official",
    updatedAtMs: 1,
    ...overrides,
  };
}

function createRelayApnsSendFixture(params: {
  nodeId: string;
  relayHandle?: string;
  tokenDebugSuffix?: string;
  environment?: "sandbox" | "production";
  sendResult: {
    ok: boolean;
    status: number;
    environment: "sandbox" | "production";
    apnsId?: string;
    reason?: string;
    tokenSuffix?: string;
  };
}) {
  return {
    send: mockApnsRelayFetch(params.sendResult),
    registration: relayRegistration(params.nodeId, {
      relayHandle: params.relayHandle ?? "relay-handle-12345678",
      environment: params.environment ?? "production",
      tokenDebugSuffix: params.tokenDebugSuffix,
    }),
    relayConfig: { baseUrl: "https://relay.openclaw.test", timeoutMs: 2_500 },
  };
}

type CapturedApnsRequest = {
  headers: http2.IncomingHttpHeaders;
  body: string;
};

type DestroyableConnection = {
  destroy: () => void;
};

function listen(server: HttpServer | http2.Http2SecureServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server address unavailable"));
        return;
      }
      resolve(address.port);
    });
  });
}

const closeServer = (server: HttpServer | http2.Http2SecureServer) =>
  new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });

const requireRecord = createRequireRecord("object", "label-not-object");

function expectNoProperties(record: unknown, keys: string[]) {
  for (const key of keys) {
    expect(record).not.toHaveProperty(key);
  }
}

function requireSendRequest(send: ReturnType<typeof vi.fn>, label = "APNs send request") {
  expect(send).toHaveBeenCalledTimes(1);
  return requireRecord(send.mock.calls[0]?.[0], label);
}

function requirePayload(sendRequest: Record<string, unknown>) {
  return requireRecord(sendRequest.payload, "APNs payload");
}

function expectOpenClaw(payload: Record<string, unknown>, fields: Record<string, unknown>) {
  expect(payload.openclaw).toMatchObject({ ...fields, ts: expect.any(Number) });
  return payload.openclaw;
}

async function withProxiedApns(
  response: Parameters<typeof startFakeApnsServer>[0],
  check: (
    server: Awaited<ReturnType<typeof startFakeApnsServer>>,
    proxy: Awaited<ReturnType<typeof startConnectProxy>>,
  ) => Promise<void>,
) {
  const server = await startFakeApnsServer(response);
  const proxy = await startConnectProxy(server.port);
  let handle: ProxyHandle | null | undefined;
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    handle = await startProxy({ proxyUrl: proxy.proxyUrl });
    await check(server, proxy);
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
    await stopProxy(handle ?? null);
    await proxy.stop();
    await server.stop();
  }
}

async function startFakeApnsServer(params?: { responseBody?: string; status?: number }) {
  const requests: CapturedApnsRequest[] = [];
  const responseBody = params?.responseBody ?? "";
  const status = params?.status ?? 200;
  const server = http2.createSecureServer({
    key: TEST_TLS_KEY_PEM,
    cert: TEST_TLS_CERT_PEM,
    allowHTTP1: false,
  });
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += typeof chunk === "string" ? chunk : String(chunk);
    });
    stream.on("end", () => {
      requests.push({ headers, body });
      stream.respond({ ":status": status, "apns-id": "proxied-apns-id" });
      stream.end(responseBody);
    });
  });
  const port = await listen(server);
  return {
    port,
    requests,
    stop: async () => await closeServer(server),
  };
}

async function startConnectProxy(upstreamPort: number) {
  const connectTargets: string[] = [];
  const sockets = new Set<DestroyableConnection>();
  const server = createServer((_req, res) => {
    res.writeHead(502);
    res.end("CONNECT required");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, clientSocket, head) => {
    connectTargets.push(req.url ?? "");
    const upstreamSocket = net.connect(upstreamPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    sockets.add(clientSocket);
    sockets.add(upstreamSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    upstreamSocket.on("close", () => sockets.delete(upstreamSocket));
    clientSocket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => clientSocket.destroy());
  });
  const port = await listen(server);
  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    connectTargets,
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    },
  };
}

describe("push APNs send semantics", () => {
  it("bounds APNs response body capture", () => {
    const capture = createApnsResponseBodyCapture();

    appendApnsResponseBodyCapture(capture, "abc", 5);
    appendApnsResponseBodyCapture(capture, "def", 5);

    expect(getApnsResponseBodyCaptureText(capture)).toBe("abcde");
    expect(capture).toMatchObject({ capturedBytes: 5, truncated: true });
  });

  it("preserves UTF-8 across HTTP/2 chunks and drops an incomplete capped suffix", () => {
    const splitCapture = createApnsResponseBodyCapture();
    const emoji = Buffer.from("🚀");
    appendApnsResponseBodyCapture(splitCapture, Buffer.from("before "));
    appendApnsResponseBodyCapture(splitCapture, emoji.subarray(0, 2));
    appendApnsResponseBodyCapture(splitCapture, emoji.subarray(2));
    appendApnsResponseBodyCapture(splitCapture, Buffer.from(" after"));
    expect(getApnsResponseBodyCaptureText(splitCapture)).toBe("before 🚀 after");

    const cappedCapture = createApnsResponseBodyCapture();
    const cappedPrefix = "a".repeat(8191);
    appendApnsResponseBodyCapture(cappedCapture, Buffer.from(`${cappedPrefix}🚀`));
    expect(getApnsResponseBodyCaptureText(cappedCapture)).toBe(cappedPrefix);
    expect(cappedCapture).toMatchObject({ capturedBytes: 8192, truncated: true });
  });

  it("preserves replacement decoding for a complete malformed APNs response", () => {
    const capture = createApnsResponseBodyCapture();
    appendApnsResponseBodyCapture(capture, Buffer.from([0x61, 0xf0, 0x9f]));

    expect(getApnsResponseBodyCaptureText(capture)).toBe("a�");
    expect(capture).toMatchObject({ capturedBytes: 3, truncated: false });
  });

  it.each([
    [200, "", true, undefined],
    [400, '{"reason":"BadDeviceToken"}' + " ".repeat(20_000), false, "BadDeviceToken"],
  ] as const)(
    "sends through the managed proxy and bounds HTTP %s bodies",
    async (status, responseBody, ok, reason) => {
      await withProxiedApns({ status, responseBody }, async (apnsServer, proxy) => {
        const { registration, auth } = createDirectApnsSendFixture("ios-node-proxied-alert");

        const result = await sendApnsAlert({
          registration,
          nodeId: "ios-node-proxied-alert",
          title: "Wake",
          body: "Ping",
          auth,
          timeoutMs: 2_500,
        });

        expect(result).toMatchObject({
          ok,
          status,
          reason,
          apnsId: "proxied-apns-id",
          transport: "direct",
        });
        expect(proxy.connectTargets).toEqual(["api.sandbox.push.apple.com:443"]);
        expect(apnsServer.requests).toHaveLength(1);
        const request = apnsServer.requests[0];
        expect(request?.headers).toMatchObject({
          ":method": "POST",
          ":path": "/3/device/abcd1234abcd1234abcd1234abcd1234",
          "apns-topic": "ai.openclaw.ios",
          "apns-push-type": "alert",
          "apns-priority": "10",
        });
        const payload = requireRecord(JSON.parse(request?.body ?? "null"), "APNs payload");
        expect(payload.aps).toEqual({
          alert: { title: "Wake", body: "Ping" },
          sound: "default",
        });
        expectOpenClaw(payload, {
          kind: "push.test",
          nodeId: "ios-node-proxied-alert",
        });
      });
    },
  );

  it("owns direct session errors while persistent currentness is pending", async () => {
    const session = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      destroy: vi.fn(),
      request: vi.fn(),
    });
    session.destroy.mockImplementation(() => session.emit("close"));
    const connect = vi
      .spyOn(http2, "connect")
      .mockReturnValue(session as unknown as http2.ClientHttp2Session);
    const currentness = createDeferred<boolean>();
    const checkingCurrentness = createDeferred();
    const isCurrent = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => {
        checkingCurrentness.resolve();
        return currentness.promise;
      });
    const { registration, auth } = createDirectApnsSendFixture(
      "ios-node-session-error",
      "production",
    );

    try {
      const sending = sendApnsBackgroundWake({
        registration,
        auth,
        nodeId: "ios-node-session-error",
        wakeReason: "node.invoke",
        isCurrent,
      });
      await withTestTimeout(
        checkingCurrentness.promise,
        1_000,
        "APNs persistent currentness check did not start",
      );
      expect(connect).toHaveBeenCalledTimes(1);
      expect(isCurrent).toHaveBeenCalledTimes(2);

      expect(session.listenerCount("error")).toBeGreaterThan(0);
      session.emit("error", new Error("APNs connection failed"));
      currentness.resolve(true);

      await expect(sending).rejects.toThrow("APNs connection failed");
      expect(session.destroy).toHaveBeenCalledTimes(1);
      expect(session.request).not.toHaveBeenCalled();
    } finally {
      currentness.resolve(false);
      connect.mockRestore();
    }
  });

  it.each([
    {
      name: "exec approval alert with generic modal-only metadata",
      invoke: sendApnsExecApprovalAlert,
      kind: "exec.approval.requested",
      pushType: "alert",
      aps: {
        alert: { title: "Exec approval required", body: "Open OpenClaw to review this request." },
        sound: "default",
        category: "openclaw.exec-approval",
        "content-available": 1,
      },
      forbidden: ["host", "nodeId", "agentId", "commandText", "allowedDecisions", "expiresAtMs"],
    },
    {
      name: "silent exec approval cleanup with a capped timeout",
      invoke: sendApnsExecApprovalResolvedWake,
      kind: "exec.approval.resolved",
      pushType: "background",
      aps: { "content-available": 1 },
      timeoutMs: Number.MAX_SAFE_INTEGER,
      sendResult: { status: 200, apnsId: "apns-timeout-cap-id", body: "{}" },
    },
    {
      name: "plugin approval alert with bounded request copy",
      invoke: (params: Parameters<typeof sendApnsExecApprovalAlert>[0]) =>
        sendApnsPluginApprovalAlert({
          ...params,
          title: "Install plugin update",
          description: `${"x".repeat(255)}😀${"y".repeat(300)}`,
        }),
      kind: "plugin.approval.requested",
      pushType: "alert",
      aps: {
        alert: { title: "Install plugin update", body: `${"x".repeat(255)}…` },
        sound: "default",
        category: "openclaw.plugin-approval",
        "content-available": 1,
      },
      forbidden: ["title", "description", "toolName", "agentId", "sessionKey"],
    },
    {
      name: "silent plugin approval cleanup",
      invoke: sendApnsPluginApprovalResolvedWake,
      kind: "plugin.approval.resolved",
      pushType: "background",
      aps: { "content-available": 1 },
    },
  ])("sends $name", async ({ invoke, kind, pushType, aps, forbidden, timeoutMs, sendResult }) => {
    const approvalId = "approval-123";
    const fixture = createDirectApnsSendFixture("ios-node-approval", "sandbox", sendResult);
    const result = await invoke({
      ...fixture,
      approvalId,
      gatewayDeviceId: "gateway-device-123",
      timeoutMs,
    });
    expect(fixture.send).toHaveBeenCalledTimes(1);
    const sent = requireSendRequest(fixture.send);
    expect(sent).toMatchObject({ pushType });
    if (timeoutMs !== undefined) {
      expect(sent.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    }
    const payload = requirePayload(sent);
    expect(payload.aps).toEqual(aps);
    const metadata = expectOpenClaw(payload, {
      kind,
      approvalId,
      gatewayDeviceId: "gateway-device-123",
    });
    expectNoProperties(metadata, forbidden ?? []);
    expect(result).toMatchObject({ ok: true, transport: "direct" });
  });

  it("falls back to the generic plugin approval title", async () => {
    const fixture = createDirectApnsSendFixture("ios-node-plugin-approval-fallback");
    const { send } = fixture;

    await sendApnsPluginApprovalAlert({
      ...fixture,
      approvalId: "plugin:fallback",
      gatewayDeviceId: "gateway-device-123",
      title: "   ",
      description: "Review this request.",
    });

    const aps = requireRecord(requirePayload(requireSendRequest(send)).aps, "APNs aps payload");
    expect(requireRecord(aps.alert, "APNs alert").title).toBe("Approval required");
  });

  it("fails closed before sending when direct registrations carry invalid topics", async () => {
    const fixture = createDirectApnsSendFixture("ios-node-invalid-topic");
    const { send } = fixture;

    await expect(
      sendApnsAlert({
        ...fixture,
        registration: { ...fixture.registration, topic: "   " },
        nodeId: "ios-node-invalid-topic",
        title: "Wake",
        body: "Ping",
      }),
    ).rejects.toThrow("topic required");

    expect(send).not.toHaveBeenCalled();
  });

  it("sends relay background pushes and falls back to the relay handle suffix", async () => {
    const { send, registration, relayConfig } = createRelayApnsSendFixture({
      nodeId: "ios-node-relay-wake",
      tokenDebugSuffix: undefined,
      sendResult: {
        ok: false,
        status: 429,
        reason: "TooManyRequests",
        environment: "production",
      },
    });

    const result = await sendApnsBackgroundWake({
      registration,
      nodeId: "ios-node-relay-wake",
      wakeReason: "queue.retry",
      relayConfig,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(`${relayConfig.baseUrl}/v1/push/send`);
    const request = send.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer send-grant-123");
    const body = request?.body;
    if (typeof body !== "string") {
      throw new Error("Expected relay JSON request body");
    }
    const sent = requireRecord(JSON.parse(body), "relay request");
    expect(sent).toMatchObject({
      relayHandle: "relay-handle-12345678",
      pushType: "background",
      priority: 5,
    });
    const payload = requirePayload(sent);
    expect(payload.aps).toEqual({ "content-available": 1 });
    expectOpenClaw(payload, {
      kind: "node.wake",
      reason: "queue.retry",
      nodeId: "ios-node-relay-wake",
    });
    expect(result).toMatchObject({
      ok: false,
      status: 429,
      reason: "TooManyRequests",
      tokenSuffix: "12345678",
      environment: "production",
      transport: "relay",
    });
  });

  it("keeps bounded non-JSON error reasons UTF-16 well-formed", async () => {
    const fixture = createDirectApnsSendFixture("ios-node-utf16-reason", "sandbox", {
      status: 400,
      apnsId: "apns-utf16-reason-id",
      body: `${"x".repeat(199)}🚀tail`,
    });

    const result = await sendApnsAlert({
      ...fixture,
      title: "Wake",
      body: "Ping",
    });

    expect(requireRecord(result, "APNs result").reason).toBe("x".repeat(199));
  });
});

describe("push APNs auth and helper coverage", () => {
  const tempDirs = createTrackedTempDirs();
  const authEnv = { OPENCLAW_APNS_TEAM_ID: "TEAM123", OPENCLAW_APNS_KEY_ID: "KEY123" };
  const rawKey = "-----BEGIN PRIVATE KEY-----\\nline-c\\nline-d\\n-----END PRIVATE KEY-----";
  const privateKey = "-----BEGIN PRIVATE KEY-----\nline-c\nline-d\n-----END PRIVATE KEY-----";
  afterEach(() => tempDirs.cleanup());

  it("normalizes APNs environment values", () => {
    expect(["sandbox", " PRODUCTION ", "staging", null].map(normalizeApnsEnvironment)).toEqual([
      "sandbox",
      "production",
      null,
      null,
    ]);
  });

  it.each(["inline fallback", "file"])(
    "reads %s private keys and normalizes escaped newlines",
    async (source) => {
      const env: NodeJS.ProcessEnv = { ...authEnv };
      if (source === "file") {
        const keyPath = path.join(
          await tempDirs.make("openclaw-push-apns-auth-test-"),
          "apns-key.p8",
        );
        await fs.writeFile(keyPath, rawKey + "\n", "utf8");
        env.OPENCLAW_APNS_PRIVATE_KEY_PATH = keyPath;
      } else {
        env.OPENCLAW_APNS_PRIVATE_KEY_P8 = "   ";
        env.OPENCLAW_APNS_PRIVATE_KEY = rawKey;
      }
      await expect(resolveApnsAuthConfigFromEnv(env)).resolves.toEqual({
        ok: true,
        value: { teamId: "TEAM123", keyId: "KEY123", privateKey },
      });
    },
  );

  it("reports missing auth fields and path read failures", async () => {
    const missingPath = path.join(
      await tempDirs.make("openclaw-push-apns-auth-test-"),
      "missing-key.p8",
    );
    await expect(resolveApnsAuthConfigFromEnv({})).resolves.toEqual({
      ok: false,
      error: "APNs auth missing: set OPENCLAW_APNS_TEAM_ID and OPENCLAW_APNS_KEY_ID",
    });
    await expect(
      resolveApnsAuthConfigFromEnv({ ...authEnv, OPENCLAW_APNS_PRIVATE_KEY_PATH: missingPath }),
    ).resolves.toEqual({
      ok: false,
      error: expect.stringContaining(
        `failed reading OPENCLAW_APNS_PRIVATE_KEY_PATH (${missingPath})`,
      ),
    });
  });

  it("clears only direct registrations without an environment override mismatch", () => {
    const direct = {
      registration: createDirectApnsSendFixture("ios-node-direct").registration,
      result: { status: 400, reason: "BadDeviceToken" },
    };
    expect(shouldClearStoredApnsRegistration(direct)).toBe(true);
    expect(
      shouldClearStoredApnsRegistration({ ...direct, overrideEnvironment: "production" }),
    ).toBe(false);
    const { registration } = createRelayApnsSendFixture({
      nodeId: "ios-node-relay",
      relayHandle: "relay-handle-123",
      sendResult: { ok: true, status: 200, environment: "production" },
    });
    expect(
      shouldClearStoredApnsRegistration({
        registration,
        result: { status: 410, reason: "Unregistered" },
      }),
    ).toBe(false);
  });
});

const senderOptionKeys = {
  direct: [
    "token",
    "topic",
    "environment",
    "bearerToken",
    "payload",
    "timeoutMs",
    "pushType",
    "priority",
  ],
};

function createApnsTransportFixture(transport: "direct" | "relay") {
  const fixture =
    transport === "direct"
      ? createDirectApnsSendFixture("ios-dispatch")
      : createRelayApnsSendFixture({
          nodeId: "ios-dispatch",
          environment: "sandbox",
          relayHandle: "relay-dispatch",
          sendResult: { ok: true, status: 202, environment: "sandbox" },
        });
  return { send: fixture.send, params: fixture };
}

describe("APNs dispatch", () => {
  it.each([
    ["direct", "alert"],
    ["direct", "background"],
    ["relay", "alert"],
    ["relay", "background"],
  ] as const)(
    "preserves %s %s lifecycle forwarding and option omission",
    async (transport, kind) => {
      const { send, params } = createApnsTransportFixture(transport);
      const controller = new AbortController();
      const isCurrent = vi.fn().mockResolvedValue(true);
      const sendPush = (controls: { signal?: AbortSignal; isCurrent?: () => Promise<boolean> }) => {
        const common = { ...params, nodeId: "ios-dispatch", timeoutMs: 2_700, ...controls };
        return kind === "alert"
          ? sendApnsAlert({ ...common, title: "Wake", body: "Ping" })
          : sendApnsBackgroundWake(common);
      };

      await sendPush({ signal: controller.signal, isCurrent });
      if (transport === "direct") {
        const controlled = requireSendRequest(send);
        expect(Object.keys(controlled)).toEqual([
          ...senderOptionKeys.direct,
          "signal",
          "isCurrent",
        ]);
        expect(controlled.signal).toBe(controller.signal);
        expect(controlled.isCurrent).toBe(isCurrent);
        expect(controlled.pushType).toBe(kind);
        expect(controlled.priority).toBe(kind === "alert" ? "10" : "5");
        if (kind === "background") {
          const payload = requirePayload(controlled);
          expect(payload.aps).toEqual({ "content-available": 1 });
          expectOpenClaw(payload, {
            kind: "node.wake",
            reason: "node.invoke",
            nodeId: "ios-dispatch",
          });
          await expect(sendPush({ isCurrent: vi.fn().mockResolvedValue(false) })).rejects.toThrow(
            "APNs send invalidated",
          );
          expect(send).toHaveBeenCalledTimes(1);
        }
      } else {
        expect(send).toHaveBeenCalledTimes(1);
        const [url, request] = send.mock.calls[0] ?? [];
        expect(url).toBe("https://relay.openclaw.test/v1/push/send");
        expect(request?.signal?.aborted).toBe(false);
        controller.abort();
        expect(request?.signal?.aborted).toBe(true);
        expect(new Headers(request?.headers).get("authorization")).toBe("Bearer send-grant-123");
        expect(JSON.parse(String(request?.body))).toMatchObject({
          relayHandle: "relay-dispatch",
          pushType: kind,
          priority: kind === "alert" ? 10 : 5,
        });
      }
      expect(isCurrent).toHaveBeenCalledTimes(transport === "direct" ? 1 : 2);

      send.mockClear();
      await sendPush({});
      if (transport === "direct") {
        expect(Object.keys(requireSendRequest(send))).toEqual(senderOptionKeys.direct);
      } else {
        expect(send).toHaveBeenCalledTimes(1);
      }
      expect(isCurrent).toHaveBeenCalledTimes(transport === "direct" ? 1 : 2);
    },
  );

  it.each(["direct", "relay"] as const)(
    "ignores extraneous lifecycle controls for %s approval notifications",
    async (transport) => {
      const { send, params } = createApnsTransportFixture(transport);
      const readControl = vi.fn(() => {
        throw new Error("approval notifications must not read lifecycle controls");
      });
      const approval = Object.defineProperties(
        {
          ...params,
          nodeId: "ios-dispatch",
          approvalId: "approval-dispatch",
          gatewayDeviceId: "gateway-dispatch",
          title: "Approval",
          description: "Review this request.",
          timeoutMs: 2_700,
        },
        {
          signal: { enumerable: true, get: readControl },
          isCurrent: { enumerable: true, get: readControl },
        },
      );

      for (const sendApproval of [
        sendApnsExecApprovalAlert,
        sendApnsPluginApprovalAlert,
        sendApnsExecApprovalResolvedWake,
        sendApnsPluginApprovalResolvedWake,
      ]) {
        send.mockClear();
        await sendApproval(approval);
        if (transport === "direct") {
          expect(Object.keys(requireSendRequest(send))).toEqual(senderOptionKeys.direct);
        } else {
          expect(send).toHaveBeenCalledTimes(1);
          expect(send.mock.calls[0]?.[0]).toBe("https://relay.openclaw.test/v1/push/send");
        }
      }
      expect(readControl).not.toHaveBeenCalled();
    },
  );
});

function sendRelayPush(
  overrides: Pick<Parameters<typeof sendApnsBackgroundWake>[0], "signal" | "isCurrent"> & {
    pushType?: "alert" | "background";
  } = {},
) {
  mockApnsRelayIdentity();
  const registration = relayRegistration("ios-relay", { installationId: "install-relay" });
  const params = {
    registration,
    nodeId: "ios-relay",
    relayConfig: {
      baseUrl: "https://relay.example.com",
      timeoutMs: 1000,
    },
    signal: overrides.signal,
    isCurrent: overrides.isCurrent,
  };
  return overrides.pushType === "alert"
    ? sendApnsAlert({ ...params, title: "Wake", body: "Ping" })
    : sendApnsBackgroundWake(params);
}

const relayResultFields = {
  ok: true,
  status: 200,
  apnsId: undefined,
  reason: undefined,
  tokenSuffix: "12345678",
  topic: "ai.openclaw.ios",
  environment: "production",
  transport: "relay",
};

function mockRelayResponse(body: BodyInit | null, status = 200) {
  const response = new Response(body, { status });
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return { response, fetchMock };
}

describe("push-apns.relay", () => {
  describe("resolveApnsRelayConfigFromEnv", () => {
    it("fails closed when relay registration origin is unknown and no relay URL is configured", () => {
      const resolved = resolveApnsRelayConfigFromEnv({});

      expect(resolved).toMatchObject({
        ok: false,
        error: expect.stringContaining("relay registrations without the hosted relay origin"),
      });
    });

    it.each([
      [
        " https://relay-override.example.com/base/ ",
        "999",
        1000,
        "https://relay-override.example.com/base",
      ],
      [
        "https://relay.example.com",
        String(Number.MAX_SAFE_INTEGER),
        MAX_TIMER_TIMEOUT_MS,
        "https://relay.example.com",
      ],
      ["https://relay.example.com", "2e4", 10_000, "https://relay.example.com"],
      ["https://relay.example.com", "   ", 2500, "https://relay.example.com"],
      ["http://[::1]:8787", "nope", 10_000, "http://[::1]:8787"],
    ] as const)("normalizes relay URL %s and timeout %s", (url, timeout, timeoutMs, baseUrl) => {
      expect(
        resolveApnsRelayConfigFromEnv(
          {
            OPENCLAW_APNS_RELAY_BASE_URL: url,
            OPENCLAW_APNS_RELAY_TIMEOUT_MS: timeout,
            OPENCLAW_APNS_RELAY_ALLOW_HTTP: "yes",
          },
          timeout === "999" || timeout === "   "
            ? {
                push: {
                  apns: { relay: { baseUrl: "https://configured.example.com", timeoutMs: 2500 } },
                },
              }
            : undefined,
        ),
      ).toMatchObject({ ok: true, value: { baseUrl, timeoutMs } });
    });

    it.each([
      ["ftp://relay.example.com", "unsupported protocol"],
      ["http://relay.example.com", "loopback hosts"],
      ["https://relay.example.com/path?debug=1", "query and fragment are not allowed"],
      ["https://user:pass@relay.example.com/path", "userinfo is not allowed"],
    ])("rejects invalid relay URL: %s", (url, expected) => {
      const env = {
        OPENCLAW_APNS_RELAY_BASE_URL: url,
        ...(url.startsWith("http:") ? { OPENCLAW_APNS_RELAY_ALLOW_HTTP: "true" } : {}),
      };
      expect(resolveApnsRelayConfigFromEnv(env)).toMatchObject({
        ok: false,
        error: expect.stringContaining(expected),
      });
    });
  });

  describe("public relay push", () => {
    it("does not start relay transport when persistent ownership changed", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(
        sendRelayPush({
          isCurrent: vi.fn().mockResolvedValue(false),
        }),
      ).rejects.toThrow("APNs send invalidated");

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("signs relay payloads in the HTTP request", async () => {
      vi.spyOn(Date, "now").mockReturnValue(123_456_789);
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const { fetchMock } = mockRelayResponse(
        JSON.stringify({
          ok: true,
          status: 200,
          apnsId: "relay-apns-id",
          environment: "production",
          tokenSuffix: "abcd1234",
        }),
      );

      const relayGatewayIdentity = mockApnsRelayIdentity();
      const result = await sendRelayPush({ pushType: "alert" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://relay.example.com/v1/push/send");
      expect(timeout).toHaveBeenCalledWith(1000);
      const fetchOptions = fetchMock.mock.calls[0]?.[1];
      const headers = new Headers(fetchOptions?.headers);
      const bodyJson = fetchOptions?.body;
      if (typeof bodyJson !== "string") {
        throw new Error("expected a serialized relay request body");
      }
      expect(headers.get("authorization")).toBe("Bearer send-grant-123");
      expect(headers.get("x-openclaw-gateway-device-id")).toBe(relayGatewayIdentity.deviceId);
      expect(headers.get("x-openclaw-gateway-signed-at-ms")).toBe("123456789");
      expect(bodyJson).toBe(
        JSON.stringify({
          relayHandle: "relay-handle-12345678",
          pushType: "alert",
          priority: 10,
          payload: {
            aps: { alert: { title: "Wake", body: "Ping" }, sound: "default" },
            openclaw: { kind: "push.test", nodeId: "ios-relay", ts: 123_456_789 },
          },
        }),
      );
      expect(
        verifyDeviceSignature(
          relayGatewayIdentity.publicKey,
          [
            "openclaw-relay-send-v1",
            headers.get("x-openclaw-gateway-device-id"),
            headers.get("x-openclaw-gateway-signed-at-ms"),
            bodyJson,
          ].join("\n"),
          headers.get("x-openclaw-gateway-signature") ?? "",
        ),
      ).toBe(true);
      expect(result).toMatchObject({
        ok: true,
        status: 200,
        apnsId: "relay-apns-id",
        environment: "production",
        tokenSuffix: "abcd1234",
      });
    });

    it("does not follow relay redirects", async () => {
      const { response, fetchMock } = mockRelayResponse("redirected", 302);
      const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);

      const result = await sendRelayPush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
      expect(result).toMatchObject({ ok: false, status: 302, reason: "RelayRedirectNotAllowed" });
      expect(result.environment).toBe("production");
      expect(cancel).toHaveBeenCalledOnce();
    });

    it.each([
      ["non-JSON fallback", "not-json-at-all", { status: 202 }],
      [
        "normalized fields",
        '{"ok":false,"status":410,"apnsId":" relay-apns-id ","reason":" Unregistered ","tokenSuffix":" abcd1234 "}',
        {
          ok: false,
          status: 410,
          apnsId: "relay-apns-id",
          reason: "Unregistered",
          tokenSuffix: "abcd1234",
        },
      ],
      ["BOM-prefixed failure", '\uFEFF{"ok":false,"status":410}', { ok: false, status: 410 }],
      [
        "sandbox metadata",
        '{"ok":true,"status":200,"environment":"sandbox","tokenSuffix":" abcd1234 "}',
        { environment: "sandbox", tokenSuffix: "abcd1234" },
      ],
    ] as const)("decodes %s", async (_name, body, expected) => {
      mockRelayResponse(body, 202);
      await expect(sendRelayPush()).resolves.toEqual({ ...relayResultFields, ...expected });
    });

    it("parses a large under-cap relay body unchanged (boundary just below the 16 MiB cap)", async () => {
      mockRelayResponse(
        JSON.stringify({
          ok: true,
          status: 200,
          apnsId: "big-but-valid",
          note: "x".repeat(8 * 1024 * 1024),
        }),
      );
      await expect(sendRelayPush()).resolves.toEqual({
        ...relayResultFields,
        apnsId: "big-but-valid",
      });
    });

    it("fails closed when the relay response body exceeds the size cap", async () => {
      const oversized = "a".repeat(16 * 1024 * 1024 + 1024);
      mockRelayResponse(oversized);

      await expect(sendRelayPush()).resolves.toEqual({
        ...relayResultFields,
        ok: false,
        reason: "RelayResponseTooLarge",
      });
    });

    it("rejects relay body with malformed UTF-8 bytes instead of parsing corrupted metadata", async () => {
      const encoder = new TextEncoder();
      const prefix = encoder.encode('{"ok":true,"status":200,"apnsId":"test-');
      const suffix = encoder.encode('1234"}');
      const body = new Uint8Array(prefix.length + 1 + suffix.length);
      body.set(prefix, 0);
      body[prefix.length] = 0xff; // bare invalid byte inside the apns-id string
      body.set(suffix, prefix.length + 1);

      mockRelayResponse(body, 202);

      await expect(sendRelayPush()).resolves.toEqual({
        ...relayResultFields,
        status: 202,
      });
    });
  });
});
