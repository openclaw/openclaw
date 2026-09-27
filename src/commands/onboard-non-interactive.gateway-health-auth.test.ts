// Non-interactive onboarding forwards resolved auth to its public health boundaries.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deleteTestEnvValue } from "../test-utils/env.js";
import {
  capturedReplaceConfigFileCalls,
  configWritePluginLeaseDepths,
  gatewayReachableState,
  healthCommandMock,
  readTestConfig,
  resolveTestConfigPath,
  runNonInteractiveSetup,
  testConfigStore,
  useGatewayOnboardTestHarness,
} from "./onboard-non-interactive.gateway.test-mocks.js";
import {
  createOnboardJsonCaptureRuntime,
  createOnboardLocalDaemonOptions,
  readOnboardFirstMockCall,
  type OnboardGatewayHealthCall,
} from "./onboard-non-interactive.test-helpers.js";

async function writeSecureFile(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

function expectAuthCall(mock: unknown, label: string, expected: OnboardGatewayHealthCall) {
  expect(mock).toHaveBeenCalledOnce();
  const [call] = readOnboardFirstMockCall(mock, label) as [OnboardGatewayHealthCall];
  expect(call.token).toBe(expected.token);
  expect(call.password).toBe(expected.password);
}

describe("onboard (non-interactive): gateway health auth", () => {
  const { withStateDir } = useGatewayOnboardTestHarness("openclaw-gateway-health-auth-");

  afterEach(async () => {
    gatewayReachableState.mock = undefined;
    const { resetSecretRedactionRegistryForTest } =
      await import("../logging/secret-redaction-registry.test-support.js");
    resetSecretRedactionRegistryForTest();
    testConfigStore.clear();
    capturedReplaceConfigFileCalls.length = 0;
    configWritePluginLeaseDepths.length = 0;
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");
    vi.clearAllMocks();
  });

  async function runHealthSetup(
    stateDir: string,
    config: OpenClawConfig,
    reachable = true,
  ): Promise<unknown> {
    testConfigStore.set(resolveTestConfigPath(), config);
    gatewayReachableState.mock = vi.fn(async () =>
      reachable ? { ok: true } : { ok: false, detail: "unauthorized" },
    );
    const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();
    const setup = runNonInteractiveSetup(
      { ...createOnboardLocalDaemonOptions(stateDir), installDaemon: false, json: true },
      runtimeWithCapture,
    );
    if (reachable) {
      await setup;
    } else {
      await expect(setup).rejects.toThrow("exit should not be reached after runtime.error");
    }
    return JSON.parse(readCapturedJson());
  }

  it("resolves file SecretRefs for the local onboarding health probe without persisting plaintext", async () => {
    await withStateDir("state-file-token-", async (stateDir) => {
      const tokenPath = path.join(stateDir, "gateway-token.txt");
      await writeSecureFile(tokenPath, "file-secret-token\n");
      process.env.OPENCLAW_GATEWAY_TOKEN = "stale-env-token";
      const tokenRef = { source: "file" as const, provider: "gateway-token-file", id: "value" };
      const result = await runHealthSetup(stateDir, {
        gateway: { auth: { mode: "token", token: tokenRef } },
        secrets: {
          providers: {
            "gateway-token-file": { source: "file", path: tokenPath, mode: "singleValue" },
          },
        },
      });

      expectAuthCall(gatewayReachableState.mock, "reachability", { token: "file-secret-token" });
      expectAuthCall(healthCommandMock, "health", { token: "file-secret-token" });
      expect(readTestConfig().gateway?.auth?.token).toEqual(tokenRef);
      expect(result).toMatchObject({ ok: true });
    });
  });

  it("does not fall back to stale OPENCLAW_GATEWAY_TOKEN when a SecretRef is unresolved", async () => {
    await withStateDir("state-missing-token-", async (stateDir) => {
      process.env.OPENCLAW_GATEWAY_TOKEN = "stale-env-token";
      const tokenRef = { source: "file" as const, provider: "gateway-token-file", id: "value" };
      const result = await runHealthSetup(
        stateDir,
        {
          gateway: { auth: { mode: "token", token: tokenRef } },
          secrets: {
            providers: {
              "gateway-token-file": {
                source: "file",
                path: path.join(stateDir, "missing-token.txt"),
                mode: "singleValue",
              },
            },
          },
        },
        false,
      );

      expectAuthCall(gatewayReachableState.mock, "reachability", {});
      expect(healthCommandMock).not.toHaveBeenCalled();
      expect(readTestConfig().gateway?.auth?.token).toEqual(tokenRef);
      expect(result).toMatchObject({
        ok: false,
        phase: "gateway-health",
        detail:
          "unauthorized\ngateway.auth.token SecretRef is unresolved (file:gateway-token-file:value).",
      });
    });
  });

  it("resolves password auth for the local onboarding health probe", async () => {
    await withStateDir("state-password-ref-", async (stateDir) => {
      process.env.OPENCLAW_GATEWAY_TOKEN = "stale-env-token";
      process.env.OPENCLAW_GATEWAY_PASSWORD = "resolved-password"; // pragma: allowlist secret
      const passwordRef = {
        source: "env" as const,
        provider: "default",
        id: "OPENCLAW_GATEWAY_PASSWORD",
      };
      const result = await runHealthSetup(stateDir, {
        gateway: { auth: { mode: "password", password: passwordRef } },
      });

      expectAuthCall(gatewayReachableState.mock, "reachability", { password: "resolved-password" });
      expectAuthCall(healthCommandMock, "health", { password: "resolved-password" });
      expect(readTestConfig().gateway?.auth?.password).toEqual(passwordRef);
      expect(result).toMatchObject({ ok: true });
    });
  });

  it("does not fall back to ambient password auth when its configured SecretRef is unresolved", async () => {
    await withStateDir("state-missing-password-", async (stateDir) => {
      process.env.OPENCLAW_GATEWAY_PASSWORD = "ambient-password"; // pragma: allowlist secret
      const passwordRef = {
        source: "env" as const,
        provider: "default",
        id: "MISSING_ONBOARD_GATEWAY_PASSWORD",
      };
      const result = await runHealthSetup(
        stateDir,
        { gateway: { auth: { mode: "password", password: passwordRef } } },
        false,
      );

      expectAuthCall(gatewayReachableState.mock, "reachability", {});
      expect(healthCommandMock).not.toHaveBeenCalled();
      expect(readTestConfig().gateway?.auth?.password).toEqual(passwordRef);
      expect(result).toMatchObject({
        ok: false,
        phase: "gateway-health",
        detail:
          "unauthorized\ngateway.auth.password SecretRef is unresolved (env:default:MISSING_ONBOARD_GATEWAY_PASSWORD).",
      });
    });
  });

  it("resolves environment-only password auth for the local onboarding health probe", async () => {
    await withStateDir("state-env-password-", async (stateDir) => {
      process.env.OPENCLAW_GATEWAY_PASSWORD = "environment-password"; // pragma: allowlist secret
      const result = await runHealthSetup(stateDir, {
        gateway: { auth: { mode: "password" } },
      });

      expectAuthCall(gatewayReachableState.mock, "reachability", {
        password: "environment-password",
      });
      expectAuthCall(healthCommandMock, "health", { password: "environment-password" });
      expect(readTestConfig().gateway?.auth?.password).toBeUndefined();
      expect(result).toMatchObject({ ok: true });
    });
  });
});
