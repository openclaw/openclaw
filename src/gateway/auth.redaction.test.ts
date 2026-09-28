import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import { refResolutionError } from "../secrets/resolve-errors.js";
import {
  assertGatewayAuthConfigured,
  authorizeHttpGatewayConnect,
  authorizeControlUiReadHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
} from "./auth.js";
import { assertGatewayAuthNotKnownWeak } from "./known-weak-gateway-secrets.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";

describe.each([
  ["HTTP", authorizeHttpGatewayConnect],
  ["Control UI HTTP read", authorizeControlUiReadHttpGatewayConnect],
  ["WebSocket", authorizeWsControlUiGatewayConnect],
] as const)("%s shared-secret fields", (_surface, authorize) => {
  it.each(["token", "password"] as const)(
    "rejects a redacted %s before shared-secret or Tailscale authentication",
    async (mode) => {
      const auth = { mode, [mode]: REDACTED_SENTINEL, allowTailscale: true };
      expect(() => assertGatewayAuthConfigured(auth)).toThrow(/redaction sentinel/);
      for (const connectAuth of [{ [mode]: REDACTED_SENTINEL }, null]) {
        await expect(
          authorize({
            auth,
            connectAuth,
            ingressAttribution: {
              kind: "tailscale-serve",
              clientIp: "100.64.0.1",
              rateLimit: { subject: { key: "synthetic-tailnet-user" }, resetOnSuccess: true },
              verifyIdentity: async () => ({ login: "operator@example.test", name: "Operator" }),
            },
            browserOriginPolicy: { fetchSite: "same-origin" },
          }),
        ).resolves.toEqual({ ok: false, reason: `${mode}_redacted_config` });
      }
    },
  );
});

it("rejects a redacted local password fallback without rejecting proxy mode", async () => {
  await expect(
    authorizeHttpGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        password: REDACTED_SENTINEL,
        allowTailscale: false,
        trustedProxy: { userHeader: "x-forwarded-user" },
      },
      connectAuth: { password: REDACTED_SENTINEL },
      trustedProxies: ["127.0.0.1"],
      ingressAttribution: {
        kind: "direct-local",
        clientIp: "127.0.0.1",
        rateLimit: {
          subject: { key: "127.0.0.1" },
          resetOnSuccess: true,
        },
      },
    }),
  ).resolves.toEqual({ ok: false, reason: "password_redacted_config" });
});

it.each([
  ["configured auth", assertGatewayAuthConfigured],
  ["known-weak auth", assertGatewayAuthNotKnownWeak],
] as const)("%s directs password recovery to its credential source", (_name, validate) => {
  const auth = { mode: "password" as const, password: REDACTED_SENTINEL, allowTailscale: false };

  expect(() => validate(auth)).toThrow(/gateway\.auth\.password.*external secret source/);
  expect(() => validate(auth)).not.toThrow(/doctor --fix/);
});

it("keeps the corrupted store entry and Doctor remedy in the startup refusal", async () => {
  const ref = { source: "store", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" } as const;
  const activate = createRuntimeSecretsActivator({
    logSecrets: { info() {}, warn() {}, error() {} },
    emitStateEvent() {},
    activateRuntimeSecretsSnapshot() {},
    prepareRuntimeSecretsSnapshot: async () => {
      throw refResolutionError({
        code: "SECRET_REF_REDACTED_VALUE",
        source: ref.source,
        provider: ref.provider,
        refId: ref.id,
        message: "synthetic placeholder failure",
      });
    },
  });
  const failure = await activate(
    { gateway: { auth: { mode: "token", token: ref } } },
    { reason: "startup", activate: false, env: {} },
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain(ref.id);
  expect(String(failure)).toContain("redaction placeholder");
  expect(String(failure)).toContain("openclaw doctor --fix");
});
