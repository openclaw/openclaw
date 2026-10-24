import fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { shouldRequireGatewayTokenForInstall } from "../gateway/auth-install-policy.js";
import { withSecureTestNodeCommand } from "../secrets/test-node-command.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveGatewayAuthTokenForService } from "./doctor-gateway-auth-token.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createEnvGatewayTokenConfig(id: string): OpenClawConfig {
  return {
    gateway: { auth: { token: { source: "env", provider: "default", id } } },
    secrets: { providers: { default: { source: "env" } } },
  };
}

function createExecGatewayTokenConfig(
  markerPath: string,
  command = process.execPath,
): OpenClawConfig {
  const execmain = {
    source: "exec" as const,
    command,
    allowInsecurePath: true,
    args: [
      "-e",
      `const fs = require('node:fs');fs.writeFileSync(${JSON.stringify(markerPath)}, 'executed');process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { 'gateway/token': 'exec-token' } }));`,
    ],
  };
  return {
    gateway: { auth: { token: { source: "exec", provider: "execmain", id: "gateway/token" } } },
    secrets: { providers: { execmain } },
  };
}

describe("resolveGatewayAuthTokenForService", () => {
  it("reports skipped exec SecretRefs as unavailable without using ambient tokens", async () => {
    const markerPath = join(tempDirs.make("openclaw-service-token-exec-ref-"), "exec-ran");
    const resolved = await resolveGatewayAuthTokenForService(
      createExecGatewayTokenConfig(markerPath),
      { OPENCLAW_GATEWAY_TOKEN: "ambient-token" },
    );

    expect(resolved).toEqual({
      unavailableReason:
        "gateway.auth.token SecretRef is configured but unavailable because exec SecretRef resolution is disabled.",
    });
    expect(resolved.unavailableReason).not.toContain(markerPath);
    expect(resolved.unavailableReason).not.toContain("ambient-token");
    await expect(fs.access(markerPath)).rejects.toThrow();
  });

  it("executes exec SecretRefs for service token checks when explicitly allowed", async () => {
    const markerPath = join(tempDirs.make("openclaw-service-token-exec-ref-"), "exec-ran");
    await withSecureTestNodeCommand(async (command) => {
      const resolved = await resolveGatewayAuthTokenForService(
        createExecGatewayTokenConfig(markerPath, command),
        {},
        { allowExecSecretRefs: true },
      );

      expect(resolved).toEqual({ token: "exec-token" });
      await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("executed");
    });
  });

  it("does not fall back to OPENCLAW_GATEWAY_TOKEN when a SecretRef resolves to empty", async () => {
    const resolved = await resolveGatewayAuthTokenForService(
      createEnvGatewayTokenConfig("CUSTOM_GATEWAY_TOKEN"),
      {
        CUSTOM_GATEWAY_TOKEN: "   ",
        OPENCLAW_GATEWAY_TOKEN: "env-fallback-token",
      },
    );

    expect(resolved.token).toBeUndefined();
    expect(resolved.unavailableReason).toContain("gateway.auth.token SecretRef");
    expect(resolved.unavailableReason).not.toContain("env-fallback-token");
  });
});

describe("shouldRequireGatewayTokenForInstall", () => {
  it.each(["OPENCLAW", "CLAWDBOT", "MOLTBOT"])(
    "only infers password auth from canonical durable env (%s)",
    async (prefix) => {
      const stateDir = tempDirs.make("openclaw-install-password-env-");
      const passwordEnvKey = `${prefix}_GATEWAY_PASSWORD`;
      expect(
        shouldRequireGatewayTokenForInstall(
          { env: { vars: { [passwordEnvKey]: "synthetic-install-password" } } },
          { OPENCLAW_STATE_DIR: stateDir },
        ),
      ).toBe(prefix !== "OPENCLAW");
    },
  );

  it("requires token in inferred mode when password env exists only in shell", async () => {
    // pragma: allowlist secret
    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "password-from-env" }, async () => {
      expect(shouldRequireGatewayTokenForInstall({ gateway: { auth: {} } }, process.env)).toBe(
        true,
      );
    });
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
});
