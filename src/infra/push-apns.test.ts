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
import { startProxy, stopProxy, type ProxyHandle } from "./net/proxy/proxy-lifecycle.js";
import {
  appendApnsResponseBodyCapture,
  createApnsResponseBodyCapture,
  getApnsResponseBodyCaptureText,
} from "./push-apns-http2.js";
import {
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  sendApnsAlert,
  sendApnsBackgroundWake,
  sendApnsExecApprovalAlert,
  sendApnsExecApprovalResolvedWake,
  sendApnsPluginApprovalAlert,
  sendApnsPluginApprovalResolvedWake,
  shouldClearStoredApnsRegistration,
} from "./push-apns.js";
import { mockApnsRelayFetch } from "./push-apns.relay.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const testAuthPrivateKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
}).privateKey.export({ format: "pem", type: "pkcs8" });

type CapturedApnsRequest = {
  headers: http2.IncomingHttpHeaders;
  body: string;
};

type DestroyableConnection = {
  destroy: () => void;
};

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
    auth: {
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: testAuthPrivateKey,
    },
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
  const environment = params.environment ?? "production";
  return {
    send: mockApnsRelayFetch(params.sendResult),
    registration: {
      nodeId: params.nodeId,
      transport: "relay" as const,
      relayHandle: params.relayHandle ?? "relay-handle-12345678",
      sendGrant: "send-grant-123",
      installationId: "install-123",
      topic: "ai.openclaw.ios",
      environment,
      distribution: "official" as const,
      updatedAtMs: 1,
      tokenDebugSuffix: params.tokenDebugSuffix,
    },
    relayConfig: {
      baseUrl: "https://relay.openclaw.test",
      timeoutMs: 2_500,
    },
  };
}

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

  it("guards direct wake transport with current ownership and lifecycle", async () => {
    const fixture = createDirectApnsSendFixture("ios-node-guarded-wake", "production");
    const { send } = fixture;
    const controller = new AbortController();
    const isCurrent = vi.fn().mockResolvedValue(true);

    await sendApnsBackgroundWake({
      ...fixture,
      signal: controller.signal,
      isCurrent,
    });

    expect(isCurrent).toHaveBeenCalledTimes(1);
    const sent = requireSendRequest(send);
    expect(sent.signal).toBe(controller.signal);
    expect(sent.isCurrent).toBe(isCurrent);
    expect(sent).toMatchObject({ pushType: "background", priority: "5" });
    const payload = requirePayload(sent);
    expect(payload.aps).toEqual({ "content-available": 1 });
    expectOpenClaw(payload, {
      kind: "node.wake",
      reason: "node.invoke",
      nodeId: "ios-node-guarded-wake",
    });

    await expect(
      sendApnsBackgroundWake({
        ...fixture,
        wakeReason: "node.invoke",
        isCurrent: vi.fn().mockResolvedValue(false),
      }),
    ).rejects.toThrow("APNs send invalidated");
    expect(send).toHaveBeenCalledTimes(1);
  });

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
      { status: 200, apnsId: "unused", body: "" },
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
      nodeId: "ios-node-approval-alert",
      approvalId: "approval-123",
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
      nodeId: "ios-node-approval-cleanup",
      approvalId: "approval-123",
      invoke: sendApnsExecApprovalResolvedWake,
      kind: "exec.approval.resolved",
      pushType: "background",
      aps: { "content-available": 1 },
      timeoutMs: Number.MAX_SAFE_INTEGER,
      sendResult: { status: 200, apnsId: "apns-timeout-cap-id", body: "{}" },
    },
    {
      name: "plugin approval alert with bounded request copy",
      nodeId: "ios-node-plugin-approval-alert",
      approvalId: "plugin:approval-123",
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
      nodeId: "ios-node-plugin-approval-cleanup",
      approvalId: "plugin:approval-123",
      invoke: sendApnsPluginApprovalResolvedWake,
      kind: "plugin.approval.resolved",
      pushType: "background",
      aps: { "content-available": 1 },
      sendResult: { status: 200, apnsId: "apns-plugin-approval-cleanup-id", body: "" },
    },
  ])(
    "sends $name",
    async ({
      nodeId,
      approvalId,
      invoke,
      kind,
      pushType,
      aps,
      forbidden,
      timeoutMs,
      sendResult,
    }) => {
      const fixture = createDirectApnsSendFixture(nodeId, "sandbox", sendResult);
      const result = await invoke({
        ...fixture,
        approvalId,
        gatewayDeviceId: "gateway-device-123",
        timeoutMs,
      });
      expect(fixture.send).toHaveBeenCalledTimes(1);
      const sent = requireSendRequest(fixture.send);
      expect(sent.pushType).toBe(pushType);
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
    },
  );

  it("falls back to the generic plugin approval title", async () => {
    const fixture = createDirectApnsSendFixture("ios-node-plugin-approval-fallback", "sandbox", {
      status: 200,
      apnsId: "apns-plugin-approval-fallback-id",
      body: "",
    });
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
