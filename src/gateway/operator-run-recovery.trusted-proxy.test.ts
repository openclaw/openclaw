import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import { OperatorRefusalError } from "./operator-refusal.js";
import { prepareGatewayOperatorRunAuthority } from "./operator-run-authority.js";
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
        identityScopes: { "proxy-operator": ["operator.admin"] },
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
  it("admits new work when handshake header requirements tighten", () =>
    withSavedProxySource(async ({ changeConfig, restoreSaved }) => {
      changeConfig(proxyConfig({ requiredHeaders: ["x-proxy-scopes"] }));
      const restored = await restoreSaved();
      try {
        expectCurrent(restored.authority);
      } finally {
        restored.release();
      }
    }));

  it("require a current identity grant when no device token supplies scopes", () =>
    withSavedProxySource(async ({ changeConfig, restoreSaved }) => {
      const next = proxyConfig();
      next.gateway!.auth!.identityScopes = {};
      changeConfig(next);

      await expect(restoreSaved()).rejects.toThrow(OperatorRefusalError);
    }));
});

it.each([
  { change: "rotated", savedFormat: "captured" },
  { change: "removed", savedFormat: "captured" },
  { change: "rotated", savedFormat: "legacy" },
  { change: "removed", savedFormat: "legacy" },
] as const)(
  "refuses $savedFormat password-fallback starts after the credential is $change without cancelling admitted work",
  async ({ change, savedFormat }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = proxyConfig();
      config.gateway!.auth!.password = "fixture-original-password";
      setRuntimeConfigSnapshot(config);
      const profile = ensureProfileForEmail("fallback-automation@example.test");
      const context = createContext();
      const generation = proxyGeneration(config);
      const owner = new SharedGatewaySessionGenerationState({
        current: generation,
        required: null,
      });
      context.sharedGatewaySessionGenerationState = owner;
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context,
        profileId: profile.id,
        config,
        sharedGeneration: generation,
      });
      fixture.client.authPolicy = captureGatewayAuthPolicy(config, {
        role: "operator",
        authMethod: "password",
      });
      const captured = expectDefined(
        await prepareGatewayOperatorRunAuthority({
          client: captureAgentTurnPrincipal(fixture.client),
          context,
          sourceAuthority: null,
        }),
        "password-fallback authority",
      );
      using _ = { [Symbol.dispose]: captured.release };
      const snapshot = structuredClone(
        expectDefined(captured.authority.recoverySnapshot, "saved password-fallback source"),
      );
      expect(snapshot.authPolicy?.fallbackCredentialGeneration).toEqual(expect.any(String));
      if (savedFormat === "legacy" && snapshot.authPolicy) {
        delete snapshot.authPolicy.fallbackCredentialGeneration;
      }
      const source = decodeQueuedOperatorRecoverySource({ kind: "gateway", snapshot });
      const admitted = await restoreGatewayQueuedOperatorRecovery({
        source,
        context,
        assertCurrent() {},
      });
      try {
        const next = proxyConfig();
        if (change === "rotated") {
          next.gateway!.auth!.password = "fixture-replacement-password";
        }
        setRuntimeConfigSnapshot(next);
        fixture.setConfig(next);
        enforceSharedGatewaySessionGenerationForConfigWrite({
          state: owner,
          nextConfig: next,
          resolveRuntimeSnapshotGeneration: () => proxyGeneration(next),
          clients: [],
        });
        // The proxy generation deliberately does not identify its local fallback password.
        expect(owner.requiredGeneration).toBe(generation);
        await expect(
          restoreGatewayQueuedOperatorRecovery({ source, context, assertCurrent() {} }),
        ).rejects.toThrow(OperatorRefusalError);
        expectCurrent(admitted.authority);
      } finally {
        admitted.release();
      }
    });
  },
);
