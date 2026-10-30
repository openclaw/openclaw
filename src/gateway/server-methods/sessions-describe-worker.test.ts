import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "../../agents/subagents/registry/subagent-run-generation.js";
import {
  bindSwarmRunReservation,
  holdQueuedSwarmRun,
  reserveSwarmRun,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { holdSubagentExecution } from "../session-row-projection.read-fixture.test-support.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { sessionTitleRequests } from "../session-title-state.js";
import { reportPlacementTransition } from "../worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { sessionReader } from "./sessions-keyed-read.test-support.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const targetKey = "agent:main:controller";
const expectSession = (response: unknown, session: unknown) =>
  expect(response).toMatchObject({ session });
const putSession = (key: string, entry: Parameters<typeof upsertSessionEntryCore>[1]) =>
  upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
const seedSession = (key: string, entry: Parameters<typeof putSession>[1] = {}) =>
  putSession(key, { sessionId: key, updatedAt: Date.now(), ...entry });
const deleteSession = (key: string) =>
  deleteSessionEntryLifecycle({
    agentId: "main",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    target: { canonicalKey: key, storeKeys: [key] },
    archiveTranscript: false,
  });
const readerRoles = (
  others: "view" | "none",
): NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]> => ({
  default: "reader",
  definitions: { reader: { agents: "*", scopes: ["operator.read"], sessions: { others } } },
});

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

function collectorRun(runId: string, groupId: string) {
  return retainedRun(runId, {
    collect: true,
    groupId,
    swarmRequesterSessionKey: targetKey,
    collectorCompletion: { status: "done" },
  });
}

function registerRun(run: SubagentRunRecord) {
  subagentRuns.set(run.runId, run);
  return { [Symbol.dispose]: () => subagentRuns.delete(run.runId) };
}

async function describeSession(
  context: GatewayRequestContext,
  client: GatewayClient,
  key = targetKey,
) {
  await initializeSessionReadContext(context);
  return sessionReader(context, client, key)();
}

async function withFixture(
  run: (fixture: {
    cfg: OpenClawConfig;
    context: GatewayRequestContext;
    viewer: GatewayClient;
    retainedRunIds: string[];
    describe: (key?: string) => Promise<unknown>;
    afterChange: (update: () => Promise<void> | void, key?: string) => Promise<unknown>;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { model: "openai/gpt-5.6-sol" } },
        gateway: { roles: readerRoles("view") },
      };
      setRuntimeConfigSnapshot(cfg);
      const ownerId = ensureProfileForEmail("owner@example.com").id;
      const viewer = identifiedClient(ensureProfileForEmail("viewer@example.com").id);
      await seedSession(targetKey, {
        sessionId: "original",
        label: "Original",
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: ownerId },
      });
      await seedSession("agent:main:subagent:run-0", {
        sessionId: "off-page-child",
        spawnedBy: "agent:main:off-page-requester",
      });
      const records = Array.from({ length: 64 }, (_, i) =>
        retainedRun(`run-${i}`, {
          controllerSessionKey: i === 0 ? targetKey : `agent:main:other-${i}`,
        }),
      );
      records.push(collectorRun("deleted-collector", "retained-group"));
      saveSubagentRegistryToSqlite(new Map(records.map((entry) => [entry.runId, entry])));
      clearSubagentRunsReadCacheForTest();
      const context = requestContext(cfg);
      context.getRuntimeConfig = () => getRuntimeConfigSnapshot() ?? cfg;
      try {
        await run({
          cfg,
          context,
          viewer,
          retainedRunIds: records.map((entry) => entry.runId),
          describe: (key) => describeSession(context, viewer, key),
          afterChange: (update, key) =>
            afterCommittedChange(context, () => describeSession(context, viewer, key), update),
        });
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
  const prepare = projection.prepareSelection.bind(projection);
  const paused = createDeferredCore();
  const released = createDeferredCore();
  const readiness = vi
    .spyOn(projection, "prepareSelection")
    .mockImplementationOnce(async (...args) => {
      const result = await prepare(...args);
      paused.resolve();
      await released.promise;
      return result;
    });
  const request = start();
  try {
    expect(
      await Promise.race([paused.promise.then(() => "paused"), request.then(() => "responded")]),
    ).toBe("paused");
    expect(readiness).toHaveBeenCalledOnce();
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

it("reuses unchanged descriptions across readers while sampling pending titles live", () =>
  withFixture(async ({ context, describe }) => {
    await describe();
    const projection = getSessionRowProjection(context)!;
    using present = vi.spyOn(projection, "present");
    const owner = identifiedClient(ensureProfileForEmail("owner@example.com").id);
    const readOwner = () => describeSession(context, owner);
    const viewerRow = await describe();
    const ownerRow = await readOwner();
    expect(viewerRow).toMatchObject({ session: { sharingRole: "viewer", titlePending: false } });
    expect(ownerRow).toMatchObject({ session: { sharingRole: "owner", titlePending: false } });
    for (let index = 0; index < 3; index++) {
      expectSession(await describe(), { sharingRole: "viewer", titlePending: false });
      expectSession(await readOwner(), { sharingRole: "owner", titlePending: false });
    }
    expect(present).toHaveBeenCalledTimes(1);
    const record = projection.describe({ agentId: "main", key: targetKey })!;
    const generation = createDeferredCore<boolean>();
    const pending = sessionTitleRequests.run(
      { storePath: record.storeTarget.storePath, sessionKey: targetKey, sessionId: "original" },
      () => generation.promise,
    );
    try {
      expectSession(await describe(), { titlePending: true, sharingRole: "viewer" });
      expectSession(await readOwner(), { titlePending: true, sharingRole: "owner" });
    } finally {
      generation.resolve(false);
      await pending;
    }
    expectSession(await describe(), { titlePending: false, sharingRole: "viewer" });
    expectSession(await readOwner(), { titlePending: false, sharingRole: "owner" });
    expect(viewerRow).toMatchObject({ session: { titlePending: false } });
  }));

it("captures current registry facts after list owner publications", () =>
  withFixture(async ({ context, viewer, retainedRunIds, describe }) => {
    await describe();
    const current = retainedRun("current-memory", {
      childSessionKey: targetKey,
      controllerSessionKey: "agent:main:current-controller",
      execution: { status: "running", startedAt: Date.now() },
    });
    using _ = holdSubagentExecution(current.runId, targetKey);
    try {
      const response = await whilePaused(
        context,
        () =>
          listSessions({ client: viewer, context, request: { limit: 100 } }).then((result) => ({
            session: result.sessions.find((row) => row.key === targetKey),
          })),
        () => {
          const published = collectorRun("current-persisted", "current-group");
          persistRegistryFixture(new Map([[published.runId, published]]), [
            ...retainedRunIds,
            published.runId,
          ]);
          subagentRuns.set(current.runId, current);
          subagentRuns.commitOwnership(current);
        },
      );
      expectSession(response, {
        controlOwnerSessionKey: "agent:main:current-controller",
        swarm: { groups: [{ groupId: "current-group", done: 1 }] },
      });
      expect(JSON.stringify(response)).not.toContain("retained-group");
    } finally {
      subagentRuns.delete(current.runId);
    }
  }));

it("projects current target, lineage, children and placement after committed changes", () =>
  withFixture(async ({ context, afterChange }) => {
    const childKey = "agent:main:direct-child";
    const removedKey = "agent:main:removed-child";
    for (const key of [childKey, removedKey]) {
      await seedSession(key, { parentSessionKey: targetKey });
    }
    await seedSession("agent:main:current-parent", {
      sessionId: "current-parent",
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    });
    const placements = createWorkerSessionPlacementStore();
    context.workerSessionPlacementService = placements;
    const response = await afterChange(async () => {
      await putSession(targetKey, {
        sessionId: "replacement",
        label: "Current conversation",
        parentSessionKey: "agent:main:current-parent",
      });
      await putSession(childKey, {
        parentSessionKey: "agent:main:other",
        spawnedBy: "agent:main:other",
      });
      await deleteSession(removedKey);
      reportPlacementTransition(
        undefined,
        await placements.startDispatch({
          sessionId: "replacement",
          agentId: "main",
          sessionKey: targetKey,
        }),
      );
    });
    expectSession(response, {
      sessionId: "replacement",
      label: "Current conversation",
      modelProvider: "openai",
      model: "gpt-5.5",
      modelOverrideSource: "inherited",
      placement: { state: "requested" },
      childSessions: undefined,
      swarm: {
        groups: [
          {
            groupId: "retained-group",
            done: 1,
            children: [{ sessionKey: "agent:main:subagent:deleted-collector", status: "done" }],
          },
        ],
      },
    });
    expect(JSON.stringify(response)).not.toContain("synthetic retained");
  }));

it.each(["role", "creator alias"] as const)(
  "rechecks sharing visibility after a %s change before the synchronous read",
  (change) =>
    withFixture(async ({ cfg, viewer, afterChange }) => {
      const response = await afterChange(async () => {
        if (change === "role") {
          const next: OpenClawConfig = {
            ...cfg,
            gateway: { roles: readerRoles("none") },
          };
          setRuntimeConfigSnapshot(next);
        } else {
          linkEmail("owner@example.com", viewer.authenticatedUserProfile!.profileId);
          await putSession(targetKey, { visibility: "draft" });
        }
      });
      expect(response).toMatchObject(
        change === "creator alias"
          ? { session: { sessionId: "original", sharingRole: "owner" } }
          : { session: null },
      );
    }),
);

it.each(["agent", "main alias"] as const)(
  "resolves the current %s after committed changes",
  (route) =>
    withFixture(async ({ cfg, context, describe, afterChange }) => {
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
      context.readPreparedGatewayModelCatalog = async (options?: { agentId?: string }) =>
        options?.agentId === "main" ? catalog : undefined;
      setRuntimeConfigSnapshot(initial);
      const key = route === "agent" ? "global" : "agent:main:main";
      expectSession(await describe(key), {
        agentId: "main",
        thinkingLevels: [],
      });
      const response = await afterChange(async () => {
        if (route === "main alias") {
          await deleteSession("agent:main:main");
        }
        setRuntimeConfigSnapshot(next);
      }, key);
      expectSession(response, {
        key: "global",
        agentId: route === "agent" ? "work" : "main",
        sessionId: route === "agent" ? "work-global" : "main-global",
        thinkingLevels:
          route === "agent" ? expect.arrayContaining([{ id: "low", label: "low" }]) : [],
      });
    }),
);

it("does not promote historical control after the current executor retires", () =>
  withFixture(async ({ describe, afterChange }) => {
    const now = Date.now();
    using clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const older = retainedRun("current-executor", {
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
    using _ = registerRun(older);
    using execution = holdSubagentExecution(older.runId, targetKey);
    saveSubagentRegistryToSqlite(new Map([older, newer].map((run) => [run.runId, run])));
    clearSubagentRunsReadCacheForTest();
    expectSession(await describe(), {
      controlOwnerSessionKey: older.controllerSessionKey,
    });
    const response = await afterChange(() => {
      execution[Symbol.dispose]();
      clock.mockReturnValue(now + 1);
    });
    expectSession(response, { controlOwnerSessionKey: undefined });
  }));

it.each(["executor", "reservation"] as const)(
  "rechecks the sole %s owner after committed changes",
  (owner) =>
    withFixture(async ({ describe, afterChange }) => {
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
      const reservationReleases: Promise<void>[] = [];
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
        bindSwarmRunReservation(run.runId, getSubagentRunRuntimeKey(run));
      }
      try {
        expectSession(await describe(), { hasActiveSubagentRun: true });
        const response = await afterChange(() => {
          if (owner === "executor") {
            releaseAgentRunContext(run.runId, claim);
          } else {
            const hold = holdQueuedSwarmRun(run.runId);
            const withdrawn = hold?.withdraw();
            if (hold) {
              reservationReleases.push(hold.release());
            }
            expect(withdrawn).toBe(true);
          }
        });
        expectSession(response, { hasActiveSubagentRun: undefined });
      } finally {
        releaseAgentRunContext(run.runId, claim);
        const hold = holdQueuedSwarmRun(run.runId);
        if (hold) {
          hold.withdraw();
          reservationReleases.push(hold.release());
        }
        subagentRuns.delete(run.runId);
        await Promise.all(reservationReleases);
      }
    }),
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
  await withFixture(async ({ describe }) => {
    await putSession(targetKey, { visibility: "draft" });
    expect(await describe()).toEqual({ session: null });
  });
});
