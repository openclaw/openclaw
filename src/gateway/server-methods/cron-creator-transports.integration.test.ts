import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
  withTestTimeout,
} from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { rotateDeviceToken } from "../../infra/device-pairing-tokens.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import {
  deactivateMcpLoopbackClientGrantCapture,
  revokeMcpLoopbackClientGrant,
} from "../mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../mcp-http.js";
import { createOperatorRecoveryFixture } from "../operator-run-recovery.test-support.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import {
  resolveGatewayChatCronCreatorAuthorityAdmission,
  resolveGatewayCronCreatorAuthorityAdmission,
} from "./cron-creator-authority-admission.js";
import {
  SESSION,
  CREATOR,
  cfg,
  stateDir,
  admission,
  inRun,
  createCronFixture,
  type CreatorTransportTools,
  createCreatorTransportTools,
  installRequesterCronAuthorityTestHooks,
} from "./requester-cron-authority.test-support.js";

// Attached-node inventory is unrelated to these original-caller and Cron commit boundaries.
vi.mock("../../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

installRequesterCronAuthorityTestHooks();

describe("original caller through Cron creator transports", () => {
  it.for([
    ["fresh operator", "none"],
    ["recovered operator", "none"],
    ["legacy System", "none"],
    ["recovered operator", "device token rotation"],
    ["recovered operator", "role downgrade"],
    ["recovered operator", "access grant revocation"],
    ["recovered operator", "claim retirement"],
  ] as const)(
    "retains the %s scope boundary through real automation creation (%s)",
    async ([source, revocation], { signal }) => {
      const config: OpenClawConfig = { ...cfg, tools: { allow: [AUTOMATIONS_TOOL_NAME] } };
      setRuntimeConfigSnapshot(config);
      const entered = createDeferred();
      const release = createDeferred();
      let hold = false;
      const fixture = createCronFixture(async () => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        return [];
      }, config);
      const profile = ensureProfileForEmail("automation-recovery@example.test");
      const accessController = new AbortController();
      const accessGrant = { pluginId: "recovery-proof-access", grantId: "original-proof-grant" };
      const previousRegistry = captureActivePluginRegistrySnapshot();
      if (revocation === "access grant revocation") {
        const grant = {
          grantId: accessGrant.grantId,
          signal: accessController.signal,
          assertCurrent: () => accessController.signal.throwIfAborted(),
        };
        const registry = createEmptyPluginRegistry();
        registry.plugins.push(createPluginRecord({ id: accessGrant.pluginId }));
        registry.gatewayAccessPolicies.push({
          pluginId: accessGrant.pluginId,
          source: "fixture",
          policy: { authorize: () => grant, resume: () => grant },
        });
        stageActivePluginRegistry(registry, null, "default");
      }
      const recovery = await createOperatorRecoveryFixture({
        stateDir,
        context: fixture.context,
        profileId: profile.id,
        config,
        sessionKey: SESSION,
        sessionId: "requester-session",
        gatewayAccessGrant: revocation === "access grant revocation" ? accessGrant : undefined,
        device: {
          deviceId: "recovery-proof-device",
          publicKey: "synthetic-recovery-proof-key",
          roles: ["operator"],
          approvedScopes: ["operator.admin"],
          tokens: {
            operator: {
              token: "synthetic-recovery-proof-token",
              role: "operator",
              scopes: ["operator.admin"],
              createdAtMs: 1,
            },
          },
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      });
      const restored = source === "recovered operator" ? await recovery.restore() : undefined;
      const client =
        source === "fresh operator"
          ? recovery.client
          : createSyntheticPluginRuntimeClient({
              operatorRoleActor: restored
                ? { kind: "operator", profileId: restored.authority.profileId }
                : { kind: "system" },
              operatorRunAuthority: restored?.authority,
              scopes: restored ? [...restored.authority.scopes] : ["operator.write"],
            });
      const runId =
        source === "recovered operator" ? recovery.target.recoveryRunId : "automation-recovery";
      const creator = resolveGatewayCronCreatorAuthorityAdmission({
        runId,
        resolvedSessionKey: SESSION,
        sessionId: recovery.target.sessionId,
        client,
        request: { message: "Create a checkback", idempotencyKey: runId },
        hasRestoredCronContinuation: false,
        isOneShotModelRun: false,
        isRestartRecoveryResumeRun: source !== "fresh operator",
      });
      if (source === "legacy System") {
        expect(creator).toBeUndefined();
      } else {
        expect(creator?.managementEntitlement?.source).toBe("control-ui-admin");
      }
      try {
        await withPluginRuntimeGatewayRequestScope(
          { client, context: fixture.context, isWebchatConnect: () => false },
          () =>
            inRun(
              runId,
              creator,
              async (_identity, admitted) => {
                bindGatewayContextResolver(admitted, () => fixture.context);
                try {
                  const tools = await createCreatorTransportTools({
                    transport: "embedded",
                    config,
                    admitted,
                    senderIsOwner: true,
                  });
                  const created = tools.invoke(AUTOMATIONS_TOOL_NAME, {
                    action: "add",
                    job: {
                      name: "Recovered caller job",
                      enabled: false,
                      schedule: { kind: "every", everyMs: 60_000 },
                      sessionTarget: "current",
                      payload: { kind: "agentTurn", message: "Check status" },
                      delivery: { mode: "none" },
                    },
                  });
                  if (source === "legacy System") {
                    await expect(created).rejects.toThrow("missing scope: operator.admin");
                    expect(await fixture.read()).toEqual([]);
                  } else {
                    await created;
                    const before = await fixture.read();
                    expect(before).toMatchObject([
                      {
                        name: "Recovered caller job",
                        enabled: false,
                        createdActor: { type: "human", source: "profile", id: profile.id },
                      },
                    ]);
                    if (revocation !== "none") {
                      hold = true;
                      const pending = tools.invoke(AUTOMATIONS_TOOL_NAME, {
                        action: "add",
                        job: {
                          name: "Revoked recovered caller job",
                          enabled: false,
                          schedule: { kind: "every", everyMs: 60_000 },
                          sessionTarget: "current",
                          payload: { kind: "agentTurn", message: "Must not persist" },
                          delivery: { mode: "none" },
                        },
                      });
                      const rejected = expect(pending).rejects.toThrow(/authority|claim retired/i);
                      void rejected.catch(() => undefined);
                      try {
                        await withinTest(
                          awaitGateBeforeSettlement(
                            entered.promise,
                            pending,
                            "Recovered mutation did not reach real Cron validation",
                          ),
                          signal,
                        );
                        expect(await fixture.read()).toEqual(before);
                        if (revocation === "device token rotation") {
                          expect(
                            (
                              await rotateDeviceToken({
                                deviceId: "recovery-proof-device",
                                role: "operator",
                              })
                            ).ok,
                          ).toBe(true);
                        } else if (revocation === "role downgrade") {
                          setUserProfileRole(profile.id, "revoked-role");
                        } else if (revocation === "access grant revocation") {
                          accessController.abort(new Error("Original access grant revoked"));
                        } else {
                          recovery.retire();
                        }
                      } finally {
                        release.resolve();
                        await pending.catch(() => undefined);
                      }
                      await rejected;
                      expect(await fixture.read()).toEqual(before);
                    }
                  }
                } finally {
                  clearGatewayContextResolver(admitted);
                }
              },
              restored?.authority,
            ),
        );
      } finally {
        release.resolve();
        restored?.release();
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    },
  );
  it("preserves ordinary restricted caller creation without management admission", async () => {
    const config: OpenClawConfig = { ...cfg, tools: { allow: [AUTOMATIONS_TOOL_NAME] } };
    setRuntimeConfigSnapshot(config);
    const fixture = createCronFixture(undefined, config);
    const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
    client.internal = {};
    expect(admission("restricted-creator", client)).toBeUndefined();
    await inRun("restricted-creator", undefined, async (_identity, admitted) => {
      bindGatewayContextResolver(admitted, () => fixture.context);
      try {
        const tools = await createCreatorTransportTools({
          transport: "embedded",
          config,
          admitted,
          // Tool access does not grant Gateway-wide management admission.
          senderIsOwner: true,
        });
        await tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "add",
          job: {
            name: "Restricted caller job",
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "current",
            payload: { kind: "agentTurn", message: "Check status", timeoutSeconds: 0 },
            delivery: { mode: "none" },
          },
        });
        const jobs = await fixture.read();
        expect(jobs).toMatchObject([
          {
            createdActor: CREATOR,
            owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
            scheduledToolPolicy: {
              mode: "account",
              ownerSessionKey: SESSION,
              ownerAccountId: "default",
            },
            payload: { toolsAllow: ["*"], timeoutSeconds: 0 },
          },
        ]);
        expect(jobs[0]?.payload).not.toHaveProperty("toolsAllowIsDefault");
      } finally {
        clearGatewayContextResolver(admitted);
      }
    });
  });
  it.each([
    ["cli", "local"],
    ["embedded", "local"],
    ["embedded", "remote"],
    ["embedded", "remote-chat"],
  ] as const)(
    "fences a real %s %s creator mutation while its run remains admitted",
    { timeout: 30_000 },
    async (transport, origin) => {
      const config: OpenClawConfig = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { workspace: stateDir } },
        tools: { allow: [AUTOMATIONS_TOOL_NAME] },
      };
      setRuntimeConfigSnapshot(config);
      const entered = createDeferred();
      const release = createDeferred();
      let hold = false;
      const fixture = createCronFixture(async () => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        return [];
      }, config);
      const caller = captureGatewayDeviceRevocation(
        fixture.context,
        { deviceId: "creator-device", role: "operator" },
        () => true,
      );
      const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
      client.internal = origin === "local" ? { isLocalClient: true } : { controlUiAdmin: true };
      const runId = `original-${transport}-creator`;
      const creatorAdmission = expectDefined(
        origin === "remote-chat"
          ? resolveGatewayChatCronCreatorAuthorityAdmission({
              runId,
              resolvedSessionKey: SESSION,
              client,
              isCurrent: caller.isCurrent,
              hasExplicitOrigin: false,
              hasRestoredCronContinuation: false,
              isIncognito: false,
              isReconnectResume: false,
              isSystemGenerated: false,
              turnKind: "main",
              isDirectExternalUser: true,
            })
          : admission(runId, client, undefined, caller.isCurrent),
        "fresh operator admission",
      );
      const creator = expectDefined(
        createCronCreatorAuthorityCapability(
          runId,
          creatorAdmission.callerOrigin,
          creatorAdmission.managementEntitlement,
          creatorAdmission.isCurrent,
          undefined,
          creatorAdmission.requesterOwner,
          creatorAdmission.callerScopedCreation,
        ),
        "creator capability",
      );
      // Keep execution live so revocation must travel through the original caller predicate.
      const runAdmission = prepareAgentRunAdmission({
        cfg: config,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "cron-creator-caller-test", state: "present" },
        },
      });
      let admittedRun: AdmittedRunContext | undefined;
      let transportTools: CreatorTransportTools | undefined;
      let pending: Promise<unknown> | undefined;
      try {
        const admitted = await runAdmission.admit("gateway", runId);
        admittedRun = admitted;
        const delegated = expectDefined(getAdmittedRunDelegatedAuthority(admitted), "admitted run");
        bindGatewayContextResolver(admitted, () => fixture.context);
        if (transport === "cli") {
          await ensureMcpLoopbackServer(0);
        }
        await runWithCronCreatorAuthorityCapability(creator, async () => {
          const tools = await createCreatorTransportTools({
            transport,
            config,
            admitted,
            creator,
            senderIsOwner: hasGatewayAdminScope(client),
          });
          transportTools = tools;
          const invoke = (name: string) =>
            tools.invoke(AUTOMATIONS_TOOL_NAME, {
              action: "add",
              job: {
                name,
                schedule: { kind: "every", everyMs: 60_000 },
                sessionTarget: "current",
                wakeMode: "next-heartbeat",
                payload: { kind: "agentTurn", message: "Check service health", timeoutSeconds: 0 },
                delivery: { mode: "none" },
              },
            });

          await invoke("Live creator");
          const before = await fixture.read();
          expect(before).toMatchObject([
            {
              name: "Live creator",
              createdActor: CREATOR,
              sessionKey: SESSION,
              sessionTarget: "current",
              payload: {
                kind: "agentTurn",
                timeoutSeconds: 0,
                toolsAllow: ["*"],
              },
              owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
              scheduledToolPolicy: {
                mode: "account",
                ownerSessionKey: SESSION,
                ownerAccountId: "default",
              },
              toolsAllowProvenance: {
                source: "final-executable-surface",
                callerOrigin: { kind: origin === "local" ? "local" : "unknown" },
              },
            },
          ]);
          expect(before[0]?.payload).not.toHaveProperty("toolsAllowIsDefault");
          expect(before[0]?.runtimeAuthority).toBeUndefined();
          hold = true;
          pending = invoke("Revoked creator");
          const rejected = expect(pending).rejects.toThrow(/authority.*no longer active/i);
          void rejected.catch(() => undefined);
          try {
            await withTestTimeout(
              Promise.race([
                entered.promise,
                pending.then(() => {
                  throw new Error("Creator mutation returned before service validation");
                }),
              ]),
              10_000,
              "Creator mutation did not reach real Cron validation",
            );
            expect(await fixture.read()).toEqual(before);
            invalidateGatewayDeviceRevocation(fixture.context, "creator-device", "operator");
          } finally {
            release.resolve();
            await pending.catch(() => undefined);
          }
          await rejected;
          expect(getAdmittedRunDelegatedAuthority(admitted)).toBe(delegated);
          expect(creator.active).toBe(true);
          expect(creator.signal.aborted).toBe(false);
          expect(await fixture.read()).toEqual(before);
          if (tools.mcpCapture) {
            expect(deactivateMcpLoopbackClientGrantCapture(tools.mcpCapture)).toBe(true);
          }
        });
      } finally {
        release.resolve();
        await pending?.catch(() => undefined);
        if (transportTools?.mcpCapture) {
          revokeMcpLoopbackClientGrant(transportTools.mcpCapture.token);
        }
        try {
          if (transport === "cli") {
            await closeMcpLoopbackServer();
          }
        } finally {
          if (admittedRun) {
            clearGatewayContextResolver(admittedRun);
          }
          runAdmission.close();
          caller.release();
        }
      }
    },
  );
});
