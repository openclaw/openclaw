import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { buildRestartRecoveryExpectedState } from "../config/sessions/session-transcript-turn-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import { persistDevicePairingStoreState } from "../infra/device-pairing-store.js";
import { ensureDeviceToken, rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import type { PluginGatewayAccessPolicy } from "../plugins/gateway-access-policy.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";

function pairedOperator(): PairedDevice {
  return {
    deviceId: "recovery-device",
    publicKey: "fixture-public-key",
    roles: ["operator"],
    approvedScopes: ["operator.admin"],
    tokens: {
      operator: {
        token: "fixture-device-token",
        role: "operator",
        scopes: ["operator.admin"],
        createdAtMs: 1,
      },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

describe("restart recovery authenticated operator source", () => {
  it.each(["unrelated issuance", "publication close"] as const)(
    "tracks exact pairing publication during %s",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const profile = ensureProfileForEmail("publication-lifetime@example.test");
        const fixture = await createOperatorRecoveryFixture({
          stateDir: state.stateDir,
          context: createContext(),
          profileId: profile.id,
          config: {},
          device: pairedOperator(),
        });
        const restored = expectDefined(await fixture.restore(), "exact device source");
        try {
          if (change === "unrelated issuance") {
            await issueDeviceBootstrapToken({ baseDir: state.stateDir });
            expect(restored.authority.signal?.aborted).toBe(false);
            expect(restored.authority.assertCurrent).not.toThrow();
          } else {
            await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath());
            expect(restored.authority.signal?.aborted).toBe(true);
            expect(restored.authority.assertCurrent).toThrow();
          }
        } finally {
          restored.release();
        }
      });
    },
  );
  it("does not adopt an incidental paired token for tokenless trusted-proxy ingress", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("proxy-source@example.test");
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: {},
        device: pairedOperator(),
        tokenlessDevice: true,
      });
      expect(fixture.entry.restartRecoveryOperatorSource?.snapshot.device).toBeUndefined();
      const restored = expectDefined(await fixture.restore(), "proxy-owned source");
      try {
        expect(
          (await rotateDeviceToken({ deviceId: "recovery-device", role: "operator" })).ok,
        ).toBe(true);
        expect(restored.authority.signal?.aborted).toBe(false);
        expect(restored.authority.assertCurrent).not.toThrow();
      } finally {
        restored.release();
      }
    });
  });
  it.each(["before capture", "after admission", "after restoration"] as const)(
    "does not adopt a replacement device token %s without Gateway retirement",
    async (timing) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const profile = ensureProfileForEmail("exact-token@example.test");
        const fixture = await createOperatorRecoveryFixture({
          stateDir: state.stateDir,
          context: createContext(),
          profileId: profile.id,
          config: {},
          device: pairedOperator(),
        });
        const restored =
          timing === "after restoration"
            ? expectDefined(await fixture.restore(), "restored device source")
            : undefined;
        const accepted =
          timing === "after admission"
            ? expectDefined(
                await captureGatewayOperatorRunAuthority({
                  client: captureAgentTurnPrincipal(fixture.client),
                  context: fixture.context,
                  sourceAuthority: null,
                }),
                "accepted exact original token",
              )
            : undefined;
        try {
          const rotated = await rotateDeviceToken({
            deviceId: "recovery-device",
            role: "operator",
          });
          expect(rotated.ok).toBe(true);
          const source = restored ?? accepted;
          if (source) {
            expect(source.authority.signal?.aborted).toBe(true);
            expect(source.authority.assertCurrent).toThrow();
          } else {
            await expect(
              captureGatewayOperatorRunAuthority({
                client: captureAgentTurnPrincipal(fixture.client),
                context: fixture.context,
                sourceAuthority: null,
              }),
            ).rejects.toThrow("original current pairing publication");
          }
        } finally {
          restored?.release();
          accepted?.release();
        }
      });
    },
  );
  it("retires restored authority when a later handshake replaces its token issuer", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("issuer-replacement@example.test");
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: {},
        device: pairedOperator(),
      });
      const restored = expectDefined(await fixture.restore(), "original device source");
      try {
        expect(
          await ensureDeviceToken({
            deviceId: "recovery-device",
            role: "operator",
            scopes: ["operator.admin"],
            issuer: { kind: "shared-gateway-auth", generation: "replacement-issuer" },
          }),
        ).not.toBeNull();
        expect(restored.authority.signal?.aborted).toBe(true);
        expect(restored.authority.assertCurrent).toThrow();
      } finally {
        restored.release();
      }
    });
  });
  it.each(["before restoration", "after admission"] as const)(
    "refuses recovery after shared credentials rotate %s",
    async (timing) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const profile = ensureProfileForEmail("shared-generation@example.test");
        const context = createContext();
        const generation = "original-credential-generation";
        const owner = new SharedGatewaySessionGenerationState({
          current: generation,
          required: null,
        });
        context.sharedGatewaySessionGenerationState = owner;
        const fixture = await createOperatorRecoveryFixture({
          stateDir: state.stateDir,
          context,
          profileId: profile.id,
          config: {},
          sharedGeneration: generation,
        });
        const restored =
          timing === "after admission"
            ? expectDefined(await fixture.restore(), "accepted shared credential source")
            : undefined;
        try {
          enforceSharedGatewaySessionGenerationForConfigWrite({
            state: owner,
            nextConfig: {},
            resolveRuntimeSnapshotGeneration: () => "replacement-credential-generation",
            clients: [],
          });
          if (restored) {
            expect(restored.authority.signal?.aborted).toBe(true);
            expect(restored.authority.assertCurrent).toThrow("authority changed");
            owner.publish({ current: generation, required: null });
            expect(restored.authority.assertCurrent).toThrow("authority changed");
          } else {
            await expect(fixture.restore()).rejects.toThrow("authentication owner changed");
          }
        } finally {
          restored?.release();
        }
      });
    },
  );
  it("requires the original access-plugin grant before restoration and after admission", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const original = { pluginId: "recovery-access", grantId: "original-accepted-grant" };
      let permitted = true;
      const controller = new AbortController();
      const grant = {
        grantId: original.grantId,
        signal: controller.signal,
        assertCurrent: () => controller.signal.throwIfAborted(),
      };
      const resume = vi.fn<NonNullable<PluginGatewayAccessPolicy["resume"]>>(() =>
        permitted ? grant : undefined,
      );
      const registry = createEmptyPluginRegistry();
      registry.plugins.push(createPluginRecord({ id: original.pluginId }));
      registry.gatewayAccessPolicies.push({
        pluginId: original.pluginId,
        source: "fixture",
        policy: { authorize: () => grant, resume },
      });
      const previous = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(registry, null, "default");
      try {
        const profile = ensureProfileForEmail("access@example.test");
        const fixture = await createOperatorRecoveryFixture({
          stateDir: state.stateDir,
          context: createContext(),
          profileId: profile.id,
          config: {},
          gatewayAccessGrant: original,
        });
        permitted = false;
        await expect(fixture.restore()).rejects.toThrow("Gateway access is not active");
        permitted = true;
        const restored = expectDefined(await fixture.restore(), "restored original grant");
        try {
          expect(restored.authority.gatewayAccessGrant).toEqual(original);
          expect(resume).toHaveBeenCalledWith(
            expect.objectContaining({ grantId: original.grantId }),
          );
          controller.abort(new Error("Original grant revoked"));
          expect(restored.authority.signal?.aborted).toBe(true);
          expect(restored.authority.assertCurrent).toThrow();
        } finally {
          restored.release();
        }
      } finally {
        restoreActivePluginRegistrySnapshot(previous);
      }
    });
  });
  it("re-admits durable input after the original authority closes without exporting credentials", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("recovery@example.test");
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: {},
        device: pairedOperator(),
        scopes: ["operator.write"],
      });
      expect(fixture.sourceAuthority.assertCurrent).toThrow("no longer active");
      expect(fixture.entry.restartRecoveryOperatorSource?.snapshot).toMatchObject({
        controlUiAdmin: false,
        sourceIngress: "control-ui",
      });
      const serialized = JSON.stringify(fixture.entry.restartRecoveryOperatorSource);
      expect(serialized).not.toContain("fixture-device-token");
      expect(serialized).not.toContain("fixture-signature");
      const admitted = await persistSessionTranscriptTurn(fixture.target, {
        expectedSessionId: fixture.target.sessionId,
        expectedSessionState: buildRestartRecoveryExpectedState(fixture.entry),
        messages: [
          {
            idempotencyLookup: "scan",
            message: {
              role: "user",
              content: "Continue accepted work",
              idempotencyKey: "serialized-source:user",
              timestamp: 1,
            },
          },
        ],
        updateMode: "none",
      });
      expect(admitted.appendedCount).toBe(1);
      expect(admitted.rejectedReason).toBeUndefined();
      const restored = expectDefined(await fixture.restore(), "restored operator source");
      try {
        expect(restored.authority.scopes).toEqual(["operator.write"]);
        expect(restored.authority.profileId).toBe(profile.id);
        expect(restored.authority.assertCurrent).not.toThrow();
        const retain = expectDefined(restored.authority.retain, "recovery retention")();
        restored.release();
        expect(restored.authority.assertCurrent).not.toThrow();
        retain();
        expect(restored.authority.assertCurrent).toThrow("no longer active");
      } finally {
        restored.release();
      }
    });
  });

  it.each([
    "legacy claim",
    "different source turn",
    "different session",
    "different lifecycle",
  ] as const)("never reconstructs authorization from attribution for a %s", async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("claim@example.test");
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: {},
      });
      const changed = { ...fixture.entry };
      if (change === "legacy claim") {
        changed.restartRecoveryOperatorSource = undefined;
      } else if (change === "different source turn") {
        changed.restartRecoveryDeliverySourceRunId = "another-turn";
      } else if (change === "different session") {
        changed.sessionId = "replacement-session";
      } else {
        changed.lifecycleRevision = "replacement-lifecycle";
      }
      await replaceSessionEntry(fixture.target, changed);
      if (change === "legacy claim") {
        await expect(fixture.restore()).resolves.toBeUndefined();
      } else {
        await expect(fixture.restore()).rejects.toThrow(/no longer owns|no longer active/);
      }
    });
  });

  it.each([
    "profile merge",
    "role changed",
    "device removed",
    "token revoked",
    "token rotated",
    "token scopes narrowed",
    "approval scopes narrowed",
  ] as const)("refuses current-policy re-admission after %s", async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("policy@example.test");
      const device = pairedOperator();
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: {},
        device,
      });
      if (change === "profile merge") {
        const target = ensureProfileForEmail("merged@example.test");
        linkEmail("policy@example.test", target.id);
      } else if (change === "role changed") {
        setUserProfileRole(profile.id, "new-role");
      } else {
        const token = expectDefined(device.tokens?.operator, "operator token");
        if (change === "token revoked") {
          token.revokedAtMs = 2;
        }
        if (change === "token rotated") {
          token.token = "rotated-fixture-token";
        }
        if (change === "token scopes narrowed") {
          token.scopes = ["operator.read"];
        }
        if (change === "approval scopes narrowed") {
          device.approvedScopes = ["operator.read"];
        }
        persistDevicePairingStoreState(
          {
            pendingById: {},
            pairedByDeviceId: change === "device removed" ? {} : { [device.deviceId]: device },
          },
          state.stateDir,
          "both",
        );
      }
      await expect(fixture.restore()).rejects.toThrow(
        /Restart recovery operator|user profile not found/,
      );
    });
  });

  it.each(["claim retired", "device revoked", "session replaced"] as const)(
    "fences retained recovered authority after %s",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const profile = ensureProfileForEmail("retained@example.test");
        const fixture = await createOperatorRecoveryFixture({
          stateDir: state.stateDir,
          context: createContext(),
          profileId: profile.id,
          config: {},
          device: pairedOperator(),
        });
        const restored = expectDefined(await fixture.restore(), "restored operator source");
        try {
          if (change === "claim retired") {
            fixture.retire();
          }
          if (change === "device revoked") {
            invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
          }
          if (change === "session replaced") {
            await replaceSessionEntry(fixture.target, {
              ...fixture.entry,
              sessionId: "replacement-session",
            });
          }
          expect(restored.authority.assertCurrent).toThrow();
        } finally {
          restored.release();
        }
      });
    },
  );

  it("intersects the original model ceiling with current policy without widening the admitted role", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("model@example.test");
      setUserProfileRole(profile.id, "operator");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "fixture/a" } },
        gateway: {
          roles: {
            definitions: {
              operator: {
                sessions: { others: "none" },
                agents: ["main"],
                scopes: ["operator.admin"],
                sandbox: "required",
                accessPolicyPlugin: undefined,
                modelPolicy: { allow: ["fixture/a", "fixture/b"] },
              },
            },
          },
        },
      };
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: cfg,
      });
      const current = structuredClone(cfg);
      expectDefined(current.gateway?.roles?.definitions.operator, "operator role").modelPolicy = {
        allow: ["fixture/b", "fixture/c"],
      };
      fixture.setConfig(current);
      const restored = expectDefined(await fixture.restore(), "model-restricted recovery");
      try {
        expect(restored.authority.rolePolicy).toMatchObject({
          agents: ["main"],
          sandboxRequired: true,
          sessionAccessCap: "none",
        });
        expect(restored.authority.modelPolicy?.allows({ provider: "fixture", model: "a" })).toBe(
          false,
        );
        expect(restored.authority.modelPolicy?.allows({ provider: "fixture", model: "b" })).toBe(
          true,
        );
        expect(restored.authority.modelPolicy?.allows({ provider: "fixture", model: "c" })).toBe(
          false,
        );
      } finally {
        restored.release();
      }
    });
  });
});
