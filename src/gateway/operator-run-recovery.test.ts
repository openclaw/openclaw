import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as stableJson from "@openclaw/normalization-core/stable-stringify";
import { describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { readPersistedFileStat } from "../agents/sessions/tools/file-write-verification.js";
import { createWriteTool } from "../agents/sessions/tools/write.js";
import { getCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import { withAdminIngress } from "../channels/message-access/operator-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import { ensureDeviceToken, rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { getPairedDevice, updatePairedDeviceMetadata } from "../infra/device-pairing.js";
import { isMissingPathError } from "../infra/errors.js";
import type { PluginGatewayAccessPolicy } from "../plugins/gateway-access-policy.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { fenceUserProfileMutationAuthority } from "../state/user-profile-events.js";
import * as profileReader from "../state/user-profile-list.js";
import { setCanonicalUserProfileDisplayName } from "../state/user-profile-writes.js";
import {
  linkEmail,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import { retireDeviceTokenClients } from "./device-token-client-lifecycle.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import * as sourcePolicy from "./operator-role-source-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import {
  decodeQueuedOperatorRecoverySource,
  normalizeGatewayOperatorRecoverySnapshot,
} from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import {
  restoreGatewayOperatorSource,
  restoreGatewayQueuedOperatorRecovery,
} from "./operator-run-recovery.js";
import {
  createOperatorRecoveryFixture,
  pairedOperator,
  persistDevices,
  recoveryFixture,
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

function expectCurrent(authority: { signal?: AbortSignal; assertCurrent: () => void }) {
  expect(authority.signal?.aborted).toBe(false);
  expect(authority.assertCurrent).not.toThrow();
}

type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>;
function withRecovery(
  run: (
    fixture: RecoveryFixture,
    stateDir: string,
    profile: ReturnType<typeof ensureProfileForEmail>,
  ) => Promise<void>,
  overrides: Partial<Parameters<typeof createOperatorRecoveryFixture>[0]> = {},
) {
  return withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const profile = ensureProfileForEmail("recovery@example.test");
    await run(
      await recoveryFixture(stateDir, profile.id, { device: pairedOperator(), ...overrides }),
      stateDir,
      profile,
    );
  });
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
function expectRevoked(authority: { signal?: AbortSignal; assertCurrent: () => void }) {
  expect(authority.assertCurrent).toThrow();
  expect(authority.signal?.aborted).toBe(true);
}

async function restoreFixture(fixture: RecoveryFixture) {
  const source = expectDefined(await fixture.restore(), "restored operator source");
  return { ...source, [Symbol.dispose]: source.release };
}

describe("scheduled authenticated operator source", () => {
  it.each(["pending", "uncertain"] as const)(
    "refuses cached profile facts while their mutation is %s",
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
          expectRevoked(restored.authority);
        } finally {
          mutation.settle(true);
        }
      }),
  );

  it("retains profile facts until their owner revision changes without retaining revoked bindings", () =>
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
        expect(reads).toHaveBeenCalledTimes(1);
        reads.mockClear();
        linkEmail("additional@example.test", profile.id);
        expectCurrent(restored.authority);
        expect(reads).toHaveBeenCalledTimes(1);

        linkEmail("recovery@example.test", other.id);
        expectRevoked(restored.authority);
        linkEmail("recovery@example.test", profile.id);
        expectRevoked(restored.authority);
      } finally {
        preparation.mockRestore();
      }
    }));

  it("retains the validated auth policy across checks and rejects a changed grant", () =>
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
        expectRevoked(restored.authority);
        fixture.setConfig(config);
        expect(restored.assertPolicyCurrent).toThrow();
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

  it.each(["device revocation", "email reassignment", "email restoration"] as const)(
    "keeps an accepted child current after its requester settles but fences its final write after %s",
    (change) =>
      withRecovery(async (fixture, stateDir, profile) => {
        // Keep this profile independent when its original authentication email moves.
        linkEmail("retained@example.test", profile.id);
        const restored = expectDefined(await fixture.restore(), "recovered requester authority");
        const client = createSyntheticPluginRuntimeClient({
          authenticatedUserProfile: fixture.client.authenticatedUserProfile,
          operatorRoleActor: { kind: "operator", profileId: restored.authority.profileId },
          operatorRunAuthority: restored.authority,
          scopes: ["operator.write"],
        });
        const child = expectDefined(
          await withPluginRuntimeGatewayRequestScope(
            { client, context: fixture.context, isWebchatConnect: () => false },
            () =>
              withOperatorToolGatewayAuthority(
                { operatorRunAuthority: restored.authority, scopes: ["operator.write"] },
                async () => await captureOperatorToolGatewayContinuationContext(),
              ),
          ),
          "accepted child authority",
        );
        const beforeWrite = createDeferredCore();
        const releaseWrite = createDeferredCore();
        let pauseWrite = false;
        let writes = 0;
        let pendingWrite: Promise<unknown> | undefined;
        let admission: ReturnType<typeof prepareAgentRunAdmission> | undefined;
        let host: ReturnType<typeof createAgentHarnessHostCapabilities> | undefined;
        try {
          const runId = "recovered-child-effect";
          const { agentId, sessionKey, sessionId } = fixture.target;
          const prepared = prepareAgentRunAdmission({
            cfg: {},
            facts: {
              runId,
              agentId,
              ingress: { kind: "system", boundary: "recovered-child-test", state: "present" },
            },
            operationalRunInstance: createOperationalRunInstanceRef(runId),
            operatorAuthority: child.operatorAuthority,
          });
          admission = prepared;
          const admittedRunContext = await child.run(() =>
            prepared.admit("plugin-harness", `harness-${runId}`),
          );
          bindGatewayContextResolver(admittedRunContext, () => fixture.context);
          host = child.run(() =>
            createAgentHarnessHostCapabilities({
              attempt: { runId, agentId, sessionKey, sessionId, admittedRunContext },
              pluginId: "codex",
            }),
          );
          const tool = expectDefined(
            host.capabilities.bindToolSurface([
              createWriteTool(stateDir, {
                operations: {
                  mkdir: async (dir) => {
                    await mkdir(dir, { recursive: true });
                    if (pauseWrite) {
                      beforeWrite.resolve();
                      await releaseWrite.promise;
                    }
                  },
                  readFile,
                  statFile: (file) => readPersistedFileStat(file, isMissingPathError),
                  writeFile: async (file, content) => {
                    writes += 1;
                    await writeFile(file, content, "utf8");
                  },
                },
              }),
            ])[0],
            "child write capability",
          );
          const file = "recovered-child-effect.txt";
          fixture.retire();
          restored.release();
          expect(restored.authority.assertCurrent).toThrow("Recovery claim retired");
          expect(child.operatorAuthority?.scopes).toEqual(["operator.write"]);
          await child.run(() => tool.execute("allowed", { path: file, content: "allowed\n" }));
          expect(await readFile(path.join(stateDir, file), "utf8")).toBe("allowed\n");

          // No cancellation signal: the final write must revalidate its admitted principal.
          pauseWrite = true;
          pendingWrite = child.run(() =>
            tool.execute("revoked", { path: file, content: "forbidden\n" }),
          );
          void pendingWrite.catch(beforeWrite.reject);
          await beforeWrite.promise;
          if (change === "device revocation") {
            invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
          } else {
            const other = ensureProfileForEmail("other@example.test");
            linkEmail("recovery@example.test", other.id);
            if (change === "email restoration") {
              expect(linkEmail("recovery@example.test", profile.id).id).toBe(profile.id);
            }
          }
          releaseWrite.resolve();
          await expect(pendingWrite).rejects.toThrow("no longer active");
          expect(writes).toBe(1);
          expect(await readFile(path.join(stateDir, file), "utf8")).toBe("allowed\n");
          expect(child.signal.aborted).toBe(true);
        } finally {
          releaseWrite.resolve();
          await pendingWrite?.catch(() => undefined);
          host?.close();
          admission?.close();
          child.release();
          restored.release();
        }
      }),
  );

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
            await expect(restore).rejects.toThrow(/owner closed|authority changed/);
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
            expect(captured).toEqual({ kind: "unavailable" });
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
          await expect(restore()).rejects.toThrow("Queued channel operator authority changed");
        } finally {
          restored.release();
        }
      },
      "role",
      "slack",
    );
  });

  it("keeps restored authority current during unrelated issuance", () =>
    withRecovery(async (fixture, stateDir) => {
      using restored = await restoreFixture(fixture);

      await issueDeviceBootstrapToken({ baseDir: stateDir });
      expectCurrent(restored.authority);
    }));
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
  it.each(["before capture", "after admission", "after restoration"] as const)(
    "revokes the original device authority on Gateway retirement %s",
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
            expectRevoked(source.authority);
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
  it("keeps accepted device authority through unrelated pairing traffic until Gateway retirement", () =>
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
        expectRevoked(accepted.authority);
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
          expect(restored.authority.signal?.aborted).toBe(true);
          expect(restored.authority.assertCurrent).toThrow("authority changed");
          owner.publish({ current: generation, required: null });
          expect(restored.authority.assertCurrent).toThrow("authority changed");
        } else {
          await expect(fixture.restore()).rejects.toThrow("authentication owner changed");
        }
      }),
  );
  it.each(["signal", "assertion", "new policy", "github binding", "policy callback"] as const)(
    "resumes the original access grant once and fences retained recovery through %s",
    (revocation) =>
      withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const original = { pluginId: "recovery-access", grantId: "original-accepted-grant" };
        let permitted = true;
        let additionalApplicable = false;
        let invalidateDuringPolicy = false;
        const controller = new AbortController();
        const grant = {
          grantId: original.grantId,
          signal: controller.signal,
          assertCurrent: () => {
            controller.signal.throwIfAborted();
            if (!permitted) {
              throw new Error("Original grant revoked");
            }
          },
        };
        const resume = vi.fn<NonNullable<PluginGatewayAccessPolicy["resume"]>>(({ profile }) =>
          permitted && (revocation !== "github binding" || profile.githubAccountIds?.includes(42))
            ? grant
            : undefined,
        );
        const registry = createEmptyPluginRegistry();
        registry.plugins.push(createPluginRecord({ id: original.pluginId }));
        registry.gatewayAccessPolicies.push({
          pluginId: original.pluginId,
          source: "fixture",
          policy: { authorize: () => grant, resume },
        });
        registry.plugins.push(createPluginRecord({ id: "additional-access" }));
        registry.gatewayAccessPolicies.push({
          pluginId: "additional-access",
          source: "fixture",
          policy: {
            authorize: () => {
              if (invalidateDuringPolicy) {
                permitted = false;
              }
              return additionalApplicable ? grant : undefined;
            },
          },
        });
        const previous = captureActivePluginRegistrySnapshot();
        stageActivePluginRegistry(registry, null, "default");
        try {
          const profile = ensureProfileForEmail("access@example.test");
          if (revocation === "github binding") {
            for (const [accountId, login, email] of [
              [41, "primary", "access@example.test"],
              [42, "secondary", "secondary@example.test"],
            ] as const) {
              syncGitHubIdentity({
                identity: { accountId, login },
                authenticationAlias: { kind: "email", email },
              });
            }
            linkEmail("secondary@example.test", profile.id);
          }
          const fixture = await recoveryFixture(state.stateDir, profile.id, {
            gatewayAccessGrant: original,
          });
          permitted = false;
          await expect(fixture.restore()).rejects.toThrow("Gateway access is not active");
          permitted = true;
          resume.mockClear();
          using restored = await restoreFixture(fixture);

          expect(restored.authority.gatewayAccessGrant).toEqual(original);
          expect(resume).toHaveBeenCalledWith(
            expect.objectContaining({ grantId: original.grantId }),
          );
          restored.authority.assertCurrent();
          restored.authority.readCurrentRoleFacts?.();
          expect(resume).toHaveBeenCalledTimes(1);
          if (revocation === "signal") {
            controller.abort(new Error("Original grant revoked"));
            expect(restored.authority.signal?.aborted).toBe(true);
          } else if (revocation === "assertion") {
            permitted = false;
          } else if (revocation === "policy callback") {
            invalidateDuringPolicy = true;
          } else if (revocation === "github binding") {
            const { db } = openOpenClawStateDatabase();
            // Seed a removed secondary identity, then publish through the profile writer.
            db.prepare(
              "DELETE FROM user_profile_identities WHERE provider = 'github' AND subject = ?",
            ).run("42");
            await setCanonicalUserProfileDisplayName(profile.id, "Updated display");
          } else {
            additionalApplicable = true;
          }
          expectRevoked(restored.authority);
        } finally {
          restoreActivePluginRegistrySnapshot(previous);
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

  it.each(["claim retired", "device revoked", "session replaced"] as const)(
    "fences retained recovered authority after %s",
    (change) =>
      withRecovery(async (fixture) => {
        using restored = await restoreFixture(fixture);

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
      }),
  );

  it.each(["gateway", "runtime"])("refreshes source policy on %s publication", (publication) =>
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
      // Committed publication must invalidate even when the config identity is retained.
      widened.gateway!.roles!.definitions.operator!.scopes = ["operator.read"];
      publish();
      expect(restored.authority.signal?.aborted).toBe(publication === "gateway");
      expectRevoked(restored.authority);
      fixture.setConfig(cfg);
      publish();
      expect(restored.authority.assertCurrent).toThrow();
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
        gateway: { roles: { definitions: { operator } } },
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
    }));
});
