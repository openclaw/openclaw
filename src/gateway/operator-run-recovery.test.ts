import { expectDefined } from "@openclaw/normalization-core";
import * as stableJson from "@openclaw/normalization-core/stable-stringify";
import { describe, expect, it, vi } from "vitest";
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
import { ensureDeviceToken, rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { getPairedDevice, updatePairedDeviceMetadata } from "../infra/device-pairing.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { fenceUserProfileMutationAuthority } from "../state/user-profile-events.js";
import * as profileReader from "../state/user-profile-list.js";
import { setCanonicalUserProfileDisplayName } from "../state/user-profile-writes.js";
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
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import * as sourcePolicy from "./operator-role-source-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
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
  createOperatorRecoveryFixture,
  expectCurrent,
  expectRevoked,
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
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";

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
    capture: () =>
      captureGatewayOperatorRunAuthority({
        client: captureAgentTurnPrincipal(fixture.client),
        context: fixture.context,
        sourceAuthority: null,
        hasCurrentClientAuthority: caller.isCurrent,
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
        expect(captured.authority.assertCurrent).not.toThrow();
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

  it("refuses retained and recovered runs for an opaque role with no Gateway policy", () =>
    withRecovery(async (fixture) => {
      const principal: OpenClawIdTunnelPrincipal = {
        kind: "member",
        peerKey: `iroh:${"ab".repeat(32)}`,
        accountId: "acct-guest",
        role: "guest",
        authority: { clawId: "claw", rootPub: "root", listedSeq: 1 },
      };
      setOpenClawIdTunnelPrincipalLookup(() => principal);
      try {
        fixture.client.internal!.openclawIdPrincipal = principal;
        const caller = acceptedCaller(fixture);
        try {
          await expect(caller.capture()).rejects.toThrow(/authority/);
        } finally {
          caller.release();
        }
        const snapshot = expectDefined(
          normalizeGatewayOperatorRecoverySnapshot({
            ...fixture.snapshot,
            openclawIdPrincipal: principal,
          }),
          "opaque role survives recovery decoding",
        );
        expect(snapshot.openclawIdPrincipal).toEqual(principal);
        await expect(
          restoreGatewayOperatorSource({
            snapshot,
            target: fixture.target,
            context: fixture.context,
            assertCurrent: () => {},
          }),
        ).rejects.toThrow("OpenClaw ID membership authority changed");
      } finally {
        setOpenClawIdTunnelPrincipalLookup(undefined);
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
          expect(restored.authority.reauthorize).toThrow();
          expectCurrent(restored.authority);
        } finally {
          mutation.settle(true);
        }
      }),
  );

  it("keeps admitted profile facts while the next restoration checks changed bindings", () =>
    withRecovery(async (fixture, _stateDir, profile) => {
      const prepare = profileReader.prepareUserProfileIdentity;
      const reads = vi.fn();
      const preparation = vi
        .spyOn(profileReader, "prepareUserProfileIdentity")
        .mockImplementation(async (...args) => {
          const identity = await prepare(...args);
          const read = identity.readCurrentFacts;
          vi.spyOn(identity, "readCurrentFacts").mockImplementation((...inputs) => {
            reads();
            return read(...inputs);
          });
          return identity;
        });
      try {
        using restored = await restoreFixture(fixture);
        expect(reads).toHaveBeenCalledTimes(1);
        reads.mockClear();
        for (let i = 0; i < 10; i++) {
          restored.authority.assertCurrent();
          restored.assertPolicyCurrent();
        }
        const other = ensureProfileForEmail("other@example.test");
        expectCurrent(restored.authority);
        expect(reads).not.toHaveBeenCalled();

        await setCanonicalUserProfileDisplayName(profile.id, "Updated display");
        expectCurrent(restored.authority);
        expect(reads).not.toHaveBeenCalled();
        reads.mockClear();
        linkEmail("additional@example.test", profile.id);
        expectCurrent(restored.authority);
        expect(reads).not.toHaveBeenCalled();

        linkEmail("recovery@example.test", other.id);
        expectCurrent(restored.authority);
        await expect(fixture.restore()).rejects.toThrow();
        linkEmail("recovery@example.test", profile.id);
        expectCurrent(restored.authority);
      } finally {
        preparation.mockRestore();
      }
    }));

  it("keeps the admitted auth policy and refuses a fresh restoration after a changed grant", () =>
    withRecovery(async (fixture) => {
      const email = "recovery@example.test";
      const config: OpenClawConfig = {
        gateway: { auth: { identityScopes: { [email]: ["operator.admin"] } } },
      };
      fixture.setConfig(config);
      const snapshot = expectDefined(
        normalizeGatewayOperatorRecoverySnapshot({
          ...expectDefined(fixture.sourceAuthority.recoverySnapshot, "captured source"),
          authPolicy: {
            ...captureGatewayAuthPolicy(config, {
              role: "operator",
              authMethod: "token",
              verifiedIdentity: email,
            }),
            generation: "",
          },
        }),
        "serialized source",
      );
      const restored = await restoreGatewayOperatorSource({
        snapshot,
        target: fixture.target,
        context: fixture.context,
        assertCurrent() {},
      });
      using _ = { [Symbol.dispose]: restored.release };
      const stringify = vi.spyOn(stableJson, "stableStringify");
      try {
        restored.authority.assertCurrent();
        restored.assertPolicyCurrent();
        expect(stringify).not.toHaveBeenCalled();

        const equivalent = structuredClone(config);
        equivalent.gateway!.trustedProxies = ["192.0.2.10"];
        equivalent.gateway!.auth!.identityScopes![email] = ["operator.admin", "operator.read"];
        fixture.setConfig(equivalent);
        expectCurrent(restored.authority);
        stringify.mockClear();
        restored.authority.assertCurrent();
        restored.assertPolicyCurrent();
        expect(stringify).not.toHaveBeenCalled();

        const revoked = structuredClone(equivalent);
        revoked.gateway!.auth!.identityScopes![email] = ["operator.read"];
        fixture.setConfig(revoked);
        expectCurrent(restored.authority);
        fixture.setConfig(config);
        expect(restored.assertPolicyCurrent).not.toThrow();
        await expect(
          restoreGatewayOperatorSource({
            snapshot,
            target: fixture.target,
            context: { ...fixture.context, getRuntimeConfig: () => revoked },
            assertCurrent() {},
          }),
        ).rejects.toThrow("source policy changed");
      } finally {
        stringify.mockRestore();
      }
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
        expect(restored.authority.assertCurrent).toThrow("Recovery claim retired");
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

  it.each(["current", "owner closed", "device revoked"] as const)(
    "checks independently owned continuation custody after preparation: %s",
    (change) =>
      withRecovery(
        async (fixture, _stateDir, profile) => {
          const snapshot = expectDefined(fixture.snapshot, "authenticated continuation source");
          let current = true;
          const restore = restoreGatewayOperatorSource({
            snapshot,
            target: fixture.target,
            context: fixture.context,
            assertCurrent: () => {
              if (!current) {
                throw new Error("Continuation owner closed");
              }
            },
            prepareCurrent: async () => {
              if (change === "owner closed") {
                current = false;
              } else if (change === "device revoked") {
                invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
              }
            },
          });
          if (change !== "current") {
            await expect(restore).rejects.toThrow(/owner closed|source policy changed/);
            return;
          }
          const restored = await restore;
          const retained = expectDefined(restored.authority.retain, "continuation retention")();
          try {
            restored.release();
            expect(restored.authority).toMatchObject({
              profileId: profile.id,
              scopes: ["operator.write"],
            });
            expect(restored.authority.assertCurrent).not.toThrow();
            current = false;
            expect(restored.authority.assertCurrent).toThrow("Continuation owner closed");
          } finally {
            retained();
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
          expect(bounded.assertCurrent).not.toThrow();
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
            expect(() => captureQueuedOperatorRecoverySource(bounded)).toThrow(
              "Channel operator authority changed",
            );
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
        expect(original.assertCurrent).toThrow();
        await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
        const restore = () =>
          restoreGatewayQueuedOperatorRecovery({
            source: decodeQueuedOperatorRecoverySource(persisted),
            context: gateway,
            assertCurrent: () => {},
          });
        const restored = await restore();
        try {
          expect(restored.authority.assertCurrent).not.toThrow();
          expect(restored.authority.profileId).toBe(admin.profile.id);
          await changeCanonicalUserChannelIdentity("unlink", admin.profile.id, admin.identity);
          await changeCanonicalUserChannelIdentity("link", admin.profile.id, admin.identity);
          expect(restored.authority.assertCurrent).toThrow();
          await expect(restore()).rejects.toThrow(GatewayOperatorRecoveryAuthorizationError);
        } finally {
          restored.release();
        }
      },
      "role",
      "slack",
    );
  });

  it("keeps key-linked authority through edits, resets and other chats; deleting the chat ends it", () =>
    withRecovery(async (fixture) => {
      const { agentId, sessionKey, storePath } = fixture.target;
      const restored = await restoreGatewayOperatorSource({
        snapshot: fixture.snapshot,
        target: { agentId, sessionKey },
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
      expectRevoked(restored.authority);
    }));

  it("keeps restored authority current during unrelated issuance", () =>
    withRecovery(async (fixture, stateDir) => {
      using restored = await restoreFixture(fixture);

      await issueDeviceBootstrapToken({ baseDir: stateDir });
      expectCurrent(restored.authority);
    }));
  it("keeps an admitted tokenless continuation after revocation and refuses the next start", () =>
    withRecovery(
      async (fixture) => {
        const caller = acceptedCaller(fixture);
        const captured = expectDefined(await caller.capture(), "accepted source");
        expectDefined(fixture.client.internal, "authenticated client").operatorRunAuthority =
          captured.authority;
        const continuation = expectDefined(
          await captureGatewayOperatorContinuation({
            client: fixture.client,
            context: fixture.context,
          }),
          "detached continuation",
        );
        try {
          expect(continuation.authority.recoverySnapshot?.device).toBeUndefined();
          caller.release();
          captured.release();
          expect(continuation.authority.assertCurrent).not.toThrow();
          invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
          expect(continuation.authority.assertCurrent).not.toThrow();
          await expect(
            captureGatewayOperatorContinuation({
              client: fixture.client,
              context: fixture.context,
            }),
          ).rejects.toThrow();
        } finally {
          continuation.release();
        }
      },
      { tokenlessDevice: true },
    ));

  it("does not adopt an incidental paired token for tokenless trusted-proxy ingress", () =>
    withRecovery(
      async (fixture) => {
        expect(fixture.snapshot.device).toBeUndefined();
        using restored = await restoreFixture(fixture);

        expect(
          (await rotateDeviceToken({ deviceId: "recovery-device", role: "operator" })).ok,
        ).toBe(true);
        expectCurrent(restored.authority);
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
            await expect(caller.capture()).rejects.toThrow(
              "Gateway caller authority is no longer active",
            );
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
          await expect(fixture.restore()).rejects.toThrow("operator authority changed");
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
  it.each(["before restoration", "after admission"] as const)(
    "refuses recovery after shared credentials rotate %s",
    (timing) =>
      withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
        using _ = restored ? { [Symbol.dispose]: restored.release } : undefined;

        enforceSharedGatewaySessionGenerationForConfigWrite({
          state: owner,
          nextConfig: {},
          resolveRuntimeSnapshotGeneration: () => "replacement-credential-generation",
          clients: [],
        });
        if (restored) {
          expect(restored.authority.signal?.aborted).toBe(false);
          expectCurrent(restored.authority);
          await expect(fixture.restore()).rejects.toThrow(
            GatewayOperatorRecoveryAuthorizationError,
          );
          expect(restored.authority.reauthorize).toThrow("source policy changed");
          expectCurrent(restored.authority);
          owner.publish({ current: generation, required: null });
          expectCurrent(restored.authority);
        } else {
          await expect(fixture.restore()).rejects.toThrow(
            GatewayOperatorRecoveryAuthorizationError,
          );
        }
      }),
  );
  it("admits scheduled work after the original authority closes without exporting credentials", () =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const profile = ensureProfileForEmail("recovery@example.test");
      const fixture = await recoveryFixture(state.stateDir, profile.id, {
        device: pairedOperator(),
        scopes: ["operator.write"],
      });
      expect(fixture.sourceAuthority.assertCurrent).toThrow("no longer active");
      expect(fixture.snapshot).toMatchObject({
        controlUiAdmin: false,
        sourceIngress: "control-ui",
      });
      const serialized = JSON.stringify(fixture.snapshot);
      expect(serialized).not.toContain("fixture-device-token");
      expect(serialized).not.toContain("fixture-signature");
      using restored = await restoreFixture(fixture);

      expect(restored.authority).toMatchObject({
        scopes: ["operator.write"],
        profileId: profile.id,
      });
      expect(restored.authority.assertCurrent).not.toThrow();
      const retain = expectDefined(restored.authority.retain, "recovery retention")();
      restored.release();
      expect(restored.authority.assertCurrent).not.toThrow();
      retain();
      expect(restored.authority.assertCurrent).toThrow("no longer active");
    }));

  it.each([
    "profile merge",
    "role changed",
    "device removed",
    "token revoked",
    "token rotated",
    "token scopes narrowed",
    "approval scopes narrowed",
  ] as const)("refuses current-policy re-admission after %s", (change) =>
    withRecovery(async (fixture, stateDir, profile) => {
      const device = pairedOperator();
      if (change === "profile merge") {
        const target = ensureProfileForEmail("merged@example.test");
        linkEmail("recovery@example.test", target.id);
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
        persistDevices(stateDir, change === "device removed" ? [] : [device], "both");
      }
      await expect(fixture.restore()).rejects.toThrow(
        /Restart recovery operator|user profile not found/,
      );
    }),
  );

  it.each(["claim retired", "device revoked", "role changed", "session deleted"] as const)(
    "keeps cancellation separate from next-start readmission after %s",
    (change) =>
      withRecovery(async (fixture) => {
        using restored = await restoreFixture(fixture);

        if (change === "claim retired") {
          fixture.retire();
        }
        if (change === "device revoked") {
          await rotateDeviceToken({ deviceId: "recovery-device", role: "operator" });
          invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
        }
        if (change === "role changed") {
          setUserProfileRole(restored.authority.profileId, "new-role");
        }
        if (change === "session deleted") {
          await deleteSessionEntryLifecycle({
            archiveTranscript: false,
            storePath: fixture.target.storePath,
            target: {
              canonicalKey: fixture.target.sessionKey,
              storeKeys: [fixture.target.sessionKey],
            },
          });
        }
        if (change === "device revoked" || change === "role changed") {
          expectCurrent(restored.authority);
          expect(expectDefined(restored.authority.reauthorize, "queued-start admission")).toThrow();
          expectCurrent(restored.authority);
          await expect(fixture.restore()).rejects.toThrow();
        } else {
          expect(restored.authority.assertCurrent).toThrow();
        }
      }),
  );

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
        using derive = vi.spyOn(sourcePolicy, "sourceRolePolicy");
        using compare = vi.spyOn(sourcePolicy, "isOperatorRoleSourcePolicyCurrent");
        restored.authority.assertCurrent();
        restored.assertPolicyCurrent();
        expect([derive.mock.calls, compare.mock.calls]).toEqual([[], []]);
        const widened = structuredClone(cfg);
        fixture.setConfig(widened);
        publish();
        expectCurrent(restored.authority);
        // A later publication applies to the next restoration, even with the same config object.
        widened.gateway!.roles!.definitions.operator!.scopes = ["operator.read"];
        publish();
        expect(restored.authority.signal?.aborted).toBe(false);
        expectCurrent(restored.authority);
        await expect(fixture.restore()).rejects.toThrow("source policy changed");
        expect(expectDefined(restored.authority.reauthorize, "queued-start admission")).toThrow(
          "source policy changed",
        );
        expectCurrent(restored.authority);
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
      expect(expectDefined(restored.authority.reauthorize, "queued-start admission")).toThrow(
        "model policy changed",
      );
      expectCurrent(restored.authority);
      const next = expectDefined(await fixture.restore(), "fresh model-policy admission");
      try {
        expect(next.authority.modelPolicy?.models).toEqual([modelRef("a"), modelRef("b")]);
      } finally {
        next.release();
      }
    }));
});
