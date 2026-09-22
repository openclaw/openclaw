import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import {
  bindCronManagementGrant,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { makeSettledChild } from "../../agents/subagents/announce/subagent-announce.requester-settle-wake.test-support.js";
import {
  markRequesterTurnYieldedInRuns,
  settleRequesterTurnAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry-requester-yield.js";
import { saveSubagentRegistryChangesToSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  revokeRequesterCronAuthority,
  withRequesterCronAuthority,
} from "../../agents/subagents/requester-cron-authority.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore } from "../../cron/store.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  createAgentRuntimeApprovalAuthorityValidator,
  type AgentRuntimeIdentity,
} from "../agent-runtime-identity-token.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import {
  resolveGatewayCronCreatorAuthorityAdmission,
  type GatewayCronCreatorAuthorityAdmission,
} from "./cron-creator-authority-admission.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient, RespondFn } from "./types.js";

const SESSION = "agent:main:control-ui";
const SESSION_ID = "requester-session";
const cfg = { agents: { entries: { main: {} } } };
let stateDir: string;
let cron: CronService;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  stateDir = tempDirs.make("openclaw-requester-cron-authority-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot(cfg);
  replaceSessionEntrySync(
    { sessionKey: SESSION },
    { sessionId: SESSION_ID, updatedAt: 1, lifecycleRevision: "original" },
  );
});

afterEach(async () => {
  cron?.stop();
  revokeRequesterCronAuthority(SESSION);
  await cleanupSessionStateForTest({ stateDir });
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

function admission(runId: string, client: GatewayClient, childSessionKey?: string) {
  return resolveGatewayCronCreatorAuthorityAdmission({
    runId,
    resolvedSessionKey: SESSION,
    sessionId: SESSION_ID,
    client,
    request: { message: "Update the maintenance automation", idempotencyKey: runId },
    ...(childSessionKey
      ? {
          inputProvenance: {
            kind: "inter_session" as const,
            sourceTool: "subagent_settle",
            sourceSessionKey: childSessionKey,
          },
        }
      : {}),
    hasRestoredCronContinuation: false,
    isOneShotModelRun: false,
    isRestartRecoveryResumeRun: false,
  });
}

async function inRun<T>(
  runId: string,
  admitted: GatewayCronCreatorAuthorityAdmission | undefined,
  run: (identity: AgentRuntimeIdentity) => Promise<T>,
) {
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  registerAgentRunContext(runId, { agentId: "main", sessionKey: SESSION, sessionId: SESSION_ID });
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: SESSION,
    operationalRunInstance,
    delegatedAuthority: { kind: "local", ...authority },
  };
  const execute = () =>
    withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: SESSION,
        operationalRunInstance,
        approvalAuthority: authority,
      },
      () => run(identity),
    );
  try {
    if (!admitted) {
      return await execute();
    }
    const capability = expectDefined(
      createCronCreatorAuthorityCapability(
        runId,
        admitted.callerOrigin,
        admitted.managementEntitlement,
        admitted.isCurrent,
      ),
      "admitted cron capability",
    );
    admitted.bindRunScope?.(capability);
    return await runWithCronCreatorAuthorityCapability(capability, execute);
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
    clearAgentRunContext(runId);
  }
}

async function withSuccessor<T>(
  admin: boolean | "channel-owner",
  run: (identity: AgentRuntimeIdentity) => Promise<T>,
) {
  const originalRunId = "original-requester";
  const child = makeSettledChild({
    runId: "settled-child",
    requesterAgentId: "main",
    requesterSessionKey: SESSION,
    requesterTurnRunId: originalRunId,
    requesterSettleWake: undefined,
    completion: { required: true, resultText: "Maintenance review complete" },
  });
  const batch = [child];
  const runs = new Map([[child.runId, child]]);
  const persistOrThrow = (...ids: string[]) => saveSubagentRegistryChangesToSqlite(runs, ids);
  const requester = createSyntheticPluginRuntimeClient({
    scopes: admin ? ["operator.admin"] : ["operator.write"],
  });
  // The authenticated connection boundary supplies these facts; no model or
  // child result may promote the ordinary continuation below.
  requester.internal = admin === true ? { controlUiAdmin: true } : {};
  const admitted =
    admin === "channel-owner"
      ? {
          runId: originalRunId,
          callerOrigin: { kind: "unknown" as const },
          managementEntitlement: {
            source: "channel-owner" as const,
            isCurrent: () =>
              isConfiguredCommandOwner(getRuntimeConfig(), {
                channel: "discord",
                senderId: "owner-1",
              }),
          },
        }
      : admission(originalRunId, requester);
  if (admin === "channel-owner") {
    setRuntimeConfigSnapshot({ ...cfg, commands: { ownerAllowFrom: ["discord:owner-1"] } });
  }
  await inRun(originalRunId, admitted, async () => {
    expect(
      markRequesterTurnYieldedInRuns({
        requesterSessionKey: SESSION,
        requesterAgentId: "main",
        requesterTurnRunId: originalRunId,
        runs,
        persistOrThrow,
      }),
    ).toBe(1);
  });
  expect(
    settleRequesterTurnAfterSessionSpawns({
      requesterSessionKey: SESSION,
      requesterAgentId: "main",
      requesterTurnRunId: originalRunId,
      requesterYielded: true,
      acceptedSessionSpawns: [
        {
          runId: child.runId,
          childSessionKey: child.childSessionKey,
          expectsCompletionMessage: true,
        },
      ],
      runs,
      persistOrThrow,
      schedule: () => {},
    }),
  ).toBe(true);
  const runId = "successor-requester";
  return await withRequesterCronAuthority(
    {
      requesterSessionKey: SESSION,
      requesterSessionId: SESSION_ID,
      requesterAgentId: "main",
      batch,
      rearmGeneration: child.requesterSettleWake?.rearmGeneration,
      runId,
      isCurrent: () => true,
    },
    () =>
      inRun(
        runId,
        admission(runId, createSyntheticPluginRuntimeClient(), child.childSessionKey),
        async (identity) => {
          // Queue acceptance retires the committed outbox before tools finish.
          // Its fresh admitted run must now own management and revocation.
          runs.clear();
          persistOrThrow(child.runId);
          return await run(identity);
        },
      ),
  );
}

async function createStoredJob(listConfiguredChannels: () => Promise<string[]> = async () => []) {
  const storePath = path.join(stateDir, "cron", "jobs.json");
  cron = new CronService({
    storePath,
    cronEnabled: false,
    defaultAgentId: "main",
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    listConfiguredChannels,
  });
  const job = await cron.add(
    {
      name: "Maintenance",
      enabled: false,
      schedule: { kind: "every", everyMs: 1_800_000 },
      sessionTarget: "isolated",
      agentId: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "Check service health" },
      delivery: { mode: "none" },
      owner: { agentId: "main", sessionKey: "agent:main:telegram:dm:42", accountId: "telegram" },
    },
    {
      scheduledToolPolicy: { version: 1, mode: "trusted" },
      captureRuntimeAuthority: () => ({
        version: 1,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      }),
    },
  );
  const before = (await loadCronStore(storePath)).jobs;
  const runtimeAuthority = before[0]!.runtimeAuthority;
  expect(runtimeAuthority).toBeDefined();
  const context = createDirectChatContext({
    cron,
    cronStorePath: storePath,
    getRuntimeConfig: () => cfg,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
  });
  return {
    before,
    read: async () => (await loadCronStore(storePath)).jobs,
    runtimeAuthority,
    readRuntimeAuthority: async () => (await loadCronStore(storePath)).jobs[0]!.runtimeAuthority,
    update: async (identity: AgentRuntimeIdentity) => {
      const management = bindCronManagementGrant(identity.operationalRunInstance.runId);
      const client = createSyntheticPluginRuntimeClient();
      client.internal!.agentRuntimeIdentity = {
        ...identity,
        cronManagementGrant: management?.mint("cron.update"),
      };
      const respond = vi.fn<RespondFn>();
      const params = {
        id: job.id,
        patch: {
          name: "Reviewed maintenance",
          enabled: true,
          schedule: { kind: "every", everyMs: 3_600_000 },
          payload: { kind: "agentTurn", message: "Reviewed health check" },
          delivery: { mode: "none" },
        },
      };
      await expectDefined(
        cronHandlers["cron.update"],
        "cron.update",
      )({
        req: { type: "req", id: "update", method: "cron.update", params },
        params,
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      return expectDefined(respond.mock.calls[0], "cron update response");
    },
  };
}

describe("requester continuation persisted automation management", () => {
  it.each([true, false, "channel-owner"] as const)(
    "permits the stored mutation only for an admitted manager: %s",
    async (admin) => {
      const fixture = await createStoredJob();
      const [ok, result, error] = await withSuccessor(admin, fixture.update);
      expect(ok).toBe(Boolean(admin));
      if (admin) {
        expect(result).toMatchObject({ name: "Reviewed maintenance", enabled: true });
        expect(await fixture.read()).toMatchObject([
          {
            name: "Reviewed maintenance",
            enabled: true,
            scheduledToolPolicy: { version: 1, mode: "trusted" },
            owner: fixture.before[0]!.owner,
            schedule: { kind: "every", everyMs: 3_600_000 },
            payload: { kind: "agentTurn", message: "Reviewed health check" },
          },
        ]);
        expect(await fixture.readRuntimeAuthority()).toEqual(fixture.runtimeAuthority);
      } else {
        expect(error).toMatchObject({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("Automation not found"),
        });
        expect(await fixture.read()).toEqual(fixture.before);
      }
    },
  );

  it.each(["fresh user turn", "session reset", "global owner removal"])(
    "rejects %s revocation while the real update awaits validation",
    async (reason) => {
      const entered = createDeferred();
      const release = createDeferred();
      let hold = false;
      const fixture = await createStoredJob(async () => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        return [];
      });
      hold = true;
      const update = withSuccessor(
        reason === "global owner removal" ? "channel-owner" : true,
        fixture.update,
      );
      try {
        await Promise.race([
          entered.promise,
          update.then(() => {
            throw new Error("Update returned before reaching service validation");
          }),
        ]);
        expect(await fixture.read()).toEqual(fixture.before);
        if (reason === "global owner removal") {
          setRuntimeConfigSnapshot(cfg);
        } else if (reason === "fresh user turn") {
          const requester = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
          requester.internal = {};
          admission("new-user-turn", requester);
        } else {
          replaceSessionEntrySync(
            { sessionKey: SESSION },
            { sessionId: SESSION_ID, updatedAt: 2, lifecycleRevision: "reset" },
          );
        }
      } finally {
        release.resolve();
        // Join the real mutation before teardown, without replacing an assertion failure.
        await update.catch(() => undefined);
      }
      const [ok, , error] = await update;
      expect(ok).toBe(false);
      expect(error).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("Automation admin grant"),
      });
      expect(await fixture.read()).toEqual(fixture.before);
    },
  );
});
