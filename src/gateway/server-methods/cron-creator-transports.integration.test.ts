import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
  withTestTimeout,
} from "../../../test/helpers/promise.js";
import { getAdmittedRunDelegatedAuthority } from "../../agents/admitted-run-context.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
import { deviceHandlers } from "./devices.js";
import {
  SESSION,
  CREATOR,
  cfg as baseCfg,
  stateDir,
  admission,
  inRun,
  createCronFixture,
  type CreatorTransportTools,
  createCreatorTransportTools,
  installRequesterCronAuthorityTestHooks,
  type RequesterRun,
} from "./requester-cron-authority.test-support.js";

// Attached-node inventory is unrelated to these original-caller and Cron commit boundaries.
vi.mock("../../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

let config: OpenClawConfig;
let fixture: ReturnType<typeof heldCron>;
const timedPayload = { kind: "agentTurn", message: "Check status", timeoutSeconds: 0 };

const ownedJob = {
  createdActor: CREATOR,
  owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
  scheduledToolPolicy: {
    mode: "account",
    ownerSessionKey: SESSION,
    ownerAccountId: "default",
  },
};

function boundTo(contextFixture: ReturnType<typeof createCronFixture>, run: RequesterRun<void>) {
  return (async (...args) => {
    const admitted = args[1];
    bindGatewayContextResolver(admitted, () => contextFixture.context);
    try {
      await run(...args);
    } finally {
      clearGatewayContextResolver(admitted);
    }
  }) satisfies RequesterRun<void>;
}

function heldCron(testConfig: OpenClawConfig) {
  const entered = createDeferred();
  const release = createDeferred();
  let hold = false;
  const cron = createCronFixture(async () => {
    if (hold) {
      entered.resolve();
      await release.promise;
    }
    return [];
  }, testConfig);
  return {
    ...cron,
    release,
    async rejectMutation(
      start: () => Promise<unknown>,
      pattern: RegExp,
      revoke: () => void | Promise<void>,
      signal?: AbortSignal,
    ) {
      const before = await cron.read();
      hold = true;
      const pending = start();
      const rejected = expect(pending).rejects.toThrow(pattern);
      void rejected.catch(() => undefined);
      try {
        const gate = awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Mutation settled before Cron validation",
        );
        await (signal
          ? withinTest(gate, signal)
          : withTestTimeout(gate, 10_000, "Cron validation not reached"));
        expect(await cron.read()).toEqual(before);
        await revoke();
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
      }
      await rejected;
      expect(await cron.read()).toEqual(before);
    },
  };
}

installRequesterCronAuthorityTestHooks();
beforeEach(async () => {
  config = {
    ...baseCfg,
    agents: {
      ...baseCfg.agents,
      defaults: { model: "openai/gpt-4.1", workspace: stateDir },
    },
    tools: { allow: [AUTOMATIONS_TOOL_NAME] },
  };
  setRuntimeConfigSnapshot(config);
  fixture = heldCron(config);
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("OPENAI_OAUTH_TOKEN", undefined);
  await persistAuthProfileBatch({
    stateDir,
    profiles: [
      {
        profileId: "openai:automation-test",
        credential: { type: "api_key", provider: "openai", key: "synthetic-automation-test-key" },
      },
    ],
  });
});

function addJob(
  tools: CreatorTransportTools,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return tools.invoke(AUTOMATIONS_TOOL_NAME, {
    action: "add",
    job: {
      name,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "current",
      payload: { kind: "agentTurn", message: "Check status" },
      delivery: { mode: "none" },
      ...overrides,
    },
  });
}

it.for([
  ["fresh operator", "none"],
  ["recovered operator", "none"],
  ["legacy System", "none"],
  ["recovered operator", "device token rotation"],
  ["recovered operator", "role downgrade"],
  ["recovered operator", "access grant revocation"],
  ["recovered operator", "claim retirement"],
  ["recovered native operator", "none"],
  ["recovered native operator", "device token rotation"],
  ["recovered native operator", "role downgrade"],
  ["recovered native operator", "access grant revocation"],
  ["recovered native operator", "claim retirement"],
] as const)(
  "retains the %s scope boundary through real automation creation (%s)",
  async ([source, revocation], { signal }) => {
    const { release } = fixture;
    fixture.context.invalidateClientsForDevice = (deviceId, options) => {
      invalidateGatewayDeviceRevocation(fixture.context, deviceId, options?.role);
    };
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
    const native = source === "recovered native operator";
    const isRecovered = source === "recovered operator" || native;
    const recovery = await createOperatorRecoveryFixture({
      stateDir,
      context: fixture.context,
      profileId: profile.id,
      config,
      sessionKey: SESSION,
      sessionId: "requester-session",
      clientInfo: native
        ? { id: GATEWAY_CLIENT_IDS.MACOS_APP, mode: GATEWAY_CLIENT_MODES.UI }
        : undefined,
      localOperator: native,
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
    const restored = isRecovered ? await recovery.restore() : undefined;
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
    const runId = isRecovered ? recovery.target.recoveryRunId : "automation-recovery";
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
    } else if (native) {
      expect(recovery.entry.restartRecoverySourceIngress).toBe("internal");
      expect(recovery.entry.restartRecoveryOperatorSource?.snapshot.controlUiAdmin).toBe(false);
      expect(creator?.callerOrigin).toEqual({ kind: "local" });
      expect(creator?.managementEntitlement).toBeUndefined();
    } else {
      expect(creator?.managementEntitlement?.source).toBe("control-ui-admin");
    }
    const execute = boundTo(fixture, async (_identity, admitted) => {
      const tools = await createCreatorTransportTools({
        transport: "embedded",
        config,
        admitted,
        // The legacy negative case deliberately exposes the tool; its
        // untrusted owner hint must not confer the real Gateway admin scope.
        senderIsOwner: source === "legacy System" || hasGatewayAdminScope(client),
      });
      const created = addJob(tools, "Recovered caller job", { enabled: false });
      if (source === "legacy System") {
        await expect(created).rejects.toThrow("missing scope: operator.admin");
        expect(await fixture.read()).toEqual([]);
      } else {
        await created;
        expect(await fixture.read()).toMatchObject([
          { name: "Recovered caller job", enabled: false },
        ]);
        if (revocation !== "none") {
          await fixture.rejectMutation(
            () =>
              addJob(tools, "Revoked recovered caller job", {
                enabled: false,
              }),
            /authority|claim retired/i,
            async () => {
              if (revocation === "device token rotation") {
                const respond = vi.fn();
                const params = { deviceId: "recovery-proof-device", role: "operator" };
                await expectDefined(
                  deviceHandlers["device.token.rotate"],
                  "rotation",
                )({
                  req: { type: "req", id: "rotate", method: "device.token.rotate" },
                  params,
                  client: recovery.client,
                  isWebchatConnect: () => true,
                  context: fixture.context,
                  respond,
                });
                expect(respond).toHaveBeenCalledWith(
                  true,
                  expect.objectContaining(params),
                  undefined,
                );
              } else if (revocation === "role downgrade") {
                setUserProfileRole(profile.id, "revoked-role");
              } else if (revocation === "access grant revocation") {
                accessController.abort(new Error("Original access grant revoked"));
              } else {
                recovery.retire();
              }
            },
            signal,
          );
        }
      }
    });
    try {
      await withPluginRuntimeGatewayRequestScope(
        { client, context: fixture.context, isWebchatConnect: () => false },
        () => inRun(runId, creator, execute, restored?.authority),
      );
    } finally {
      release.resolve();
      restored?.release();
      restoreActivePluginRegistrySnapshot(previousRegistry);
    }
  },
);
it("preserves ordinary restricted caller creation without management admission", async () => {
  const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
  client.internal = {};
  expect(admission("restricted-creator", client)).toBeUndefined();
  await inRun(
    "restricted-creator",
    undefined,
    boundTo(fixture, async (_identity, admitted) => {
      const tools = await createCreatorTransportTools({
        transport: "embedded",
        config,
        admitted,
        senderIsOwner: true,
      });
      await addJob(tools, "Restricted caller job", {
        payload: { ...timedPayload },
      });
      const jobs = await fixture.read();
      expect(jobs).toMatchObject([
        {
          ...ownedJob,
          payload: { toolsAllow: ["*"], timeoutSeconds: 0 },
        },
      ]);
      expect(jobs[0]?.payload).not.toHaveProperty("toolsAllowIsDefault");
    }),
  );
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
    const { release } = fixture;
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
    let transportTools: CreatorTransportTools | undefined;
    try {
      if (transport === "cli") {
        await ensureMcpLoopbackServer(0);
      }
      await inRun(
        runId,
        creatorAdmission,
        boundTo(fixture, async (_identity, admitted, capability) => {
          const creator = expectDefined(capability, "creator capability");
          const delegated = expectDefined(
            getAdmittedRunDelegatedAuthority(admitted),
            "admitted run",
          );
          const tools = await createCreatorTransportTools({
            transport,
            config,
            admitted,
            creator,
            senderIsOwner: hasGatewayAdminScope(client),
          });
          transportTools = tools;
          const invoke = (name: string) =>
            addJob(tools, name, {
              wakeMode: "next-heartbeat",
              payload: { ...timedPayload },
            });

          await invoke("Live creator");
          const before = await fixture.read();
          expect(before).toMatchObject([
            {
              name: "Live creator",
              ...ownedJob,
              sessionKey: SESSION,
              sessionTarget: "current",
              payload: {
                kind: "agentTurn",
                timeoutSeconds: 0,
                toolsAllow: ["*"],
              },
              toolsAllowProvenance: {
                source: "final-executable-surface",
                callerOrigin: { kind: origin === "local" ? "local" : "unknown" },
              },
            },
          ]);
          expect(before[0]?.payload).not.toHaveProperty("toolsAllowIsDefault");
          expect(before[0]?.runtimeAuthority).toBeUndefined();
          await fixture.rejectMutation(
            () => invoke("Revoked creator"),
            /authority.*no longer active/i,
            () => invalidateGatewayDeviceRevocation(fixture.context, "creator-device", "operator"),
          );
          expect(getAdmittedRunDelegatedAuthority(admitted)).toBe(delegated);
          expect(creator).toMatchObject({ active: true, signal: { aborted: false } });
          if (tools.mcpCapture) {
            expect(deactivateMcpLoopbackClientGrantCapture(tools.mcpCapture)).toBe(true);
          }
        }),
      );
    } finally {
      release.resolve();
      if (transportTools?.mcpCapture) {
        revokeMcpLoopbackClientGrant(transportTools.mcpCapture.token);
      }
      try {
        if (transport === "cli") {
          await closeMcpLoopbackServer();
        }
      } finally {
        caller.release();
      }
    }
  },
);
