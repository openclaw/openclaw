import { describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import { decodeQueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import {
  createOperatorRecoveryFixture,
  expectCurrent,
} from "./operator-run-recovery.test-support.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

type TrustedProxyConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>["trustedProxy"]
>;

function proxyConfig(trustedProxy: Partial<TrustedProxyConfig> = {}): OpenClawConfig {
  return {
    gateway: {
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-proxy-identity",
          allowUsers: ["proxy-operator"],
          ...trustedProxy,
        },
      },
      trustedProxies: ["10.0.0.0/20"],
    },
  };
}

function proxyGeneration(config: OpenClawConfig) {
  return resolveSharedGatewaySessionGeneration(
    resolveGatewayAuthForConfig({ config }),
    config.gateway?.trustedProxies,
  );
}

/** An automation saved by a proxy-authenticated operator, restored after config changes. */
function withSavedProxySource(
  run: (params: {
    changeConfig: (next: OpenClawConfig) => void;
    restoreSaved: () => ReturnType<typeof restoreGatewayQueuedOperatorRecovery>;
  }) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const profile = ensureProfileForEmail("proxy-automation@example.test");
    const config = proxyConfig();
    setRuntimeConfigSnapshot(config);
    const context = createContext();
    const owner = new SharedGatewaySessionGenerationState({
      current: proxyGeneration(config),
      required: null,
    });
    context.sharedGatewaySessionGenerationState = owner;
    const fixture = await createOperatorRecoveryFixture({
      stateDir: state.stateDir,
      context,
      profileId: profile.id,
      config,
      sharedGeneration: proxyGeneration(config),
      trustedProxyUser: "proxy-operator",
    });
    expect(fixture.snapshot.authPolicy?.authMethod).toBe("trusted-proxy");
    expect(fixture.snapshot.sharedGeneration).toBe(proxyGeneration(config));
    // Automations persist this snapshot and decode it after a restart or upgrade.
    const saved = { kind: "gateway" as const, snapshot: structuredClone(fixture.snapshot) };
    await run({
      changeConfig: (next) => {
        setRuntimeConfigSnapshot(next);
        fixture.setConfig(next);
        enforceSharedGatewaySessionGenerationForConfigWrite({
          state: owner,
          nextConfig: next,
          resolveRuntimeSnapshotGeneration: () => proxyGeneration(next),
          clients: [],
        });
        expect(owner.requiredGeneration).toBe(proxyGeneration(next));
      },
      restoreSaved: () =>
        restoreGatewayQueuedOperatorRecovery({
          source: decodeQueuedOperatorRecoverySource(saved),
          context,
          assertCurrent: () => {},
        }),
    });
  });
}

describe("saved proxy-authenticated operator sources", () => {
  it("keep their authority when proxy admission policy tightens", () =>
    withSavedProxySource(async ({ changeConfig, restoreSaved }) => {
      changeConfig(proxyConfig({ requiredHeaders: ["x-proxy-scopes"] }));

      const restored = await restoreSaved();
      try {
        expectCurrent(restored.authority);
      } finally {
        restored.release();
      }
    }));

  it("are refused once the proxy user is no longer allowed", () =>
    withSavedProxySource(async ({ changeConfig, restoreSaved }) => {
      changeConfig(proxyConfig({ allowUsers: ["another-operator"] }));

      await expect(restoreSaved()).rejects.toThrow(GatewayOperatorRecoveryAuthorizationError);
    }));

  it("are refused once the Gateway leaves trusted-proxy authentication", () =>
    withSavedProxySource(async ({ changeConfig, restoreSaved }) => {
      changeConfig({ gateway: { auth: { mode: "token", token: "replacement-token" } } });

      await expect(restoreSaved()).rejects.toThrow(GatewayOperatorRecoveryAuthorizationError);
    }));
});
