// Covers APNs relay request signing, config, and response handling.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyDeviceSignature } from "./device-identity.js";
import type { RelayApnsRegistration } from "./push-apns-store.js";
import {
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  sendApnsBackgroundWake,
} from "./push-apns.js";
import { mockApnsRelayIdentity } from "./push-apns.relay.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sendPush(
  overrides: Pick<Parameters<typeof sendApnsBackgroundWake>[0], "signal" | "isCurrent"> & {
    pushType?: "alert" | "background";
  } = {},
) {
  mockApnsRelayIdentity();
  const registration: RelayApnsRegistration = {
    nodeId: "ios-relay",
    transport: "relay",
    relayHandle: "relay-handle-12345678",
    sendGrant: "send-grant-123",
    installationId: "install-relay",
    topic: "ai.openclaw.ios",
    environment: "production",
    distribution: "official",
    updatedAtMs: 1,
  };
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
        sendPush({
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
      const result = await sendPush({ pushType: "alert" });

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

      const result = await sendPush();

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
      await expect(sendPush()).resolves.toEqual({ ...relayResultFields, ...expected });
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
      await expect(sendPush()).resolves.toEqual({ ...relayResultFields, apnsId: "big-but-valid" });
    });

    it("fails closed when the relay response body exceeds the size cap", async () => {
      const oversized = "a".repeat(16 * 1024 * 1024 + 1024);
      mockRelayResponse(oversized);

      await expect(sendPush()).resolves.toEqual({
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

      await expect(sendPush()).resolves.toEqual({
        ...relayResultFields,
        status: 202,
      });
    });
  });
});
