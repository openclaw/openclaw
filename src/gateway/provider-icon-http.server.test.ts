import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken, revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveProviderPresentation } from "./provider-presentation.js";
import { AUTH_TOKEN, sendRequest, withGatewayServer } from "./server-http.test-harness.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGMwSJiAFTEMLQkACmxIAasRElQAAAAASUVORK5CYII=",
  "base64",
);
afterEach(() => vi.restoreAllMocks());

describe("provider artwork device-token authority", () => {
  it("revalidates paired tokens after held artwork loads and on cache hits", async () => {
    await withOpenClawTestState(
      { prefix: "provider-icon-device-", scenario: "empty" },
      async () => {
        const deviceId = "provider-icon-device";
        const scopes = ["operator.read"];
        const pairing = await requestDevicePairing({
          deviceId,
          publicKey: "provider-icon-public-key",
          role: "operator",
          scopes,
        });
        const approval = await approveDevicePairing(pairing.request.requestId, {
          callerScopes: scopes,
        });
        expect(approval?.status).toBe("approved");
        const generation = resolveSharedGatewaySessionGeneration(AUTH_TOKEN);
        assert(generation, "The test Gateway must use shared-token authentication");
        const issueToken = () =>
          ensureDeviceToken({
            deviceId,
            role: "operator",
            scopes,
            issuer: {
              kind: "shared-gateway-auth",
              generation,
            },
          });
        const token = await issueToken();
        expect(token).toBeTruthy();
        const loading = createDeferred();
        const release = createDeferred();
        // Hold only external I/O; pairing, verification, revocation, and delivery stay real.
        const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
          loading.resolve();
          await release.promise;
          return new Response(PNG, { headers: { "content-type": "image/png" } });
        });
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              workstation: {
                baseUrl: "http://127.0.0.1:11434/v1",
                models: [],
                icon: { source: "url", url: "https://1.1.1.1/revoked-provider-icon.png" },
              },
            },
          },
        };
        const icon = resolveProviderPresentation(cfg, "workstation").providerIcon;
        if (icon?.source !== "asset") {
          throw new Error("expected scoped icon asset");
        }
        await withGatewayServer({
          prefix: "provider-icon-revalidation-",
          resolvedAuth: AUTH_TOKEN,
          overrides: { controlUiEnabled: true, controlUiBasePath: "", getRuntimeConfig: () => cfg },
          run: async (server) => {
            const pending = sendRequest(server, {
              path: icon.url,
              authorization: `Bearer ${token?.token}`,
            });
            try {
              expect(
                await Promise.race([
                  loading.promise.then(() => "loading"),
                  pending.then((reply) => `response:${reply.res.statusCode}`),
                ]),
              ).toBe("loading");
              expect(
                await revokeDeviceToken({ deviceId, role: "operator", callerScopes: scopes }),
              ).toMatchObject({ ok: true, entry: { revokedAtMs: expect.any(Number) } });
            } finally {
              release.resolve();
            }
            const denied = await pending;
            expect(denied.res.statusCode).toBe(401);
            expect(denied.setHeader).not.toHaveBeenCalledWith("content-type", "image/png");
            expect(denied.end.mock.calls[0]?.[0]).not.toBeInstanceOf(Buffer);
            const renewed = await issueToken();
            const cached = await sendRequest(server, {
              path: icon.url,
              authorization: `Bearer ${renewed?.token}`,
            });
            expect(cached.res.statusCode).toBe(200);
            const body = cached.end.mock.calls[0]?.[0];
            expect(Buffer.isBuffer(body)).toBe(true);
            expect(network).toHaveBeenCalledOnce();
            expect(
              await revokeDeviceToken({ deviceId, role: "operator", callerScopes: scopes }),
            ).toMatchObject({ ok: true, entry: { revokedAtMs: expect.any(Number) } });
            const revokedCache = await sendRequest(server, {
              path: icon.url,
              authorization: `Bearer ${renewed?.token}`,
            });
            expect(revokedCache.res.statusCode).toBe(401);
            expect(revokedCache.setHeader).not.toHaveBeenCalledWith("content-type", "image/png");
            expect(network).toHaveBeenCalledOnce();
          },
        });
      },
    );
  });
});
