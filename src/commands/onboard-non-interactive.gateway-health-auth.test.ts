// Non-interactive onboarding forwards resolved auth to its public health boundaries.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSetupHealthGateway } from "../../test/helpers/setup-health-gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  gatewayReachableState,
  getPseudoPort,
  gatewayOnboardRuntime as runtime,
  gatewayServiceMock,
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

const SETUP_GATEWAY_PORT = 19861;

function expectAuthCall(mock: unknown, expected: OnboardGatewayHealthCall = {}) {
  expect(mock).toHaveBeenCalledOnce();
  const [call] = readOnboardFirstMockCall(mock, "health auth") as [OnboardGatewayHealthCall];
  expect([call.token, call.password]).toEqual([expected.token, expected.password]);
}

describe("onboard (non-interactive): gateway health auth", () => {
  const { withStateDir } = useGatewayOnboardTestHarness("openclaw-gateway-health-auth-");

  afterEach(async () => {
    gatewayReachableState.mock = undefined;
    const { resetSecretRedactionRegistryForTest } =
      await import("../logging/secret-redaction-registry.test-support.js");
    resetSecretRedactionRegistryForTest();
    testConfigStore.clear();
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");
    vi.clearAllMocks();
    healthCommandMock.mockReset().mockResolvedValue(undefined);
    gatewayServiceMock.readRuntime.mockReset().mockResolvedValue({
      status: "running",
      state: "active",
      pid: 4242,
    });
  });

  async function runHealthSetup(
    stateDir: string,
    config: OpenClawConfig,
    reachable = true,
    port = SETUP_GATEWAY_PORT,
  ): Promise<unknown> {
    testConfigStore.set(resolveTestConfigPath(), config);
    gatewayReachableState.mock = vi.fn(async () =>
      reachable ? { ok: true } : { ok: false, detail: "unauthorized" },
    );
    const { runtimeWithCapture, readCapturedJson } = createOnboardJsonCaptureRuntime();
    const setup = runNonInteractiveSetup(
      {
        ...createOnboardLocalDaemonOptions(stateDir),
        gatewayPort: port,
        installDaemon: false,
        json: true,
      },
      runtimeWithCapture,
    );
    if (reachable) {
      await setup;
    } else {
      await expect(setup).rejects.toThrow("exit should not be reached after runtime.error");
    }
    return JSON.parse(readCapturedJson());
  }

  it("keeps real health authentication on the setup Gateway despite ambient endpoints", async ({
    signal,
  }) => {
    const actual = await vi.importActual<typeof import("./health.js")>("./health.js");
    await withStateDir("state-real-health-", async (stateDir) => {
      await withSetupHealthGateway("noninteractive", signal, async ({ config, port, pid }) => {
        gatewayServiceMock.readRuntime.mockResolvedValue({
          status: "running",
          state: "active",
          pid,
        });
        let completed = false;
        healthCommandMock.mockImplementation(async (...args) => {
          await actual.healthCommandNonExiting(...args);
          completed = true;
        });
        const result = await runHealthSetup(stateDir, config, true, port);
        expect(completed).toBe(true);
        expect(result).toMatchObject({ ok: true });
        expect(readTestConfig().gateway?.auth?.mode).toBe("trusted-proxy");
      });
    });
  }, 90_000);

  it.each([
    ["token", "file", "value", "file-secret-token"],
    ["token", "file", "value", undefined],
    ["password", "env", "OPENCLAW_GATEWAY_PASSWORD", "resolved-password"],
    ["password", "env", "MISSING_ONBOARD_GATEWAY_PASSWORD", undefined],
    ["password", undefined, undefined, "environment-password"],
  ] as const)(
    "resolves %s/%s/%s to %s without persisting plaintext or falling back",
    async (field, source, id, value) => {
      await withStateDir("state-health-auth-", async (stateDir) => {
        const provider = source === "file" ? "gateway-token-file" : "default";
        const ref = source && id ? { source, provider, id } : undefined;
        const tokenPath = path.join(stateDir, "gateway-token.txt");
        if (source === "file" && value) {
          await fs.writeFile(tokenPath, `${value}\n`, { mode: 0o600 });
        }
        if (field === "token" || id === "OPENCLAW_GATEWAY_PASSWORD") {
          setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", "stale-env-token");
        }
        if (field === "password") {
          setTestEnvValue("OPENCLAW_GATEWAY_PASSWORD", value ?? "ambient-password");
        }
        const result = await runHealthSetup(
          stateDir,
          {
            gateway: {
              auth: { mode: field, [field]: ref },
              ...(id === "OPENCLAW_GATEWAY_PASSWORD" ? { trustedProxies: ["10.0.0.5"] } : {}),
            },
            ...(source === "file"
              ? {
                  secrets: {
                    providers: { [provider]: { source, path: tokenPath, mode: "singleValue" } },
                  },
                }
              : {}),
          },
          value !== undefined,
        );

        expect(readTestConfig().gateway?.auth?.[field]).toEqual(ref);
        if (value !== undefined) {
          expectAuthCall(gatewayReachableState.mock, { [field]: value });
          expectAuthCall(healthCommandMock, { [field]: value });
          expect(healthCommandMock).toHaveBeenCalledWith(
            expect.objectContaining({ localPortOverride: SETUP_GATEWAY_PORT }),
            expect.anything(),
          );
          expect(result).toMatchObject({ ok: true });
        } else {
          expectAuthCall(gatewayReachableState.mock);
          expect(healthCommandMock).not.toHaveBeenCalled();
          expect(result).toMatchObject({
            ok: false,
            phase: "gateway-health",
            detail: `unauthorized\ngateway.auth.${field} SecretRef is unresolved (${source}:${provider}:${id}).`,
          });
        }
      });
    },
  );
  it.each(["lan", "store-ref", "env-ref"] as const)(
    "persists generated/ambient token auth (%s)",
    async (mode) => {
      if (process.platform === "win32") {
        // Windows runner occasionally drops the temp config write in these flows.
        return;
      }
      await withStateDir("state-token-", async (stateDir) => {
        const port = getPseudoPort(
          mode === "lan" ? 40_000 : mode === "store-ref" ? 41_000 : 42_000,
        );
        if (mode === "env-ref") {
          setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", "ambient-gateway-token");
        }
        await runNonInteractiveSetup(
          {
            ...createOnboardLocalDaemonOptions(stateDir),
            skipHealth: true,
            installDaemon: false,
            gatewayPort: port,
            ...(mode === "lan" ? { gatewayBind: "lan" } : { secretInputMode: "ref" }),
          },
          runtime,
        );
        const cfg = readTestConfig();
        if (mode === "lan") {
          expect(cfg.gateway).toMatchObject({
            bind: "lan",
            port,
            auth: { mode: "token", token: expect.stringMatching(/.{9}/) },
          });
          return;
        }
        expect([cfg.gateway?.auth?.mode, cfg.gateway?.auth?.token]).toEqual([
          "token",
          {
            source: mode === "store-ref" ? "store" : "env",
            provider: "default",
            id: "OPENCLAW_GATEWAY_TOKEN",
          },
        ]);
        // Generated refs need a value; copying an env value would silently outlive its rotation.
        const { readSecretStoreValue } = await import("../secrets/store/secret-store.js");
        const stored = await readSecretStoreValue({
          scope: { kind: "team" },
          name: "OPENCLAW_GATEWAY_TOKEN",
        });
        expect(stored.ok).toBe(mode === "store-ref");
        if (mode === "store-ref") {
          expect(stored.ok && stored.value.length).toBeGreaterThan(8);
        }
      });
    },
    60_000,
  );
});
