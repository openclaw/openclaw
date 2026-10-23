import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  bindCronManagementGrant,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import * as gatewayModule from "../../agents/tools/gateway.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronService } from "../../cron/service.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import type { CronJobCreate, CronJobPatch } from "../../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { mintCronCreatorAuthorityGrant } from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { callCron, createHistoryJob, createReadService } from "./cron-read.test-support.js";
import { cronAccountPolicy, requireRecord } from "./cron.validation.test-support.js";
import type { GatewayClient } from "./types.js";

const sessionKey = "agent:main:discord:group:policy-adoption";
const sessionId = "scheduled-policy-session";
const accountId = "work";
const cfg: OpenClawConfig = {
  agents: { entries: { main: {} } },
  commands: { ownerAllowFrom: ["discord:owner-1"] },
};
const accountPolicy = cronAccountPolicy(sessionKey, accountId);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string | undefined;
let cron: CronService | undefined;

beforeEach(() => {
  stateDir = tempDirs.make("openclaw-scheduled-policy-adoption-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot(cfg);
  replaceSessionEntrySync(
    { sessionKey },
    { sessionId, updatedAt: 1, lifecycleRevision: "policy-adoption" },
  );
});

afterEach(async () => {
  cron?.stop();
  cron = undefined;
  if (stateDir) {
    await cleanupSessionStateForTest({ stateDir });
  }
  stateDir = undefined;
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function withAgentManagement<T>(
  run: (
    identity: AgentRuntimeIdentity,
    management: NonNullable<ReturnType<typeof bindCronManagementGrant>>,
    capability: NonNullable<ReturnType<typeof createCronCreatorAuthorityCapability>>,
  ) => Promise<T>,
  fresh = false,
): Promise<T> {
  const runId = "scheduled-policy-management";
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  registerAgentRunContext(runId, { agentId: "main", sessionKey, sessionId });
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey,
    turnSourceChannel: "discord",
    turnSourceAccountId: accountId,
    operationalRunInstance,
    delegatedAuthority: { kind: "local", ...authority },
  };
  try {
    const capability = expectDefined(
      createCronCreatorAuthorityCapability(runId, fresh ? { kind: "local" } : { kind: "unknown" }, {
        source: "channel-owner",
        isCurrent: () =>
          isConfiguredCommandOwner(getRuntimeConfig(), {
            channel: "discord",
            senderId: "owner-1",
          }),
      }),
      "current management capability",
    );
    return await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey, operationalRunInstance, approvalAuthority: authority },
        () =>
          run(
            identity,
            expectDefined(bindCronManagementGrant(runId), "management binding"),
            capability,
          ),
      ),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
    clearAgentRunContext(runId);
  }
}

function createFixture() {
  const storePath = path.join(expectDefined(stateDir, "test state"), "cron", "jobs.json");
  const service = createReadService({
    storePath,
    cronEnabled: false,
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  cron = service;
  const context = createDirectChatContext({
    cron: service,
    cronStorePath: storePath,
    getRuntimeConfig: () => cfg,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
  });
  const makeJob = (overrides: Partial<CronJobCreate>): CronJobCreate => ({
    ...createHistoryJob("main", sessionKey, "Scheduled account policy"),
    enabled: true,
    schedule: { kind: "every", everyMs: 3_600_000 },
    payload: { kind: "agentTurn", message: "Check status", toolsAllow: ["message"] },
    ...overrides,
  });
  return { storePath, service, context, makeJob };
}

it.each([
  "owner",
  "known tool",
  "other session",
  "other account",
  "borrowed capture",
  "no capture",
] as const)("captures owner authority and preserves manager cap edits: %s", async (caller) => {
  const { storePath, service, context, makeJob } = createFixture();
  const owner = {
    agentId: "main",
    sessionKey:
      caller === "other session" || caller === "borrowed capture" ? "agent:main:other" : sessionKey,
    accountId: caller === "other account" ? "personal" : accountId,
  };
  const runtimeAuthority = {
    version: 1 as const,
    runtimeId: "codex",
    namespace: "codex.apps",
    payload: { apps: [{ id: "calendar" }] },
  };
  const created = await service.add(
    makeJob({
      payload: {
        kind: "agentTurn",
        message: "Check calendar",
        toolsAllow: ["read", "calendar_search"],
      },
      owner,
    }),
    {
      scheduledToolPolicy: {
        ...accountPolicy,
        ownerSessionKey: owner.sessionKey,
        ownerAccountId: owner.accountId,
      },
      captureRuntimeAuthority: () => runtimeAuthority,
    },
  );
  const before = (await loadCronStore(storePath)).jobs;
  await withAgentManagement(async (identity, _management, capability) => {
    const mint = () => mintCronCreatorAuthorityGrant(capability, undefined, runtimeAuthority);
    vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(
      async <T>(method: string, _options: unknown, params: unknown) => {
        const request = requireRecord(params, "Cron tool request");
        const client = createSyntheticPluginRuntimeClient();
        const agentRuntimeIdentity = { ...identity, ...getGatewayToolCallerIdentity() };
        if (caller === "borrowed capture" && method === "cron.update") {
          agentRuntimeIdentity.cronToolsAllowCapture = "final-executable-surface";
          agentRuntimeIdentity.cronCreatorAuthorityGrant = mint();
        }
        client.internal = { ...client.internal, agentRuntimeIdentity };
        const respond = await callCron(context, method, request, { client });
        const [ok, result, error] = expectDefined(respond.mock.calls[0], "response");
        if (!ok) {
          throw new Error(error?.message);
        }
        return result as T;
      },
    );
    const tool = createCronTool({
      runId: identity.operationalRunInstance.runId,
      agentSessionKey: sessionKey,
      agentAccountId: accountId,
      creatorToolAllowlist: caller === "known tool" ? ["calendar_search"] : ["read"],
      resolveCreatorToolAuthority:
        caller === "no capture"
          ? undefined
          : async () => ({
              tools: caller === "owner" || caller === "known tool" ? ["calendar_search"] : [],
              provenance: { version: 1, source: "final-executable-surface" },
              grant: mint(),
              holdsRuntimeAuthority: true,
            }),
    });
    const update = tool.execute("app-update", {
      action: "update",
      jobId: created.id,
      job: { payload: { toolsAllow: ["calendar_search"] } },
    });
    if (caller === "no capture") {
      await expect(update).rejects.toThrow(/calendar_search.*[Rr]ecreate/);
    } else {
      await expect(update).resolves.toMatchObject({ details: { id: created.id } });
    }
  }, true);
  const stored = (await loadCronStore(storePath)).jobs;
  if (caller === "no capture") {
    expect(stored).toEqual(before);
  } else {
    const owned = caller === "owner" || caller === "known tool";
    expect(stored[0]).toMatchObject({ owner, payload: { toolsAllow: ["calendar_search"] } });
    expect([stored[0]?.runtimeAuthority, stored[0]?.runtimeAuthorityRecoveryRequired]).toEqual(
      owned ? [runtimeAuthority, undefined] : [undefined, true],
    );
  }
});

it("lets the owner edit tools on a job without app authority from a native turn", async () => {
  const { storePath, service, context, makeJob } = createFixture();
  const owner = { agentId: "main", sessionKey, accountId };
  const created = await service.add(
    makeJob({
      payload: { kind: "agentTurn", message: "Sync mail", toolsAllow: ["read", "tool_call"] },
      owner,
    }),
    { scheduledToolPolicy: accountPolicy },
  );
  await withAgentManagement(async (identity) => {
    vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(
      async <T>(method: string, _options: unknown, params: unknown) => {
        const client = createSyntheticPluginRuntimeClient();
        client.internal = {
          ...client.internal,
          agentRuntimeIdentity: { ...identity, ...getGatewayToolCallerIdentity() },
        };
        const respond = await callCron(context, method, requireRecord(params, "request"), {
          client,
        });
        const [ok, result, error] = expectDefined(respond.mock.calls[0], "response");
        if (!ok) {
          throw new Error(error?.message);
        }
        return result as T;
      },
    );
    // A native runtime has no app authority resolver to capture.
    const tool = createCronTool({
      runId: identity.operationalRunInstance.runId,
      agentSessionKey: sessionKey,
      agentAccountId: accountId,
      creatorToolAllowlist: ["read", "dispatch_action"],
    });
    await expect(
      tool.execute("native-owner-update", {
        action: "update",
        jobId: created.id,
        job: { payload: { toolsAllow: ["read", "dispatch_action"] } },
      }),
    ).resolves.toMatchObject({ details: { id: created.id } });
  }, true);
  const [stored] = (await loadCronStore(storePath)).jobs;
  expect(stored).toMatchObject({
    owner,
    payload: { toolsAllow: ["read", "dispatch_action"] },
    scheduledToolPolicy: accountPolicy,
  });
});
it.each([
  { caller: "agent management", definition: "known account", expected: accountPolicy },
  { caller: "operator", definition: "known account", expected: accountPolicy },
  { caller: "agent management", definition: "erased policy", expected: undefined },
  { caller: "operator", definition: "erased policy", expected: { version: 1, mode: "trusted" } },
] as const)(
  "applies the authorized policy when $caller restores $definition",
  async ({ caller, definition, expected }) => {
    const { storePath, service, context, makeJob } = createFixture();
    const owner = { agentId: "main", sessionKey, accountId };
    const created = await service.add(makeJob({ sessionKey, owner }), {
      scheduledToolPolicy: accountPolicy,
    });
    const readJob = async () =>
      expectDefined(
        (await loadCronStore(storePath)).jobs.find((job) => job.id === created.id),
        "stored job",
      );
    const update = async (client: GatewayClient, patch: CronJobPatch) => {
      const respond = await callCron(context, "cron.update", { id: created.id, patch }, { client });
      expect(respond.mock.calls).toEqual([
        [true, expect.objectContaining({ id: created.id }), undefined],
      ]);
    };
    const exercise = async (callUpdate: (patch: CronJobPatch) => Promise<void>) => {
      await callUpdate({
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "Check status" },
      });
      const store = await loadCronStore(storePath);
      const dormant = expectDefined(
        store.jobs.find((job) => job.id === created.id),
        "dormant job",
      );
      expect(dormant).toMatchObject({
        sessionTarget: "main",
        payload: { kind: "systemEvent", toolsAllow: ["message"] },
        scheduledToolPolicy: accountPolicy,
      });
      if (definition === "erased policy") {
        // Canonical legacy state retained the tool cap without a scheduled policy.
        delete dormant.scheduledToolPolicy;
        await saveCronStore(storePath, store);
        expect((await readJob()).scheduledToolPolicy).toBeUndefined();
      }
      await callUpdate({
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Check status" },
      });
      const restored = await readJob();
      expect(restored).toMatchObject({
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", toolsAllow: ["message"] },
        owner,
      });
      expect(restored.scheduledToolPolicy).toEqual(expected);
    };
    if (caller === "agent management") {
      await withAgentManagement((identity, management) =>
        exercise((patch) => {
          const client = createSyntheticPluginRuntimeClient();
          client.internal = {
            ...client.internal,
            agentRuntimeIdentity: {
              ...identity,
              cronManagementGrant: management.mint("cron.update"),
            },
          };
          return update(client, patch);
        }),
      );
    } else {
      await exercise((patch) =>
        update(createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }), patch),
      );
    }
  },
);
