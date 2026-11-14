import fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { shouldRequireGatewayTokenForInstall } from "../gateway/auth-install-policy.js";
import { withSecureTestNodeCommand } from "../secrets/test-node-command.test-support.js";
import { resolveGatewayAuthTokenForService } from "./doctor-gateway-auth-token.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "gates exec SecretRefs without ambient fallback (allowed=%s)",
  async (allowed) => {
    const markerPath = join(tempDirs.make("openclaw-service-token-exec-ref-"), "exec-ran");
    await withSecureTestNodeCommand(async (command) => {
      const resolved = await resolveGatewayAuthTokenForService(
        {
          gateway: {
            auth: { token: { source: "exec", provider: "execmain", id: "gateway/token" } },
          },
          secrets: {
            providers: {
              execmain: {
                source: "exec",
                command,
                args: [
                  "-e",
                  `const fs = require('node:fs');fs.writeFileSync(${JSON.stringify(markerPath)}, 'executed');process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { 'gateway/token': 'exec-token' } }));`,
                ],
              },
            },
          },
        },
        { OPENCLAW_GATEWAY_TOKEN: "ambient-token" },
        allowed ? { allowExecSecretRefs: true } : undefined,
      );
      if (allowed) {
        expect(resolved).toEqual({ token: "exec-token" });
        await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("executed");
      } else {
        expect(resolved).toEqual({
          unavailableReason:
            "gateway.auth.token SecretRef is configured but unavailable because exec SecretRef resolution is disabled.",
        });
        await expect(fs.access(markerPath)).rejects.toThrow();
      }
    });
  },
);

it("does not fall back to OPENCLAW_GATEWAY_TOKEN when a SecretRef resolves to empty", async () => {
  const resolved = await resolveGatewayAuthTokenForService(
    {
      gateway: {
        auth: { token: { source: "env", provider: "default", id: "CUSTOM_GATEWAY_TOKEN" } },
      },
      secrets: { providers: { default: { source: "env" } } },
    },
    {
      CUSTOM_GATEWAY_TOKEN: "   ",
      OPENCLAW_GATEWAY_TOKEN: "env-fallback-token",
    },
  );

  expect(resolved.token).toBeUndefined();
  expect(resolved.unavailableReason).toContain("gateway.auth.token SecretRef");
  expect(resolved.unavailableReason).not.toContain("env-fallback-token");
});
it.each(["OPENCLAW", "CLAWDBOT", "MOLTBOT"])(
  "only infers password auth from canonical durable env (%s)",
  async (prefix) => {
    const stateDir = tempDirs.make("openclaw-install-password-env-");
    expect(
      shouldRequireGatewayTokenForInstall(
        { env: { vars: { [`${prefix}_GATEWAY_PASSWORD`]: "synthetic-install-password" } } },
        { OPENCLAW_STATE_DIR: stateDir },
      ),
    ).toBe(prefix !== "OPENCLAW");
  },
);

it("requires token in inferred mode when password env exists only in shell", () => {
  expect(
    shouldRequireGatewayTokenForInstall(
      { gateway: { auth: {} } },
      {
        OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // pragma: allowlist secret
      },
    ),
  ).toBe(true);
});

it("blocks install token resolution for tailscale serve with explicit no-auth", async () => {
  const resolved = await resolveGatewayInstallToken({
    config: { gateway: { auth: { mode: "none" }, tailscale: { mode: "serve" } } },
    env: {},
  });

  expect(resolved.unavailableReason).toBe(
    "gateway.auth.mode=none cannot be used with gateway.tailscale.mode=serve; configure token, password, or trusted-proxy auth before exposing the gateway through Tailscale",
  );
});
