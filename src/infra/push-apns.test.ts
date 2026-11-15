import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import http2 from "node:http2";
import net from "node:net";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { withLoopbackTestServer } from "../commands/loopback-server.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { verifyDeviceSignature } from "./device-identity.js";
import { startProxy, stopProxy } from "./net/proxy/proxy-lifecycle.js";
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

type CapturedApnsRequest = {
  headers: http2.IncomingHttpHeaders;
  body: string;
};

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
  response: { responseBody: string; status: number },
  check: (requests: CapturedApnsRequest[], connectTargets: string[]) => Promise<void>,
) {
  const requests: CapturedApnsRequest[] = [];
  const connectTargets: string[] = [];
  const server = http2.createSecureServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += String(chunk);
    });
    stream.on("end", () => {
      requests.push({ headers, body });
      stream.respond({ ":status": response.status, "apns-id": "proxied-apns-id" });
      stream.end(response.responseBody);
    });
  });
  await withLoopbackTestServer(server, async (port) => {
    const proxy = createServer();
    proxy.on("connect", (request, client, head) => {
      connectTargets.push(request.url ?? "");
      const upstream = net.connect(port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) {
          upstream.write(head);
        }
        client.pipe(upstream).pipe(client);
      });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    await withLoopbackTestServer(proxy, async (proxyPort) =>
      withEnvAsync({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, async () => {
        const handle = await startProxy({ proxyUrl: `http://127.0.0.1:${proxyPort}` });
        try {
          await check(requests, connectTargets);
        } finally {
          await stopProxy(handle);
        }
      }),
    );
  });
}

describe("push APNs send semantics", () => {
  it("bounds APNs response body capture", () => {
    const capture = createApnsResponseBodyCapture();

    appendApnsResponseBodyCapture(capture, "a".repeat(8190));
    appendApnsResponseBodyCapture(capture, "def");

    expect(getApnsResponseBodyCaptureText(capture)).toBe("a".repeat(8190) + "de");
    expect(capture).toMatchObject({ capturedBytes: 8192, truncated: true });
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
      await withProxiedApns({ status, responseBody }, async (requests, connectTargets) => {
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
        expect(connectTargets).toEqual(["api.sandbox.push.apple.com:443"]);
        expect(requests).toHaveLength(1);
        const request = requests[0];
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
    ["exec", "alert", sendApnsExecApprovalAlert],
    ["exec", "background", sendApnsExecApprovalResolvedWake],
    ["plugin", "alert", sendApnsPluginApprovalAlert],
    ["plugin", "background", sendApnsPluginApprovalResolvedWake],
  ] as const)("sends %s approval %s", async (kind, pushType, invoke) => {
    const alert = pushType === "alert";
    const plugin = kind === "plugin";
    const fixture = createDirectApnsSendFixture("ios-node-approval");
    const approval = {
      ...fixture,
      approvalId: "approval-123",
      gatewayDeviceId: "gateway-device-123",
      timeoutMs: Number.MAX_SAFE_INTEGER,
      title: "Install plugin update",
      description: `${"x".repeat(255)}😀${"y".repeat(300)}`,
    };
    const readControl = () => {
      throw new Error("approval must not read lifecycle controls");
    };
    Object.defineProperties(approval, {
      signal: { enumerable: true, get: readControl },
      isCurrent: { enumerable: true, get: readControl },
    });
    const result = await invoke(approval);
    const sent = requireSendRequest(fixture.send);
    expectNoProperties(sent, ["signal", "isCurrent"]);
    expect(sent).toMatchObject({ pushType, timeoutMs: MAX_TIMER_TIMEOUT_MS });
    const payload = requirePayload(sent);
    expect(payload.aps).toEqual(
      alert
        ? {
            alert: {
              title: plugin ? "Install plugin update" : "Exec approval required",
              body: plugin ? `${"x".repeat(255)}…` : "Open OpenClaw to review this request.",
            },
            sound: "default",
            category: `openclaw.${kind}-approval`,
            "content-available": 1,
          }
        : { "content-available": 1 },
    );
    const metadata = expectOpenClaw(payload, {
      kind: `${kind}.approval.${alert ? "requested" : "resolved"}`,
      approvalId: "approval-123",
      gatewayDeviceId: "gateway-device-123",
    });
    expectNoProperties(
      metadata,
      plugin
        ? ["title", "description", "toolName", "agentId", "sessionKey"]
        : ["host", "nodeId", "agentId", "commandText", "allowedDecisions", "expiresAtMs"],
    );
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

  it.each(["topic", "ownership"])("rejects invalid direct %s before sending", async (invalid) => {
    const fixture = createDirectApnsSendFixture("ios-node-invalid-topic");
    const { send } = fixture;

    await expect(
      sendApnsAlert({
        ...fixture,
        registration: { ...fixture.registration, ...(invalid === "topic" ? { topic: "   " } : {}) },
        isCurrent: async () => invalid !== "ownership",
        nodeId: "ios-node-invalid-topic",
        title: "Wake",
        body: "Ping",
      }),
    ).rejects.toThrow(invalid === "topic" ? "topic required" : "APNs send invalidated");

    expect(send).not.toHaveBeenCalled();
  });

  it.each([undefined, "queue.retry"])(
    "sends relay wake reason %s with the handle suffix",
    async (wakeReason) => {
      const send = mockApnsRelayFetch({
        ok: false,
        status: 429,
        reason: "TooManyRequests",
        environment: "production",
      });
      const registration = relayRegistration("ios-node-relay-wake");
      const relayConfig = { baseUrl: "https://relay.openclaw.test", timeoutMs: 2_500 };

      const result = await sendApnsBackgroundWake({
        registration,
        nodeId: "ios-node-relay-wake",
        wakeReason,
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
        reason: wakeReason ?? "node.invoke",
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
    },
  );

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
    expect(
      shouldClearStoredApnsRegistration({
        registration: relayRegistration("ios-node-relay"),
        result: { status: 410, reason: "Unregistered" },
      }),
    ).toBe(false);
  });
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
    it.each([false, true])(
      "does not send when relay ownership changes (initially current=%s)",
      async (initiallyCurrent) => {
        const fetchMock = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", fetchMock);

        await expect(
          sendRelayPush({
            isCurrent: vi.fn().mockResolvedValueOnce(initiallyCurrent).mockResolvedValue(false),
          }),
        ).rejects.toThrow("APNs send invalidated");

        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

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
      const controller = new AbortController();
      const result = await sendRelayPush({
        pushType: "alert",
        signal: controller.signal,
        isCurrent: async () => true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://relay.example.com/v1/push/send");
      expect(timeout).toHaveBeenCalledWith(1000);
      const fetchOptions = fetchMock.mock.calls[0]?.[1];
      expect(fetchOptions?.signal?.aborted).toBe(false);
      controller.abort();
      expect(fetchOptions?.signal?.aborted).toBe(true);
      const headers = new Headers(fetchOptions?.headers);
      const bodyJson = fetchOptions?.body;
      if (typeof bodyJson !== "string") {
        throw new Error("expected a serialized relay request body");
      }
      expect(headers.get("authorization")).toBe("Bearer send-grant-123");
      expect(headers.get("x-openclaw-gateway-device-id")).toBe(relayGatewayIdentity.deviceId);
      expect(headers.get("x-openclaw-gateway-signed-at-ms")).toBe("123456789");
      expect(JSON.parse(bodyJson)).toMatchObject({
        relayHandle: "relay-handle-12345678",
        pushType: "alert",
        priority: 10,
      });
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
      mockRelayResponse(
        Buffer.concat([
          Buffer.from('{"ok":true,"status":200,"apnsId":"test-'),
          Buffer.from([0xff]),
          Buffer.from('1234"}'),
        ]),
        202,
      );

      await expect(sendRelayPush()).resolves.toEqual({
        ...relayResultFields,
        status: 202,
      });
    });
  });
});
