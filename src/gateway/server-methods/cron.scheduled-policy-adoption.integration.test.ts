import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
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
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { readCronRunRecords } from "../../cron/store/read-only.js";
import { recordCronRun } from "../../cron/store/run-history.js";
import { resolveCronAuthenticatedCallerOrigin } from "../../cron/tools-allow-provenance.js";
import { resolveCronRunToolsAllow } from "../../cron/tools-allow.js";
import type { CronJobPatch } from "../../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { mintCronCreatorAuthorityGrant } from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient, RespondFn } from "./types.js";

const sessionKey = "agent:main:discord:group:policy-adoption";
const sessionId = "scheduled-policy-session";
const accountId = "work";
const cfg: OpenClawConfig = {
  agents: { entries: { main: {} } },
  commands: { ownerAllowFrom: ["discord:owner-1"] },
};
const accountPolicy = {
  version: 1,
  mode: "account",
  ownerSessionKey: sessionKey,
  ownerAccountId: accountId,
} as const;
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
  fresh: boolean | "channel" = false,
): Promise<T> {
  const runId = "scheduled-policy-management";
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  registerAgentRunContext(runId, { agentId: "main", sessionKey, sessionId });
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey,
    ...(fresh === "channel" ? {} : { turnSourceChannel: "discord" }),
    turnSourceAccountId: accountId,
    operationalRunInstance,
    delegatedAuthority: { kind: "local", ...authority },
  };
  try {
    const capability = expectDefined(
      createCronCreatorAuthorityCapability(
        runId,
        fresh
          ? fresh === "channel"
            ? { kind: "external", channel: "discord" }
            : { kind: "local" }
          : { kind: "unknown" },
        {
          source: "channel-owner",
          isCurrent: () =>
            isConfiguredCommandOwner(getRuntimeConfig(), {
              channel: "discord",
              senderId: "owner-1",
            }),
        },
      ),
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

describe("cron.update scheduled policy adoption", () => {
  it.each([
    "owner",
    "known tool",
    "legacy owner",
    "wildcard owner",
    "channel owner",
    "other session",
    "other account",
    "borrowed capture",
    "no capture",
    "creator revoked before commit",
    "management revoked before commit",
  ] as const)("captures owner authority and preserves manager cap edits: %s", async (caller) => {
    const revokesCreator = caller === "creator revoked before commit";
    const revokesManagement = caller === "management revoked before commit";
    const revokesGrant = revokesCreator || revokesManagement;
    const creatorLifetime = new AbortController();
    const managementLifetime = new AbortController();
    const reachedCommit = createDeferred();
    const continueCommit = createDeferred();
    const isOwner =
      revokesGrant ||
      ["owner", "known tool", "legacy owner", "wildcard owner", "channel owner"].includes(caller);
    const toolsAllow =
      caller === "channel owner" ? null : caller === "wildcard owner" ? ["*"] : ["calendar_search"];
    const storePath = path.join(expectDefined(stateDir, "test state"), "cron", "jobs.json");
    const serviceDeps = {
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    };
    let service = new CronService(serviceDeps);
    cron = service;
    const owner = {
      agentId: "main",
      sessionKey:
        caller === "other session" || caller === "borrowed capture"
          ? "agent:main:other"
          : sessionKey,
      accountId: caller === "other account" ? "personal" : accountId,
    };
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
      ...(caller === "wildcard owner" ? { allowOwnerToolDefaults: true as const } : {}),
    };
    const created = await service.add(
      {
        name: "App automation",
        enabled: caller !== "legacy owner",
        schedule: { kind: "every", everyMs: 3_600_000 },
        agentId: "main",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "Check calendar",
          toolsAllow: ["read", "calendar_search"],
        },
        delivery: { mode: "none" },
        owner,
      },
      {
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: owner.sessionKey,
          ownerAccountId: owner.accountId,
        },
        ...(caller === "legacy owner" ? {} : { captureRuntimeAuthority: () => runtimeAuthority }),
        toolsAllowProvenance: {
          version: 1,
          source: "final-executable-surface",
          callerOrigin: { kind: "unknown" },
        },
      },
    );
    if (caller === "legacy owner") {
      await recordCronRun({
        storeKey: cronStoreKey(storePath),
        jobId: created.id,
        runId: "pre-reauthorization-run",
        agentId: "main",
        startedAt: 10,
        endedAt: 20,
        sessionKey,
        status: "failed",
        detail: {
          kind: "cron-run",
          storeKey: cronStoreKey(storePath),
          status: "error",
          summary: "App authority missing",
        },
      });
      service.stop();
      service = new CronService(serviceDeps);
      cron = service;
    }
    const historyBefore =
      caller === "legacy owner"
        ? await readCronRunRecords(cronStoreKey(storePath), created.id)
        : undefined;
    const before = (await loadCronStore(storePath)).jobs;
    if (revokesGrant) {
      const updateWithPrecondition = service.updateWithPrecondition.bind(service);
      vi.spyOn(service, "updateWithPrecondition").mockImplementation(
        (id, patch, precondition, options) =>
          updateWithPrecondition(
            id,
            patch,
            async (job, now) => {
              await precondition(job, now);
              reachedCommit.resolve();
              await continueCommit.promise;
            },
            options,
          ),
      );
    }
    if (caller === "legacy owner") {
      expect(before[0]?.runtimeAuthority).toBeUndefined();
    }
    const context = createDirectChatContext({
      cron: service,
      cronStorePath: storePath,
      getRuntimeConfig: () => cfg,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    const freshOwner = caller === "channel owner" ? "channel" : true;
    await withAgentManagement(async (identity, management, capability) => {
      const tool = createCronTool(
        {
          runId: identity.operationalRunInstance.runId,
          agentSessionKey: sessionKey,
          agentAccountId: accountId,
          creatorToolAllowlist: caller === "known tool" ? ["calendar_search"] : ["read"],
          ...(caller === "no capture"
            ? {}
            : {
                resolveCreatorToolAuthority: async () => ({
                  tools: isOwner ? ["calendar_search"] : [],
                  provenance: { version: 1, source: "final-executable-surface" },
                  grant: mintCronCreatorAuthorityGrant(
                    capability,
                    creatorLifetime.signal,
                    runtimeAuthority,
                  ),
                  holdsRuntimeAuthority: true,
                }),
              }),
        },
        {
          callGatewayTool: async <T>(method: string, _options: unknown, params: unknown) => {
            if (!isRecord(params)) {
              throw new Error("Cron tool transport requires object parameters");
            }
            const callerIdentity = getGatewayToolCallerIdentity();
            const client = createSyntheticPluginRuntimeClient();
            client.internal = {
              ...client.internal,
              agentRuntimeIdentity: {
                ...identity,
                ...callerIdentity,
                ...(revokesManagement && method === "cron.update"
                  ? { cronManagementGrant: management.mint(method, managementLifetime.signal) }
                  : {}),
                ...(caller === "borrowed capture" && method === "cron.update"
                  ? {
                      cronToolsAllowCapture: "final-executable-surface",
                      cronCreatorAuthorityGrant: mintCronCreatorAuthorityGrant(
                        capability,
                        undefined,
                        runtimeAuthority,
                      ),
                    }
                  : {}),
              },
            };
            const respond = vi.fn<RespondFn>();
            await expectDefined(
              cronHandlers[method],
              method,
            )({
              req: { type: "req", id: "app-authority", method, params },
              params,
              client,
              context,
              respond,
              isWebchatConnect: () => false,
            });
            const [ok, result, error] = expectDefined(respond.mock.calls[0], "response");
            if (!ok) {
              throw new Error(error?.message);
            }
            return result as T;
          },
        },
      );
      const update = tool.execute("app-update", {
        action: "update",
        jobId: created.id,
        job: { payload: { toolsAllow } },
      });
      if (revokesGrant) {
        try {
          await awaitGateBeforeSettlement(
            reachedCommit.promise,
            update,
            "update skipped locked validation",
          );
          (revokesCreator ? creatorLifetime : managementLifetime).abort();
        } finally {
          continueCommit.resolve();
        }
        await expect(update).rejects.toThrow(revokesCreator ? /no longer active/ : /admin grant/);
      } else if (caller === "no capture") {
        await expect(update).rejects.toThrow(/calendar_search.*[Rr]ecreate/);
      } else {
        await expect(update).resolves.toMatchObject({ details: { id: created.id } });
      }
    }, freshOwner);
    const stored = (await loadCronStore(storePath)).jobs;
    if (revokesGrant) {
      expect(stored).toEqual(before);
      expect(await service.readJob(created.id)).toEqual(before[0]);
    } else if (isOwner) {
      expect(stored[0]).toMatchObject({
        owner,
        runtimeAuthority,
        payload: {
          toolsAllow: ["calendar_search"],
          ...(caller === "wildcard owner" ? { toolsAllowIsDefault: true } : {}),
        },
      });
      expect(stored[0]).toMatchObject({
        id: created.id,
        name: created.name,
        enabled: created.enabled,
        schedule: created.schedule,
        state: created.state,
        createdAtMs: created.createdAtMs,
        delivery: created.delivery,
        payload: { kind: "agentTurn", message: "Check calendar" },
      });
      expect(stored[0]?.runtimeAuthorityRecoveryRequired).toBeUndefined();
      expect(resolveCronRunToolsAllow(expectDefined(stored[0], "stored job"))).toEqual(
        toolsAllow ?? ["calendar_search"],
      );
      if (caller === "channel owner") {
        service.stop();
        cron = new CronService(serviceDeps);
        const reopened = expectDefined(await cron.readJob(created.id), "reauthorized owner job");
        expect(resolveCronAuthenticatedCallerOrigin(reopened)).toEqual({
          kind: "external",
          channel: "discord",
        });
      }
      if (caller === "legacy owner") {
        expect(historyBefore).toHaveLength(1);
        service.stop();
        cron = new CronService(serviceDeps);
        expect(await cron.readJob(created.id)).toEqual(stored[0]);
        expect(await readCronRunRecords(cronStoreKey(storePath), created.id)).toEqual(
          historyBefore,
        );
      }
    } else if (caller === "no capture") {
      expect(stored).toEqual(before);
    } else {
      expect(stored[0]).toMatchObject({
        owner,
        payload: { toolsAllow: ["calendar_search"] },
        runtimeAuthorityRecoveryRequired: true,
      });
      expect(stored[0]?.runtimeAuthority).toBeUndefined();
    }
  });

  it.each([
    { caller: "agent management", definition: "known account", expected: accountPolicy },
    { caller: "operator", definition: "known account", expected: accountPolicy },
    { caller: "agent management", definition: "erased policy", expected: undefined },
    { caller: "operator", definition: "erased policy", expected: { version: 1, mode: "trusted" } },
  ] as const)(
    "applies the authorized policy when $caller restores $definition",
    async ({ caller, definition, expected }) => {
      const storePath = path.join(
        expectDefined(stateDir, "test state directory"),
        "cron",
        "jobs.json",
      );
      const service = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      cron = service;
      const owner = { agentId: "main", sessionKey, accountId };
      const created = await service.add(
        {
          name: "Scheduled account policy",
          enabled: true,
          schedule: { kind: "every", everyMs: 3_600_000 },
          agentId: "main",
          sessionKey,
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "Check status", toolsAllow: ["message"] },
          delivery: { mode: "none" },
          owner,
        },
        { scheduledToolPolicy: accountPolicy },
      );
      const context = createDirectChatContext({
        cron: service,
        cronStorePath: storePath,
        getRuntimeConfig: () => cfg,
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      });
      const update = async (client: GatewayClient, patch: CronJobPatch) => {
        const params = { id: created.id, patch };
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          cronHandlers["cron.update"],
          "cron.update",
        )({
          req: { type: "req", id: "policy-update", method: "cron.update", params },
          params,
          client,
          context,
          respond,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledOnce();
        const [ok, result, error] = expectDefined(respond.mock.calls[0], "cron update response");
        expect({ ok, error }).toEqual({ ok: true, error: undefined });
        expect(result).toMatchObject({ id: created.id });
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
          expect(
            (await loadCronStore(storePath)).jobs.find((job) => job.id === created.id)
              ?.scheduledToolPolicy,
          ).toBeUndefined();
        }
        await callUpdate({
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Check status" },
        });
        const restored = expectDefined(
          (await loadCronStore(storePath)).jobs.find((job) => job.id === created.id),
          "restored job",
        );
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
});
