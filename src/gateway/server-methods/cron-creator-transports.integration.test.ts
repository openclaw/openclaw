import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
  withTestTimeout,
} from "../../../test/helpers/promise.js";
import { getAdmittedRunDelegatedAuthority } from "../../agents/admitted-run-context.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { bindCronRequesterGrant } from "../../agents/cron-creator-authority-context.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  mintAgentRuntimeIdentityToken,
  verifyAgentRuntimeIdentityToken,
} from "../agent-runtime-identity-token.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import {
  deactivateMcpLoopbackClientGrantCapture,
  revokeMcpLoopbackClientGrant,
} from "../mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../mcp-http.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { dispatchGatewayRequestInProcess } from "../server-in-process-dispatch.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { resolveGatewayChatCronCreatorAuthorityAdmission } from "./cron-creator-authority-admission.js";
import {
  SESSION,
  CREATOR,
  cfg as baseCfg,
  stateDir,
  cron as cronService,
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

it.each(["operator.cron", "operator.write"])(
  "admits %s automation creation without owner authority",
  async (scope) => {
    const profile = ensureProfileForEmail("scoped-cron@example.test");
    const client = createOperatorClient({ profileId: profile.id, scopes: [scope] });
    client.internal = { authenticatedOperator: true };
    client.authPolicy = captureGatewayAuthPolicy(config, { role: "operator", authMethod: "token" });
    const original = expectDefined(
      await captureGatewayOperatorRunAuthority({
        client,
        context: fixture.context,
        sourceAuthority: null,
      }),
      "authenticated source",
    );
    const creatorAdmission = expectDefined(
      admission("restricted-creator", client),
      "cron admission",
    );
    expect(creatorAdmission.managementEntitlement).toBeUndefined();
    expect(creatorAdmission.callerOrigin).toEqual({ kind: "unknown" });
    try {
      await withPluginRuntimeGatewayRequestScope(
        { client, context: fixture.context, isWebchatConnect: () => false },
        () =>
          inRun(
            "restricted-creator",
            creatorAdmission,
            boundTo(fixture, async (_identity, admitted, creator) => {
              const tools = await createCreatorTransportTools({
                transport: "embedded",
                config,
                admitted,
                creator,
                senderIsOwner: false,
              });
              const result = await addJob(tools, "Restricted caller job", {
                payload: { ...timedPayload },
              });
              expect(result).toHaveProperty("details.id");
              const jobs = await fixture.read();
              expect(jobs).toMatchObject([
                {
                  ...ownedJob,
                  payload: { toolsAllow: ["*"], timeoutSeconds: 0 },
                },
              ]);
              expect(jobs[0]?.payload).not.toHaveProperty("toolsAllowIsDefault");
              expect(jobs[0]?.operatorSource?.source.snapshot.scopes).toEqual([scope]);
            }),
            original.authority,
          ),
      );
    } finally {
      original.release();
    }
  },
);
it.each(["operator.cron", "operator.write"])(
  "persists only owned jobs through signed %s requester grants and fences revocation",
  async (scope) => {
    const caller = captureGatewayDeviceRevocation(
      fixture.context,
      { deviceId: "scoped-creator-device", role: "operator" },
      () => true,
    );
    const client = createOperatorClient({ profileName: "scoped-cron", scopes: [scope] });
    const runId = "signed-scoped-creator";
    const creatorAdmission = expectDefined(
      admission(runId, client, undefined, caller.isCurrent),
      "scoped creator admission",
    );
    const job = {
      name: "Signed requester job",
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "current" as const,
      sessionKey: SESSION,
      wakeMode: "next-heartbeat" as const,
      payload: { ...timedPayload, kind: "agentTurn" as const, toolsAllow: [] },
      delivery: { mode: "none" as const },
    };
    try {
      await inRun(
        runId,
        creatorAdmission,
        boundTo(fixture, async (identity, admitted, creator) => {
          expect(creator).toMatchObject({
            callerOrigin: { kind: "unknown" },
            callerScopedCreation: true,
          });
          expect(creator?.managementEntitlement).toBeUndefined();
          const mint = expectDefined(bindCronRequesterGrant(runId), "requester grant issuer");
          const request = async (method: string, params: Record<string, unknown>) => {
            const token = await mintAgentRuntimeIdentityToken({
              agentId: identity.agentId,
              sessionKey: identity.sessionKey,
              operationalRunInstance: identity.operationalRunInstance,
              cronCreatorAuthorityGrant: mint(),
            });
            const signedIdentity = expectDefined(
              await verifyAgentRuntimeIdentityToken(token),
              "verified requester identity",
            );
            expect(signedIdentity.cronToolsAllowCapture).toBeUndefined();
            expect(signedIdentity.cronManagementGrant).toBeUndefined();
            expect(signedIdentity.turnSourceLocal).toBeUndefined();
            const signedClient = createSyntheticPluginRuntimeClient({ scopes: [scope] });
            signedClient.internal!.agentRuntimeIdentity = signedIdentity;
            return dispatchGatewayRequestInProcess(method, params, {
              client: signedClient,
              context: fixture.context,
            });
          };
          await request("cron.add", job);
          const jobs = await fixture.read();
          expect(jobs).toMatchObject([{ name: job.name, ...ownedJob }]);
          expect(jobs[0]?.toolsAllowProvenance).toBeUndefined();
          expect(jobs[0]?.runtimeAuthority).toBeUndefined();
          for (const owner of [
            { ...ownedJob.owner, sessionKey: "agent:main:foreign-conversation" },
            { ...ownedJob.owner, accountId: "foreign-account" },
          ]) {
            const foreign = await cronService.add(
              { ...job, name: "Foreign job", enabled: true, agentId: "main", owner },
              {
                scheduledToolPolicy: {
                  version: 1,
                  mode: "account",
                  ownerSessionKey: owner.sessionKey,
                  ownerAccountId: owner.accountId,
                },
              },
            );
            const before = await fixture.read();
            await expect(
              request("cron.update", {
                id: foreign.id,
                patch: { name: "Must not change" },
              }),
            ).rejects.toThrow(`Automation not found: ${foreign.id}.`);
            expect(await fixture.read()).toEqual(before);
          }
          await fixture.rejectMutation(
            () => request("cron.add", { ...job, name: "Revoked requester job" }),
            /authority.*no longer active/i,
            () =>
              invalidateGatewayDeviceRevocation(
                fixture.context,
                "scoped-creator-device",
                "operator",
              ),
          );
          expect(getAdmittedRunDelegatedAuthority(admitted)).toBeDefined();
          expect(creator).toMatchObject({ active: true, signal: { aborted: false } });
        }),
      );
    } finally {
      fixture.release.resolve();
      caller.release();
    }
  },
);

it.each([
  ["cli", "local", "device"],
  ["embedded", "local", "device"],
  ["embedded", "remote", "device"],
  ["embedded", "remote-chat", "device"],
  ["embedded", "local", "skill selection"],
] as const)(
  "fences a real %s %s creator mutation on %s change while its run remains admitted",
  { timeout: 30_000 },
  async (transport, origin, reason) => {
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
        await ensureMcpLoopbackServer();
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
            reason === "skill selection"
              ? /Creator session changed before scheduling/
              : /authority.*no longer active/i,
            () => {
              if (reason === "skill selection") {
                const session = expectDefined(
                  loadSessionEntry({ sessionKey: SESSION }),
                  "creator session",
                );
                const updated = {
                  ...session,
                  skillLibrarySelections: [
                    {
                      skillId: "00000000-0000-4000-8000-000000000001",
                      revision: "b".repeat(64),
                      name: "Selected skill",
                      ownerProfileId: CREATOR.id,
                    },
                  ],
                };
                replaceSessionEntrySync({ sessionKey: SESSION }, updated);
                expect(loadSessionEntry({ sessionKey: SESSION })).toEqual(updated);
                expect(caller.isCurrent()).toBe(true);
              } else {
                invalidateGatewayDeviceRevocation(fixture.context, "creator-device", "operator");
              }
            },
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
