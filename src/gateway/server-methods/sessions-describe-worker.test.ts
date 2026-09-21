import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import * as registryRead from "../../agents/subagents/registry/subagent-registry-read.js";
import {
  clearSubagentRunsReadCacheForTest,
  persistSubagentRunsToDisk,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import {
  bindSwarmRunReservation,
  removeQueuedSwarmRun,
  reserveSwarmRun,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  resolveSessionStorePathCore,
  SESSION_TOTAL_TOKENS_VERSION,
} from "../../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { reportPlacementTransition } from "../worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const targetKey = "agent:main:controller";
const targetScope = { agentId: "main", sessionKey: targetKey };

function retainedRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const now = Date.now();
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:off-page-requester",
    controllerSessionKey: targetKey,
    requesterAgentId: "main",
    requesterDisplayKey: "requester",
    task: "synthetic retained task",
    cleanup: "keep",
    createdAt: now - 100,
    execution: { status: "terminal", startedAt: now - 90, endedAt: now - 10 },
    completion: { required: false, resultText: "synthetic retained result" },
    delivery: { status: "not_required" },
    ...overrides,
  };
}

async function describeSession(
  context: GatewayRequestContext,
  client: GatewayClient,
  key = targetKey,
) {
  await initializeSessionReadContext(context);
  const responses: Parameters<RespondFn>[] = [];
  await sessionReadHandlers["sessions.describe"]!({
    req: { type: "req", id: "describe-projection", method: "sessions.describe", params: { key } },
    params: { key },
    context,
    client,
    isWebchatConnect: () => false,
    respond: (...response) => responses.push(response),
  });
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
  return responses[0]?.[1];
}

async function withFixture(
  run: (fixture: {
    cfg: OpenClawConfig;
    context: GatewayRequestContext;
    ownerId: string;
    viewer: GatewayClient;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { model: "openai/gpt-5.6-sol" } },
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const ownerId = ensureProfileForEmail("owner@example.com").id;
      const viewer = identifiedClient(ensureProfileForEmail("viewer@example.com").id);
      await upsertSessionEntryCore(targetScope, {
        sessionId: "original",
        updatedAt: Date.now(),
        label: "Original",
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: ownerId },
      });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:subagent:run-0" },
        {
          sessionId: "off-page-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:off-page-requester",
        },
      );
      const records = Array.from({ length: 64 }, (_, i) =>
        retainedRun(`run-${i}`, {
          controllerSessionKey: i === 0 ? targetKey : `agent:main:other-${i}`,
        }),
      );
      records.push(
        retainedRun("deleted-collector", {
          collect: true,
          groupId: "retained-group",
          swarmRequesterSessionKey: targetKey,
          collectorCompletion: { status: "done" },
        }),
      );
      saveSubagentRegistryToSqlite(new Map(records.map((entry) => [entry.runId, entry])));
      clearSubagentRunsReadCacheForTest();
      const context = requestContext(cfg);
      context.getRuntimeConfig = () => getRuntimeConfigSnapshot() ?? cfg;
      try {
        await run({ cfg, context, ownerId, viewer });
      } finally {
        getSessionRowProjection(context)?.dispose();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
}

async function whilePaused(
  context: GatewayRequestContext,
  start: () => Promise<unknown>,
  change: () => Promise<void> | void,
) {
  await initializeSessionReadContext(context);
  const projection = getSessionRowProjection(context)!;
  const ensure = projection.ensureMaterialized.bind(projection);
  const paused = createDeferredCore();
  const released = createDeferredCore();
  const readiness = vi.spyOn(projection, "ensureMaterialized").mockImplementationOnce(async () => {
    await ensure();
    paused.resolve();
    await released.promise;
  });
  const request = start();
  try {
    expect(
      await Promise.race([paused.promise.then(() => "paused"), request.then(() => "responded")]),
    ).toBe("paused");
    await change();
    released.resolve();
    return await request;
  } finally {
    released.resolve();
    await request.catch(() => {});
    readiness.mockRestore();
  }
}

async function afterCommittedChange(
  context: GatewayRequestContext,
  start: () => Promise<unknown>,
  change: () => Promise<void> | void,
) {
  await initializeSessionReadContext(context);
  const projection = getSessionRowProjection(context)!;
  await projection.ensureMaterialized();
  await change();
  const readiness = vi.spyOn(projection, "ensureMaterialized").mockImplementation(() => {
    throw new Error("describe must not join bulk readiness");
  });
  try {
    return await start();
  } finally {
    readiness.mockRestore();
  }
}

it.each(["describe", "list"] as const)(
  "captures current registry facts after %s owner publications",
  async (method) => {
    await withFixture(async ({ context, viewer }) => {
      await describeSession(context, viewer);
      const current = retainedRun("current-memory", {
        childSessionKey: targetKey,
        controllerSessionKey: "agent:main:current-controller",
      });
      try {
        const read = method === "list" ? whilePaused : afterCommittedChange;
        const response = await read(
          context,
          () =>
            method === "describe"
              ? describeSession(context, viewer)
              : listSessions({ client: viewer, context, request: { limit: 100 } }).then(
                  (result) => ({
                    session: result.sessions.find((row) => row.key === targetKey),
                  }),
                ),
          () => {
            const published = retainedRun("current-persisted", {
              collect: true,
              groupId: "current-group",
              swarmRequesterSessionKey: targetKey,
              collectorCompletion: { status: "done" },
            });
            persistSubagentRunsToDisk(new Map([[published.runId, published]]));
            subagentRuns.set(current.runId, current);
          },
        );
        expect(response).toMatchObject({
          session: {
            controlOwnerSessionKey: "agent:main:current-controller",
            swarm: { groups: [{ groupId: "current-group", done: 1 }] },
          },
        });
        expect(JSON.stringify(response)).not.toContain("retained-group");
      } finally {
        subagentRuns.delete(current.runId);
      }
    });
  },
);

it("projects current target, lineage, children and placement after committed changes", async () => {
  await withFixture(async ({ context, viewer }) => {
    const childKey = "agent:main:direct-child";
    const removedKey = "agent:main:removed-child";
    for (const key of [childKey, removedKey]) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId: key,
          updatedAt: Date.now(),
          parentSessionKey: targetKey,
        },
      );
    }
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:current-parent" },
      {
        sessionId: "current-parent",
        updatedAt: Date.now(),
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
      },
    );
    const placements = createWorkerSessionPlacementStore();
    context.workerSessionPlacementService = placements;
    const response = await afterCommittedChange(
      context,
      () => describeSession(context, viewer),
      async () => {
        await upsertSessionEntryCore(targetScope, {
          sessionId: "replacement",
          label: "Current conversation",
          parentSessionKey: "agent:main:current-parent",
        });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: childKey },
          {
            parentSessionKey: "agent:main:other",
            spawnedBy: "agent:main:other",
          },
        );
        await deleteSessionEntryLifecycle({
          agentId: "main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          target: { canonicalKey: removedKey, storeKeys: [removedKey] },
          archiveTranscript: false,
        });
        reportPlacementTransition(
          undefined,
          placements.startDispatch({
            sessionId: "replacement",
            agentId: "main",
            sessionKey: targetKey,
          }),
        );
      },
    );
    expect(response).toMatchObject({
      session: {
        sessionId: "replacement",
        label: "Current conversation",
        modelProvider: "openai",
        model: "gpt-5.5",
        modelOverrideSource: "inherited",
        placement: { state: "requested" },
        childSessions: ["agent:main:subagent:run-0"],
        swarm: {
          groups: [
            {
              groupId: "retained-group",
              done: 1,
              children: [{ sessionKey: "agent:main:subagent:deleted-collector", status: "done" }],
            },
          ],
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain("synthetic retained");
  });
});

it.each(["draft", "role", "creator alias"] as const)(
  "rechecks sharing visibility after a %s change before the synchronous read",
  async (change) => {
    await withFixture(async ({ cfg, context, viewer }) => {
      const response = await afterCommittedChange(
        context,
        () => describeSession(context, viewer),
        async () => {
          if (change === "role") {
            const next: OpenClawConfig = {
              ...cfg,
              gateway: {
                roles: {
                  default: "reader",
                  definitions: {
                    reader: {
                      agents: "*",
                      scopes: ["operator.read"],
                      sessions: { others: "none" },
                    },
                  },
                },
              },
            };
            setRuntimeConfigSnapshot(next);
          } else {
            if (change === "creator alias") {
              linkEmail("owner@example.com", viewer.authenticatedUserProfile!.profileId);
            }
            await upsertSessionEntryCore(targetScope, { visibility: "draft" });
          }
        },
      );
      expect(response).toMatchObject(
        change === "creator alias"
          ? { session: { sessionId: "original", sharingRole: "owner" } }
          : { session: null },
      );
    });
  },
);

it("resolves the current agent store and main alias after committed changes", async () => {
  for (const route of ["agent", "main alias"] as const) {
    await withFixture(async ({ cfg, context, viewer }) => {
      const initial: OpenClawConfig = {
        ...cfg,
        agents: {
          ownership: "explicit",
          entries: { main: {}, work: {} },
          defaults: { model: "openai/gpt-5.6-sol", systemAgent: { agentId: "main" } },
        },
      };
      const next: OpenClawConfig =
        route === "agent"
          ? {
              ...initial,
              agents: {
                ...initial.agents,
                defaults: { ...initial.agents?.defaults, systemAgent: { agentId: "work" } },
              },
            }
          : { ...initial, session: { scope: "global" } };
      for (const [agentId, key] of [
        ["main", "global"],
        ["work", "global"],
        ["main", "agent:main:main"],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId, sessionKey: key },
          {
            sessionId: `${agentId}-${key}`,
            updatedAt: Date.now(),
            visibility: "shared",
          },
        );
      }
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.providers.push({
        pluginId: "catalog-fixture",
        source: "test",
        provider: {
          id: "openai",
          label: "Catalog fixture",
          auth: [],
          resolveThinkingProfile: () => ({ levels: [] }),
        },
      });
      const catalog = {
        entries: [{ id: "gpt-5.6-sol", provider: "openai", name: "Fixture", reasoning: true }],
        pluginRegistry,
      };
      const catalogs = vi.fn(async (options?: { agentId?: string }) =>
        options?.agentId === "main" ? catalog : undefined,
      );
      context.readPreparedGatewayModelCatalog = catalogs;
      setRuntimeConfigSnapshot(initial);
      const key = route === "agent" ? "global" : "agent:main:main";
      expect(await describeSession(context, viewer, key)).toMatchObject({
        session: { agentId: "main", thinkingLevels: [] },
      });
      catalogs.mockClear();
      const response = await afterCommittedChange(
        context,
        () => describeSession(context, viewer, key),
        async () => {
          if (route === "main alias") {
            await deleteSessionEntryLifecycle({
              agentId: "main",
              storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
              target: { canonicalKey: "agent:main:main", storeKeys: ["agent:main:main"] },
              archiveTranscript: false,
            });
          }
          setRuntimeConfigSnapshot(next);
        },
      );
      expect(response).toMatchObject({
        session: {
          key: "global",
          agentId: route === "agent" ? "work" : "main",
          sessionId: route === "agent" ? "work-global" : "main-global",
          thinkingLevels:
            route === "agent" ? expect.arrayContaining([{ id: "low", label: "low" }]) : [],
        },
      });
    });
  }
});

it("projects elapsed runtime, status expiry and budget time after committed changes", async () => {
  await withFixture(async ({ context, viewer }) => {
    const startedAt = Date.now() - 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + 1000);
    const running = retainedRun("clock-running", {
      childSessionKey: targetKey,
      controllerSessionKey: "agent:main:parent",
      requesterSessionKey: "agent:main:parent",
      createdAt: startedAt,
      execution: { status: "running", startedAt },
    });
    let claim: string | undefined;
    try {
      await upsertSessionEntryCore(targetScope, {
        agentStatus: { note: "Working", expiresAt: startedAt + 2000 },
        totalTokens: 100,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        goal: {
          schemaVersion: 1,
          id: "clock-goal",
          objective: "Synthetic clock proof",
          status: "active",
          createdAt: startedAt,
          updatedAt: startedAt,
          tokenStart: 0,
          tokensUsed: 0,
          tokenBudget: 50,
          continuationTurns: 0,
        },
      });
      subagentRuns.set(running.runId, running);
      claim = claimAgentRunContext(
        running.runId,
        { sessionKey: targetKey },
        { trackOwner: true, ownsContext: true },
      );
      expect(registryRead.isSubagentRunLive(running)).toBe(true);
      expect(await describeSession(context, viewer)).toMatchObject({
        session: {
          status: "running",
          runtimeMs: 1000,
          agentStatus: { note: "Working" },
        },
      });
      const response = await afterCommittedChange(
        context,
        () => describeSession(context, viewer),
        () => {
          clock.mockReturnValue(startedAt + 6000);
        },
      );
      expect(response).toMatchObject({
        session: {
          status: "running",
          runtimeMs: 6000,
          agentStatus: undefined,
          goal: {
            status: "budget_limited",
            budgetLimitedAt: startedAt + 6000,
            updatedAt: startedAt + 6000,
          },
        },
      });
      expect(loadSessionEntry(targetScope)?.goal?.status).toBe("active");
    } finally {
      releaseAgentRunContext(running.runId, claim);
      subagentRuns.delete(running.runId);
      clock.mockRestore();
    }
  });
});

it("refreshes retained control ownership after committed changes", async () => {
  await withFixture(async ({ context, viewer }) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const older = retainedRun("expiring-owner", {
      childSessionKey: targetKey,
      controllerSessionKey: "agent:main:older-controller",
      requesterSessionKey: "agent:main:older-controller",
      createdAt: now - 2 * 60 * 60 * 1000,
      execution: { status: "running", startedAt: now - 2 * 60 * 60 * 1000 },
    });
    const newer = retainedRun("newer-ended-owner", {
      childSessionKey: targetKey,
      controllerSessionKey: "agent:main:newer-controller",
      requesterSessionKey: "agent:main:newer-controller",
      createdAt: now - 1000,
      execution: { status: "terminal", startedAt: now - 1000, endedAt: now - 10 },
    });
    try {
      saveSubagentRegistryToSqlite(new Map([older, newer].map((run) => [run.runId, run])));
      clearSubagentRunsReadCacheForTest();
      expect(await describeSession(context, viewer)).toMatchObject({
        session: { controlOwnerSessionKey: older.controllerSessionKey },
      });
      const response = await afterCommittedChange(
        context,
        () => describeSession(context, viewer),
        () => {
          clock.mockReturnValue(now + 1);
        },
      );
      expect(response).toMatchObject({
        session: { controlOwnerSessionKey: newer.controllerSessionKey },
      });
    } finally {
      clock.mockRestore();
    }
  });
});

it.each(["executor", "reservation"] as const)(
  "rechecks the sole %s owner after committed changes",
  async (owner) => {
    await withFixture(async ({ context, viewer }) => {
      const old = Date.now() - 3 * 60 * 60 * 1000;
      const run = retainedRun(`owned-${owner}`, {
        requesterSessionKey: targetKey,
        createdAt: old,
        execution:
          owner === "executor" ? { status: "running", startedAt: old } : { status: "queued" },
        collect: owner === "reservation",
        groupId: "owned-queue",
        swarmRequesterSessionKey: targetKey,
      });
      subagentRuns.set(run.runId, run);
      let claim: string | undefined;
      if (owner === "executor") {
        claim = claimAgentRunContext(
          run.runId,
          { sessionKey: run.childSessionKey },
          { trackOwner: true, ownsContext: true },
        );
      } else {
        expect(
          reserveSwarmRun({
            groupId: "owned-queue",
            runId: run.runId,
            maxConcurrent: 1,
            activeRunIds: [],
          }),
        ).toBe(true);
        bindSwarmRunReservation(run.runId, run);
      }
      try {
        expect(registryRead.isSubagentRunLive(run)).toBe(owner === "executor");
        expect(registryRead.isSubagentRunQueued(run)).toBe(owner === "reservation");
        expect(await describeSession(context, viewer)).toMatchObject({
          session: { hasActiveSubagentRun: true },
        });
        const response = await afterCommittedChange(
          context,
          () => describeSession(context, viewer),
          () => {
            if (owner === "executor") {
              releaseAgentRunContext(run.runId, claim);
            } else {
              expect(removeQueuedSwarmRun(run.runId)).toBe(true);
            }
          },
        );
        expect(response).toMatchObject({ session: { hasActiveSubagentRun: undefined } });
      } finally {
        releaseAgentRunContext(run.runId, claim);
        removeQueuedSwarmRun(run.runId);
        subagentRuns.delete(run.runId);
      }
    });
  },
);

it("returns no row for missing or hidden targets without provisioning missing storage", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const context = requestContext(cfg);
    const state = captureOpenClawStateWorkerContext();
    try {
      expect(
        await describeSession(context, sharingPolicyClient({ user: "viewer@example.com" })),
      ).toEqual({
        session: null,
      });
      expect(fs.existsSync(state.admission.databasePath)).toBe(false);
    } finally {
      getSessionRowProjection(context)?.dispose();
    }
  });
  await withFixture(async ({ context, viewer }) => {
    await upsertSessionEntryCore(targetScope, { visibility: "draft" });
    expect(await describeSession(context, viewer)).toEqual({ session: null });
  });
});
