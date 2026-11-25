import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { getCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import { withAdminIngress } from "../channels/message-access/operator-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import * as pairingStore from "../infra/device-pairing-store-readonly.js";
import { ensureDeviceToken, rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { getPairedDevice, updatePairedDeviceMetadata } from "../infra/device-pairing.js";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { fenceUserProfileMutationAuthority } from "../state/user-profile-events.js";
import * as profileWrites from "../state/user-profile-writes.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import { retireDeviceTokenClients } from "./device-token-client-lifecycle.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { OperatorRefusalError } from "./operator-refusal.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import { prepareGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import {
  decodeQueuedOperatorRecoverySource,
  normalizeGatewayOperatorRecoverySnapshot,
} from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import {
  captureGatewayOperatorContinuation,
  restoreGatewayOperatorSource,
  restoreGatewayQueuedOperatorRecovery,
} from "./operator-run-recovery.js";
import {
  expectCurrent,
  pairedOperator,
  persistDevices,
  recoveryFixture,
  restoreFixture,
  type RecoveryFixture,
  withRecovery,
} from "./operator-run-recovery.test-support.js";
import {
  captureOperatorToolGatewayContinuationContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-authority.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";

function modelRef(model: string) {
  return { provider: "fixture", model };
}

function acceptedCaller(fixture: RecoveryFixture) {
  const caller = captureGatewayDeviceRevocation(
    fixture.context,
    { deviceId: "recovery-device", role: "operator" },
    () => !fixture.client.invalidated,
  );
  fixture.context.invalidateClientsForDevice = (deviceId, options) => {
    invalidateGatewayDeviceRevocation(fixture.context, deviceId, options?.role);
    fixture.client.invalidated = true;
  };
  return {
    ...caller,
    capture: (invocationAuthority?: { assertCurrent: () => void }) =>
      prepareGatewayOperatorRunAuthority({
        client: captureAgentTurnPrincipal(fixture.client),
        context: fixture.context,
        sourceAuthority: null,
        hasCurrentClientAuthority: caller.isCurrent,
        invocationAuthority,
      }),
  };
}

describe("scheduled authenticated operator source", () => {
  it("records why an admitted operator source cannot survive restart without changing its authority", async () => {
    for (const reason of ["no-auth-method", "device-no-token", "shared-auth-no-generation"]) {
      await withRecovery(async (fixture) => {
        if (reason === "no-auth-method") {
          fixture.client.authPolicy = undefined;
        } else if (reason === "device-no-token") {
          fixture.client.internal!.operatorDeviceTokenIdentity = undefined;
        } else {
          fixture.client.usesSharedGatewayAuth = true;
          fixture.client.sharedGatewaySessionGeneration = undefined;
        }
        const caller = acceptedCaller(fixture);
        const captured = expectDefined(await caller.capture(), "live operator authority");
        using _ = {
          [Symbol.dispose]() {
            captured.release();
            caller.release();
          },
        };
        expect(captured.authority.recoverySnapshot).toBeUndefined();
        const source = captureQueuedOperatorRecoverySource(captured.authority);
        expect(source).toEqual({ kind: "unavailable", reason });
        const serialized = JSON.stringify(source);
        const persisted = decodeQueuedOperatorRecoverySource(JSON.parse(serialized));
        expect(persisted).toEqual(source);
        await expect(
          restoreGatewayQueuedOperatorRecovery({
            source: persisted,
            context: fixture.context,
            assertCurrent() {},
          }),
        ).rejects.toMatchObject({
          constructor: Error,
          message: "Queued operator authority cannot be recovered; submit a new request.",
        });
        const queued = await restoreGatewayQueuedOperatorRecovery({
          source: persisted,
          liveAuthority: captured.authority,
          context: fixture.context,
          assertCurrent() {},
        });
        const continuation = await captureGatewayOperatorContinuation({
          client: {
            ...fixture.client,
            internal: { ...fixture.client.internal, operatorRunAuthority: captured.authority },
          },
          context: fixture.context,
        });
        try {
          expect(queued.authority.scopes).toEqual(["operator.admin"]);
          expect(continuation?.authority.scopes).toEqual(["operator.admin"]);
        } finally {
          queued.release();
          continuation?.release();
        }
      });
    }
  });

  it("decodes legacy unavailable sources and preserves the same recovery refusal", () =>
    withRecovery(async (fixture) => {
      const source = decodeQueuedOperatorRecoverySource({ kind: "unavailable" });
      expect(source).toEqual({ kind: "unavailable" });
      await expect(
        restoreGatewayQueuedOperatorRecovery({
          source,
          context: fixture.context,
          assertCurrent() {},
        }),
      ).rejects.toMatchObject({
        constructor: Error,
        message: "Queued operator authority cannot be recovered; submit a new request.",
      });
    }));

  it("does not derive admitted or recovered policy from an opaque membership label", () =>
    withRecovery(async (fixture, _stateDir, profile) => {
      const principal: OpenClawIdTunnelPrincipal = {
        kind: "member",
        peerKey: `iroh:${"ab".repeat(32)}`,
        accountId: "acct-guest",
        role: "guest",
        authority: { clawId: "claw", rootPub: "root", listedSeq: 1 },
      };
      const role: GatewayOperatorRoleDefinition = {
        scopes: ["operator.admin"],
        agents: ["main"],
        sessions: { others: "view" },
      };
      fixture.setConfig({
        gateway: { openclawId: { enabled: true }, roles: { definitions: { worker: role } } },
      });
      const link = { profileId: profile.id, accountId: principal.accountId, email: null };
      await profileWrites.linkCanonicalOpenClawIdUserProfile(link);
      await profileWrites.setCanonicalUserProfileRole(profile.id, "worker");
      setOpenClawIdMemberAccountLookup((candidate) => candidate === principal.accountId);
      setOpenClawIdTunnelPrincipalLookup(() => principal);
      try {
        fixture.client.internal!.openclawIdPrincipal = principal;
        using caller = {
          ...acceptedCaller(fixture),
          [Symbol.dispose]() {
            this.release();
          },
        };
        using captured = {
          ...expectDefined(await caller.capture(), "member authority"),
          [Symbol.dispose]() {
            this.release();
          },
        };
        const snapshot = expectDefined(
          normalizeGatewayOperatorRecoverySnapshot(captured.authority.recoverySnapshot),
          "opaque role survives recovery decoding",
        );
        expect(snapshot).toMatchObject({
          assignedRole: "worker",
          openclawIdPrincipal: principal,
        });
        using restored = {
          ...(await restoreGatewayOperatorSource({
            snapshot,
            context: fixture.context,
            assertCurrent: () => {},
          })),
          [Symbol.dispose]() {
            this.release();
          },
        };
        expect(restored.authority.rolePolicy).toMatchObject({
          agents: ["main"],
          sessionAccessCap: "view",
        });
      } finally {
        setOpenClawIdTunnelPrincipalLookup(undefined);
        setOpenClawIdMemberAccountLookup(undefined);
      }
    }));

  it.each(["pending", "uncertain"] as const)(
    "keeps admitted profile facts but refuses a new start while mutation is %s",
    (outcome) =>
      withRecovery(async (fixture, _stateDir, profile) => {
        using restored = await restoreFixture(fixture);
        expectCurrent(restored.authority);
        const mutation = fenceUserProfileMutationAuthority(
          captureOpenClawStateWorkerContext({}).admission,
          { profiles: [profile.id], identities: [], channels: [] },
        );
        try {
          if (outcome === "uncertain") {
            mutation.settle(false);
          }
          expectCurrent(restored.authority);
          await expect(fixture.restore()).rejects.toThrow(GatewayOperatorAccessUnavailableError);
          expectCurrent(restored.authority);
        } finally {
          mutation.settle(true);
        }
      }),
  );

  it("lets admitted work finish while the next start checks the authenticated email binding", () =>
    withRecovery(async (fixture, _stateDir, profile) => {
      using restored = await restoreFixture(fixture);
      linkEmail("retained@example.test", profile.id);
      const other = ensureProfileForEmail("other@example.test");
      linkEmail("recovery@example.test", other.id);
      expectCurrent(restored.authority);
      await expect(fixture.restore()).rejects.toThrow();
    }));

  it("gives sibling continuations of one requester one source and keeps them after it settles", () =>
    withRecovery(async (fixture) => {
      const restored = expectDefined(await fixture.restore(), "recovered requester authority");
      const client = createSyntheticPluginRuntimeClient({
        authenticatedUserProfile: fixture.client.authenticatedUserProfile,
        operatorRoleActor: { kind: "operator", profileId: restored.authority.profileId },
        operatorRunAuthority: restored.authority,
        scopes: ["operator.write"],
      });
      const capture = () =>
        withPluginRuntimeGatewayRequestScope(
          { client, context: fixture.context, isWebchatConnect: () => false },
          () =>
            withOperatorToolGatewayAuthority(
              { operatorRunAuthority: restored.authority, scopes: ["operator.write"] },
              async () => await captureOperatorToolGatewayContinuationContext(),
            ),
        );
      const first = expectDefined(await capture(), "first child authority");
      const second = expectDefined(await capture(), "second child authority");
      try {
        expect(first.operatorAuthority?.source).toBe(restored.authority.source);
        expect(second.operatorAuthority?.source).toBe(restored.authority.source);
        fixture.retire();
        restored.release();
        expectCurrent(restored.authority);
        expect(first.assertCurrent).not.toThrow();
        expect(second.assertCurrent).not.toThrow();
        invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
        expect(first.assertCurrent).not.toThrow();
      } finally {
        first.release();
        second.release();
        restored.release();
      }
    }));

  it.each(["current", "owner closed"] as const)(
    "checks the new-start owner after preparation: %s",
    (change) =>
      withRecovery(
        async (fixture, _stateDir, profile) => {
          const snapshot = expectDefined(fixture.snapshot, "authenticated continuation source");
          let current = change === "current";
          const restore = restoreGatewayOperatorSource({
            snapshot,
            context: fixture.context,
            assertCurrent: () => {
              if (!current) {
                throw new Error("Continuation owner closed");
              }
            },
          });
          if (change !== "current") {
            await expect(restore).rejects.toThrow();
            return;
          }
          const restored = await restore;
          try {
            expect(restored.authority).toMatchObject({
              profileId: profile.id,
              scopes: ["operator.write"],
            });
            current = false;
            expectCurrent(restored.authority);
          } finally {
            restored.release();
          }
        },
        { scopes: ["operator.write"] },
      ),
  );
  it("preserves live channel work at recovery bounds and rejects revoked ingress", async () => {
    await withAdminIngress(
      async ({ admins, context, gateway, retire, cfg, activatePolicy, state }) => {
        const admin = expectDefined(admins[0], "linked administrator");
        cfg.agents = { entries: { main: { model: "fixture/permitted" } } };
        const roles = expectDefined(cfg.gateway?.roles, "configured channel roles");
        for (const count of [256, 257]) {
          await activatePolicy({
            roles: {
              ...roles,
              definitions: {
                ...roles.definitions,
                admin: {
                  ...expectDefined(roles.definitions.admin, "administrator role"),
                  modelPolicy: {
                    sourceAgent: "main",
                    allow: ["fixture/*"],
                    deny: Array.from({ length: count }, (_, index) => `fixture/blocked-${index}/*`),
                  },
                },
              },
            },
          });
          const bounded = expectDefined(
            getCommandOwnerAuthority(await context(admin.identity.senderId))?.operatorAuthority,
            "live linked operator with configured model policy",
          );
          const allows = (model: string) =>
            bounded.modelPolicy?.allows({ provider: "fixture", model });
          expect(allows("permitted")).toBe(true);
          expect(allows(`blocked-${count - 1}/test`)).toBe(false);
          const captured = captureQueuedOperatorRecoverySource(bounded);
          const serialized = JSON.stringify(captured);
          const persisted: unknown = JSON.parse(serialized);
          if (count === 256) {
            expect(captured?.kind).toBe("channel");
            const resumed = await restoreGatewayQueuedOperatorRecovery({
              source: decodeQueuedOperatorRecoverySource(persisted),
              context: gateway,
              assertCurrent: () => {},
            });
            try {
              expect(
                resumed.authority.modelPolicy?.allows({ provider: "fixture", model: "permitted" }),
              ).toBe(true);
              expect(
                resumed.authority.modelPolicy?.allows({
                  provider: "fixture",
                  model: "blocked-255/test",
                }),
              ).toBe(false);
            } finally {
              resumed.release();
            }
          } else {
            expect(captured).toEqual({ kind: "unavailable", reason: "decode-failed" });
            await expect(
              restoreGatewayQueuedOperatorRecovery({
                source: decodeQueuedOperatorRecoverySource(persisted),
                context: gateway,
                assertCurrent: () => {},
              }),
            ).rejects.toThrow(
              "Queued operator authority cannot be recovered; submit a new request.",
            );
            await changeCanonicalUserChannelIdentity("unlink", admin.profile.id, admin.identity);
            expect(() => captureQueuedOperatorRecoverySource(bounded)).not.toThrow();
            await changeCanonicalUserChannelIdentity("link", admin.profile.id, admin.identity);
          }
        }
        await activatePolicy({ roles });
        const original = expectDefined(
          getCommandOwnerAuthority(await context(admin.identity.senderId))?.operatorAuthority,
          "authenticated channel operator",
        );
        const source = expectDefined(
          captureQueuedOperatorRecoverySource(original),
          "queued source",
        );
        expect(source.kind).toBe("channel");
        const serializedSource = JSON.stringify(source);
        const persisted: unknown = JSON.parse(serializedSource);
        retire();
        await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
        const restore = () =>
          restoreGatewayQueuedOperatorRecovery({
            source: decodeQueuedOperatorRecoverySource(persisted),
            context: gateway,
            assertCurrent: () => {},
          });
        const restored = await restore();
        try {
          expect(restored.authority.profileId).toBe(admin.profile.id);
          await changeCanonicalUserChannelIdentity("unlink", admin.profile.id, admin.identity);
          await changeCanonicalUserChannelIdentity("link", admin.profile.id, admin.identity);
          expectCurrent(restored.authority);
          await expect(restore()).rejects.toThrow(OperatorRefusalError);
        } finally {
          restored.release();
        }
      },
      "role",
      "slack",
    );
  });

  it("keeps admitted authority independent of chat edits, resets, and deletion", () =>
    withRecovery(async (fixture) => {
      const { agentId, sessionKey, storePath } = fixture.target;
      const restored = await restoreGatewayOperatorSource({
        snapshot: fixture.snapshot,
        context: fixture.context,
        assertCurrent: () => {},
      });
      using _ = { [Symbol.dispose]: restored.release };
      expectCurrent(restored.authority);

      await replaceSessionEntry(
        { agentId, sessionKey: `agent:${agentId}:unrelated`, storePath },
        { sessionId: "unrelated-session", updatedAt: 1 },
      );
      expectCurrent(restored.authority);

      // A message edit or compaction successor gives the same chat a new transcript id.
      await replaceSessionEntry(fixture.target, {
        ...fixture.entry,
        sessionId: "edited-session",
      });
      expectCurrent(restored.authority);

      // A reset rotates the lifecycle revision of the same chat.
      await replaceSessionEntry(fixture.target, {
        ...fixture.entry,
        sessionId: "edited-session",
        lifecycleRevision: "reset-lifecycle",
      });
      expectCurrent(restored.authority);

      await deleteSessionEntryLifecycle({
        archiveTranscript: false,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      expectCurrent(restored.authority);
    }));

  it("keeps restored authority current during unrelated issuance", () =>
    withRecovery(async (fixture, stateDir) => {
      using restored = await restoreFixture(fixture);

      await issueDeviceBootstrapToken({ baseDir: stateDir });
      expectCurrent(restored.authority);
    }));

  it("keeps a tokenless live request when pairing evidence cannot be read for capture", () =>
    withRecovery(
      async (fixture) => {
        const read = vi
          .spyOn(pairingStore, "loadPairedDevicePairingStoreRecordReadOnly")
          .mockRejectedValueOnce(new Error("synthetic pairing store unavailable"));
        const caller = acceptedCaller(fixture);
        try {
          const admitted = expectDefined(await caller.capture(), "live operator");
          try {
            expect(admitted.authority.recoverySnapshot).toBeUndefined();
            expect(admitted.authority.recoverySnapshotUnavailableReason).toBe("device-no-token");
            expect(admitted.authority.device).toBeUndefined();
            expectCurrent(admitted.authority);
          } finally {
            admitted.release();
          }
        } finally {
          read.mockRestore();
          caller.release();
        }
      },
      { tokenlessDevice: true },
    ));

  it("preserves a tokenless shared-token source without capture-time pairing I/O", () =>
    withRecovery(
      async (fixture) => {
        // The connect producer returns null for an attested tokenless handshake;
        // undefined instead means missing capture evidence, as covered above.
        fixture.client.internal!.operatorDeviceTokenIdentity = null;
        fixture.context.sharedGatewaySessionGenerationState =
          new SharedGatewaySessionGenerationState({
            current: expectDefined(
              fixture.client.sharedGatewaySessionGeneration,
              "shared credential generation",
            ),
            required: null,
          });
        const caller = acceptedCaller(fixture);
        try {
          const before = expectDefined(await caller.capture(), "tokenless shared-token operator");
          let snapshot: typeof fixture.snapshot;
          try {
            snapshot = expectDefined(
              before.authority.recoverySnapshot,
              "durable shared-token source",
            );
            expect(snapshot).toMatchObject({
              authPolicy: { authMethod: "token" },
              scopes: ["operator.admin"],
              sharedGeneration: "original-credential-generation",
            });
            expect(snapshot.device).toBeUndefined();
          } finally {
            before.release();
          }
          const read = vi
            .spyOn(pairingStore, "loadPairedDevicePairingStoreRecordReadOnly")
            .mockRejectedValue(new Error("synthetic pairing store unavailable"));
          try {
            const admitted = expectDefined(await caller.capture(), "live shared-token operator");
            try {
              expect(admitted.authority.recoverySnapshot).toEqual(snapshot);
              expect(admitted.authority.recoverySnapshotUnavailableReason).toBeUndefined();
              expectCurrent(admitted.authority);
              expect(read).not.toHaveBeenCalled();
            } finally {
              admitted.release();
            }
          } finally {
            read.mockRestore();
          }
        } finally {
          caller.release();
        }
      },
      { sharedGeneration: "original-credential-generation" },
    ));

  it("does not adopt an incidental paired token for tokenless trusted-proxy ingress", () =>
    withRecovery(
      async (fixture) => {
        expect(fixture.snapshot.device).toMatchObject({ deviceId: "recovery-device" });
        using restored = await restoreFixture(fixture);

        expect(
          (await rotateDeviceToken({ deviceId: "recovery-device", role: "operator" })).ok,
        ).toBe(true);
        expectCurrent(restored.authority);
        using next = await restoreFixture(fixture);
        expectCurrent(next.authority);
      },
      { tokenlessDevice: true },
    ));
  it("recovers a source with a handshake-attested OpenClaw ID origin marker", () =>
    withRecovery(async (fixture) => {
      fixture.client.authPolicy = captureGatewayAuthPolicy(fixture.context.getRuntimeConfig(), {
        ...fixture.client.authPolicy,
        browserOrigin: {
          requestHost: "localhost",
          origin: "http://localhost",
          isLocalClient: true,
          openclawIdTunnel: true,
        },
      });
      const caller = acceptedCaller(fixture);
      const captured = expectDefined(await caller.capture(), "captured source");
      try {
        const source = expectDefined(
          captureQueuedOperatorRecoverySource(captured.authority),
          "captured recovery source",
        );
        expect(source.kind).toBe("gateway");
        const restored = await restoreGatewayQueuedOperatorRecovery({
          source,
          context: fixture.context,
          assertCurrent: () => {},
        });
        try {
          expectCurrent(restored.authority);
        } finally {
          restored.release();
        }
      } finally {
        captured.release();
        caller.release();
      }
    }));
  it.each(["before capture", "after admission", "after restoration"] as const)(
    "checks device retirement at new capture and restored owners while retaining admitted work (%s)",
    (timing) =>
      withRecovery(async (fixture) => {
        const caller = acceptedCaller(fixture);
        const source =
          timing === "after restoration"
            ? expectDefined(await fixture.restore(), "restored device source")
            : timing === "after admission"
              ? expectDefined(await caller.capture(), "accepted exact original token")
              : undefined;
        try {
          const rotated = await rotateDeviceToken({
            deviceId: "recovery-device",
            role: "operator",
          });
          expect(rotated.ok).toBe(true);
          retireDeviceTokenClients(
            fixture.context,
            "recovery-device",
            ["operator"],
            "device-token-rotated",
          );
          expect(fixture.client.invalidated).toBe(true);
          if (source) {
            expectCurrent(source.authority);
            if (timing === "after restoration") {
              await expect(fixture.restore()).rejects.toThrow();
            }
          } else {
            await expect(caller.capture()).rejects.toThrow("Gateway request could not start");
          }
        } finally {
          source?.release();
          caller.release();
        }
      }),
  );
  it.each(["before restoration", "after restoration"] as const)(
    "checks the original credential when a same-device handshake reissues its token %s",
    (timing) =>
      withRecovery(async (fixture) => {
        const restored =
          timing === "after restoration"
            ? expectDefined(await fixture.restore(), "original device source")
            : undefined;
        using _ = restored ? { [Symbol.dispose]: restored.release } : undefined;

        expect(
          await ensureDeviceToken({
            deviceId: "recovery-device",
            role: "operator",
            scopes: ["operator.admin"],
            issuer: { kind: "shared-gateway-auth", generation: "replacement-issuer" },
          }),
        ).not.toBeNull();
        if (restored) {
          expectCurrent(restored.authority);
        } else {
          await expect(fixture.restore()).rejects.toThrow(OperatorRefusalError);
        }
      }),
  );
  it("keeps accepted device authority through pairing changes and device retirement", () =>
    withRecovery(async (fixture, stateDir) => {
      const device = pairedOperator();
      const caller = acceptedCaller(fixture);
      const accepted = expectDefined(await caller.capture(), "accepted paired operator");
      try {
        // A sibling owner changes the revision before a partial lookup publishes it.
        const unrelated = { ...pairedOperator(), deviceId: "unrelated-device" };
        persistDevices(stateDir, [device, unrelated], "paired");
        expect((await getPairedDevice(unrelated.deviceId))?.deviceId).toBe(unrelated.deviceId);
        expectCurrent(accepted.authority);
        expect(
          await updatePairedDeviceMetadata(unrelated.deviceId, { displayName: "Renamed" }),
        ).toBe(true);
        expectCurrent(accepted.authority);
        retireDeviceTokenClients(
          fixture.context,
          device.deviceId,
          ["operator"],
          "device-token-revoked",
        );
        expect(fixture.client.invalidated).toBe(true);
        expectCurrent(accepted.authority);
        await expect(caller.capture()).rejects.toThrow();
      } finally {
        accepted.release();
        caller.release();
      }
    }));
  it("preserves the requester's write scope after restart without exporting credentials", () =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const profile = ensureProfileForEmail("recovery@example.test");
      const fixture = await recoveryFixture(state.stateDir, profile.id, {
        device: pairedOperator(),
        scopes: ["operator.write"],
      });
      expect(fixture.sourceAuthority.retain).toThrow("Operator execution ended.");
      expect(fixture.snapshot).toMatchObject({
        controlUiAdmin: false,
        sourceIngress: "control-ui",
      });
      const serialized = JSON.stringify(fixture.snapshot);
      expect(serialized).not.toContain("fixture-device-token");
      expect(serialized).not.toContain("fixture-signature");
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
      const restored = await restoreGatewayOperatorSource({
        snapshot: expectDefined(
          normalizeGatewayOperatorRecoverySnapshot(JSON.parse(serialized)),
          "persisted authenticated requester",
        ),
        context: fixture.context,
        assertCurrent() {},
      });
      using _ = { [Symbol.dispose]: restored.release };

      expect(restored.authority).toMatchObject({
        scopes: ["operator.write"],
        profileId: profile.id,
      });
    }));

  it.each(["profile merge", "role changed", "token rotated", "approval scopes narrowed"] as const)(
    "refuses current-policy re-admission after %s",
    (change) =>
      withRecovery(async (fixture, stateDir) => {
        const device = pairedOperator();
        if (change === "profile merge") {
          const target = ensureProfileForEmail("merged@example.test");
          linkEmail("recovery@example.test", target.id);
        } else if (change === "role changed") {
          fixture.setConfig({
            gateway: {
              roles: {
                default: "blocked",
                definitions: { blocked: { agents: "*", sessions: { others: "none" }, scopes: [] } },
              },
            },
          });
        } else {
          const token = expectDefined(device.tokens?.operator, "operator token");
          if (change === "token rotated") {
            token.token = "rotated-fixture-token";
          }
          if (change === "approval scopes narrowed") {
            device.approvedScopes = ["operator.read"];
          }
          persistDevices(stateDir, [device], "both");
        }
        await expect(fixture.restore()).rejects.toThrow();
      }),
  );

  it("keeps admitted facts while the next start checks a retired claim", () =>
    withRecovery(async (fixture) => {
      using restored = await restoreFixture(fixture);
      fixture.retire();
      expectCurrent(restored.authority);
      await expect(fixture.restore()).rejects.toThrow();
      expectCurrent(restored.authority);
    }));

  it.each(["gateway", "runtime"])(
    "keeps admitted source policy through %s publication",
    (publication) =>
      withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const profile = ensureProfileForEmail("role-recovery@example.test");
        const operator: GatewayOperatorRoleDefinition = {
          agents: "*",
          sessions: { others: "none" },
          scopes: ["operator.admin"],
        };
        const cfg: OpenClawConfig = {
          gateway: { roles: { default: "operator", definitions: { operator } } },
        };
        const publish = () =>
          publication === "gateway"
            ? publishOperatorRoleConfigChange(fixture.context)
            : setRuntimeConfigSnapshot(fixture.context.getRuntimeConfig());
        const fixture = await recoveryFixture(state.stateDir, profile.id, {
          config: cfg,
          scopes: ["operator.write"],
        });
        const current = structuredClone(cfg);
        current.gateway!.roles!.definitions.operator!.scopes = ["operator.write"];
        fixture.setConfig(current);
        using restored = await restoreFixture(fixture);

        expect(restored.authority.scopes).toEqual(["operator.write"]);
        const widened = structuredClone(cfg);
        fixture.setConfig(widened);
        publish();
        expectCurrent(restored.authority);
        // A later publication applies to the next restoration, even with the same config object.
        widened.gateway!.roles!.definitions.operator!.scopes = ["operator.read"];
        publish();
        expect(restored.authority.signal?.aborted).not.toBe(true);
        expectCurrent(restored.authority);
        // Admission narrows to read; a read-only requester starts no new chat-like work.
        await expect(fixture.restore()).rejects.toThrow(OperatorRefusalError);
        fixture.setConfig(cfg);
        publish();
        expectCurrent(restored.authority);
      }),
  );

  it("intersects the original model ceiling with current policy without widening the admitted role", () =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("model@example.test");
      setUserProfileRole(profile.id, "operator");
      const operator = {
        sessions: { others: "none" },
        agents: ["main"],
        scopes: ["operator.admin"],
        sandbox: "required",
        modelPolicy: { allow: ["fixture/a", "fixture/b"] },
      } satisfies GatewayOperatorRoleDefinition;
      const cfg = {
        agents: { defaults: { model: "fixture/a" } },
        gateway: { roles: { default: "operator", definitions: { operator } } },
      } satisfies OpenClawConfig;
      const fixture = await recoveryFixture(state.stateDir, profile.id, {
        config: cfg,
      });
      const current = structuredClone(cfg);
      current.gateway.roles.definitions.operator.modelPolicy = {
        allow: ["fixture/b", "fixture/c"],
      };
      fixture.setConfig(current);
      const restored = expectDefined(await fixture.restore(), "model-restricted recovery");
      using _ = { [Symbol.dispose]: restored.release };

      expect(restored.authority.rolePolicy).toMatchObject({
        agents: ["main"],
        sandboxRequired: true,
        sessionAccessCap: "none",
      });
      expect(restored.authority.modelPolicy?.allows(modelRef("a"))).toBe(false);
      expect(restored.authority.modelPolicy?.allows(modelRef("b"))).toBe(true);
      expect(restored.authority.modelPolicy?.allows(modelRef("c"))).toBe(false);
      const widened = structuredClone(current);
      widened.gateway.roles.definitions.operator.modelPolicy = {
        allow: ["fixture/a", "fixture/b", "fixture/c"],
      };
      fixture.setConfig(widened);
      expect(restored.authority.modelPolicy?.models).toEqual([modelRef("b")]);
      expectCurrent(restored.authority);
      const next = expectDefined(await fixture.restore(), "fresh model-policy admission");
      try {
        expect(next.authority.modelPolicy?.models).toEqual([modelRef("a"), modelRef("b")]);
      } finally {
        next.release();
      }
    }));
});

it.each(["connection", "stop", "revocation"] as const)(
  "checks queued recovery start after original socket closure (%s)",
  (change) =>
    withRecovery(async (fixture, _stateDir, profile) => {
      const connection = new AbortController();
      Object.assign(fixture.client, { connectionSignal: connection.signal });
      const stop = new AbortController();
      const restored = await restoreGatewayOperatorSource({
        snapshot: fixture.snapshot,
        context: fixture.context,
        // The new start owns cancellation; the old socket is not its authority.
        assertCurrent: () => stop.signal.throwIfAborted(),
      });
      using _ = { [Symbol.dispose]: restored.release };
      const runId = `queued-recovery-${change}`;
      const operationalRunInstance = createOperationalRunInstanceRef(runId);
      const prepared = prepareAgentRunAdmission({
        cfg: fixture.context.getRuntimeConfig(),
        operatorAuthority: restored.authority,
        operationalRunInstance,
        assertSourceCurrent: () => stop.signal.throwIfAborted(),
        facts: {
          runId,
          agentId: fixture.target.agentId,
          ingress: { kind: "system", boundary: "queued-recovery", state: "present" },
        },
      });
      try {
        connection.abort(new Error("Original socket closed"));
        if (change === "stop") {
          stop.abort(new Error("Stop requested"));
        } else if (change === "revocation") {
          setUserProfileRole(profile.id, "revoked-role");
        }
        if (change !== "stop") {
          expect((await prepared.admit("embedded")).operationalRunInstance).toBe(
            operationalRunInstance,
          );
        } else {
          await expect(prepared.admit("embedded")).rejects.toThrow();
        }
      } finally {
        prepared.close();
      }
    }),
);
