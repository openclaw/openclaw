// Covers APNs relay request signing, config, and response handling.
import { generateKeyPairSync } from "node:crypto";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as identityRuntime from "./device-identity-async.js";
import {
  deriveDeviceIdFromPublicKey,
  publicKeyRawBase64UrlFromPem,
  verifyDeviceSignature,
} from "./device-identity.js";
import { resolveApnsRelayConfigFromEnv, sendApnsRelayPush } from "./push-apns.relay.js";

const relayGatewayIdentity = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
  const deviceId = deriveDeviceIdFromPublicKey(publicKeyRaw);
  if (!deviceId) {
    throw new Error("failed to derive test gateway device id");
  }
  return {
    deviceId,
    publicKeyPem,
    publicKey: publicKeyRaw,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
})();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sendPush(overrides: Partial<Parameters<typeof sendApnsRelayPush>[0]> = {}) {
  vi.spyOn(identityRuntime, "loadOrCreateProcessDeviceIdentityAsync").mockResolvedValue(
    relayGatewayIdentity,
  );
  return sendApnsRelayPush({
    relayConfig: {
      baseUrl: "https://relay.example.com",
      timeoutMs: 1000,
    },
    sendGrant: "send-grant-123",
    relayHandle: "relay-handle-123",
    payload: { aps: { "content-available": 1 } },
    pushType: "background" as const,
    priority: "5" as const,
    ...overrides,
  });
}

function expectRelayConfig(
  resolved: ReturnType<typeof resolveApnsRelayConfigFromEnv>,
  expected: { baseUrl: string; timeoutMs: number },
) {
  expect(resolved).toMatchObject({ ok: true, value: expected });
}

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

    it("lets env overrides win and clamps tiny timeout values", () => {
      const resolved = resolveApnsRelayConfigFromEnv(
        {
          OPENCLAW_APNS_RELAY_BASE_URL: " https://relay-override.example.com/base/ ",
          OPENCLAW_APNS_RELAY_TIMEOUT_MS: "999",
        } as NodeJS.ProcessEnv,
        {
          push: {
            apns: {
              relay: {
                baseUrl: "https://relay.example.com",
                timeoutMs: 2500,
              },
            },
          },
        },
      );

      expectRelayConfig(resolved, {
        baseUrl: "https://relay-override.example.com/base",
        timeoutMs: 1000,
      });
    });

    it("caps oversized timeout values before they reach AbortSignal.timeout", () => {
      const resolved = resolveApnsRelayConfigFromEnv({
        OPENCLAW_APNS_RELAY_BASE_URL: "https://relay.example.com",
        OPENCLAW_APNS_RELAY_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER),
      } as NodeJS.ProcessEnv);

      expectRelayConfig(resolved, {
        baseUrl: "https://relay.example.com",
        timeoutMs: MAX_TIMER_TIMEOUT_MS,
      });
    });

    it.each(["2e4"])("falls back for non-decimal env timeout %s", (timeoutMs) => {
      const resolved = resolveApnsRelayConfigFromEnv({
        OPENCLAW_APNS_RELAY_BASE_URL: "https://relay.example.com",
        OPENCLAW_APNS_RELAY_TIMEOUT_MS: timeoutMs,
      } as NodeJS.ProcessEnv);

      expectRelayConfig(resolved, {
        baseUrl: "https://relay.example.com",
        timeoutMs: 10_000,
      });
    });

    it("uses the configured timeout when the env override is blank", () => {
      const resolved = resolveApnsRelayConfigFromEnv(
        {
          OPENCLAW_APNS_RELAY_BASE_URL: "https://relay.example.com",
          OPENCLAW_APNS_RELAY_TIMEOUT_MS: "   ",
        },
        { push: { apns: { relay: { timeoutMs: 2500 } } } },
      );

      expectRelayConfig(resolved, {
        baseUrl: "https://relay.example.com",
        timeoutMs: 2500,
      });
    });

    it("allows loopback http URLs for alternate truthy env values", () => {
      const resolved = resolveApnsRelayConfigFromEnv({
        OPENCLAW_APNS_RELAY_BASE_URL: "http://[::1]:8787",
        OPENCLAW_APNS_RELAY_ALLOW_HTTP: "yes",
        OPENCLAW_APNS_RELAY_TIMEOUT_MS: "nope",
      });

      expectRelayConfig(resolved, {
        baseUrl: "http://[::1]:8787",
        timeoutMs: 10_000,
      });
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

  describe("sendApnsRelayPush", () => {
    it("revalidates ownership before relay fetch and combines the lifecycle signal", async () => {
      const controller = new AbortController();
      const isCurrent = vi.fn().mockResolvedValue(true);
      const { fetchMock } = mockRelayResponse("", 202);

      await sendPush({
        signal: controller.signal,
        isCurrent,
      });

      expect(isCurrent).toHaveBeenCalledTimes(2);
      const fetchOptions = fetchMock.mock.calls[0]?.[1];
      expect(fetchOptions?.signal?.aborted).toBe(false);
      controller.abort(new Error("pairing removed"));
      expect(fetchOptions?.signal?.aborted).toBe(true);
    });

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

      const result = await sendPush({
        payload: { aps: { alert: { title: "Wake", body: "Ping" } } },
        pushType: "alert",
        priority: "10",
      });

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
          relayHandle: "relay-handle-123",
          pushType: "alert",
          priority: 10,
          payload: { aps: { alert: { title: "Wake", body: "Ping" } } },
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
      expect(result.environment).toBeUndefined();
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("falls back to fetch status when the relay body is not JSON", async () => {
      // Real Response body so the bounded reader runs end-to-end; non-JSON parse stays a soft null.
      const fetchMock = vi.fn().mockResolvedValue(new Response("not-json-at-all", { status: 202 }));
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendPush()).resolves.toEqual({
        ok: true,
        status: 202,
        apnsId: undefined,
        reason: undefined,
        tokenSuffix: undefined,
      });
    });

    it("normalizes relay JSON response fields", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            status: 410,
            apnsId: " relay-apns-id ",
            reason: " Unregistered ",
            tokenSuffix: " abcd1234 ",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendPush()).resolves.toEqual({
        ok: false,
        status: 410,
        apnsId: "relay-apns-id",
        reason: "Unregistered",
        tokenSuffix: "abcd1234",
      });
    });

    it("honors BOM-prefixed relay failure JSON", async () => {
      const body = `\uFEFF${JSON.stringify({ ok: false, status: 410 })}`;
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(body, { status: 202, headers: { "content-type": "application/json" } }),
        );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendPush()).resolves.toEqual({
        ok: false,
        status: 410,
        apnsId: undefined,
        reason: undefined,
        tokenSuffix: undefined,
      });
    });

    it("normalizes sandbox relay response metadata", async () => {
      mockRelayResponse(
        JSON.stringify({
          ok: true,
          status: 200,
          environment: "sandbox",
          tokenSuffix: " abcd1234 ",
        }),
      );

      await expect(sendPush()).resolves.toEqual({
        ok: true,
        status: 200,
        apnsId: undefined,
        reason: undefined,
        environment: "sandbox",
        tokenSuffix: "abcd1234",
      });
    });

    it("parses a large under-cap relay body unchanged (boundary just below the 16 MiB cap)", async () => {
      // A valid, large-but-bounded JSON body (~8 MiB payload, comfortably under the 16 MiB cap)
      // must still parse normally: the cap only rejects overflow, it must not truncate or reject
      // legitimate large success responses.
      const padding = "x".repeat(8 * 1024 * 1024);
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            apnsId: "big-but-valid",
            note: padding,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendPush()).resolves.toEqual({
        ok: true,
        status: 200,
        apnsId: "big-but-valid",
        reason: undefined,
        tokenSuffix: undefined,
      });
    });

    it("fails closed when the relay response body exceeds the size cap", async () => {
      const oversized = "a".repeat(16 * 1024 * 1024 + 1024);
      mockRelayResponse(oversized);

      await expect(sendPush()).resolves.toEqual({
        ok: false,
        status: 200,
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
        ok: true,
        status: 202,
        apnsId: undefined,
        reason: undefined,
        tokenSuffix: undefined,
      });
    });
  });
});
