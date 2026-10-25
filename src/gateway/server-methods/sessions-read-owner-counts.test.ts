import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  assignSessionOwner,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../../config/sessions/session-accessor.sqlite-participants.native.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { mergeProfiles } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  identifiedClient,
  listSessions as readList,
  profileSessionEntry as profileEntry,
  requestContext,
} from "./sessions-read-cache.test-support.js";

const listSessions = (params: Parameters<typeof readList>[0]) =>
  readList({ ...params, acceptsSerializedJson: true });
const actor = (id: string) => ({ type: "human", source: "profile", id }) as const;
const mainScope = (name: string) => ({ agentId: "main", sessionKey: `agent:main:${name}` });
const count = (profileId: string, open: number, running = 0) => ({ profileId, open, running });
const byProfile = (a: { profileId: string }, b: { profileId: string }) =>
  a.profileId.localeCompare(b.profileId);
function retainRun(run: ReturnType<typeof createSubagentRunRecord>) {
  subagentRuns.set(run.runId, run);
  subagentRuns.commitOwnership(run);
}

afterEach(() => vi.restoreAllMocks());

function startRun(runId: string, sessionKey: string, agentId = "main") {
  registerAgentRunContext(runId, { sessionKey, agentId, projectSessionActive: true });
}
function finishRun(run: ReturnType<typeof createSubagentRunRecord>) {
  const completed = createSubagentRunRecord({
    ...run,
    execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } },
  });
  retainRun(completed);
}

it("counts caller-visible conversations once through direct and delegated work before pagination", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const ada = ensureProfileForEmail("counts-ada@example.test").id;
    const bob = ensureProfileForEmail("counts-bob@example.test").id;
    const context = requestContext({ agents: { entries: { main: {}, work: {} } } });
    setRuntimeConfigSnapshot(context.getRuntimeConfig());
    const client = identifiedClient(ada);
    const now = Date.now();
    const seed = (name: string, agentId = "main", fields: Partial<SessionEntry> = {}) => {
      const sessionKey = "agent:" + agentId + ":" + name;
      const scope = { agentId, sessionKey };
      const { owner, participants, ...entry } = fields;
      replaceSessionEntrySync(scope, { ...profileEntry(name, now, ada), ...entry });
      const ownerId = owner?.actor.id;
      if (owner && ownerId) {
        assignSessionOwner(scope, {
          owner: { type: owner.actor.type, id: ownerId },
          assignedBy: actor(ada),
        });
      }
      for (const participant of participants ?? []) {
        recordSessionParticipant(scope, { identity: participant.identity, promptedAt: now });
      }
      return sessionKey;
    };
    const idle = seed("idle");
    const running = seed("running", "main", {
      createdActor: actor(bob),
      owner: { actor: actor(ada) },
    });
    const remote = seed("remote", "work");
    const queued = seed("queued", "work");
    seed("stale", "main", { status: "interrupted" });
    seed("reassigned-to-ada", "main", { createdActor: actor(bob), owner: { actor: actor(ada) } });
    seed("reassigned-to-bob", "work", { owner: { actor: actor(bob) } });
    seed("own-draft", "main", { visibility: "draft" });
    const visibleChild = seed("dashboard:visible-child", "work", { spawnedBy: idle });
    seed("archive", "main", { archivedAt: now, status: "done" });
    const privateKey = seed("private", "work", { createdActor: actor(bob), visibility: "draft" });
    seed("incognito", "main", { incognito: true });
    const child = seed("subagent:hidden", "main", { spawnedBy: idle });
    const grandchild = seed("subagent:nested", "work", { spawnedBy: child });
    seed("cron:hidden");
    seed("system", "main", { createdActor: { type: "system" }, owner: { actor: actor(ada) } });
    seed("agent-owned", "main", {
      owner: { actor: { type: "agent", id: "main" } },
      participants: [{ identity: { type: "profile", id: ada } }],
    });
    const runIds = [
      "counts-running",
      "counts-duplicate",
      "counts-remote",
      "counts-queued",
      "counts-private",
    ] as const;
    for (const [runId, key, agentId] of [
      [runIds[0], running, "main"],
      [runIds[1], running, "main"],
      [runIds[2], remote, "work"],
      [runIds[3], queued, "work"],
      [runIds[4], privateKey, "work"],
    ] as const) {
      startRun(runId, key, agentId);
    }
    const releaseWait = registerAgentRunCapacityWait(runIds[3]!, getAgentRunLifecycleGeneration());
    const request: SessionsListParams = {
      includeOwnerSessionCounts: true,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
      limit: 1,
    };
    const expected = (open: number, active: number) =>
      [count(ada, open, active), count(bob, 1)].toSorted(byProfile);
    const read = (overrides: Partial<SessionsListParams> = {}) =>
      listSessions({ client, context, request: { ...request, ...overrides } });
    const expectCounts = async (
      open: number,
      active: number,
      overrides: Partial<SessionsListParams> = {},
    ) => {
      expect(await read(overrides)).toMatchObject({ ownerSessionCounts: expected(open, active) });
    };
    try {
      await read();
      const projection = getSessionRowProjection(context)!;
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      for (const offset of [0, 3, 100]) {
        expect((await read({ offset })).ownerSessionCounts).toEqual(expected(8, 2));
      }
      expect(prepares).not.toHaveBeenCalled();
      prepares.mockRestore();
      await expectCounts(8, 2, { archived: "all" });
      expect(await read({ archived: true })).toMatchObject({ ownerSessionCounts: [] });
      await expectCounts(3, 1, { agentId: "work" });
      expect(await read({ includeOwnerSessionCounts: false })).not.toHaveProperty(
        "ownerSessionCounts",
      );

      // Live registry changes, not persisted status, own the next count.
      clearAgentRunContext(runIds[0]!);
      clearAgentRunContext(runIds[1]!);
      releaseWait?.();
      await expectCounts(8, 2);
      clearAgentRunContext(runIds[2]!);
      clearAgentRunContext(runIds[3]!);
      await expectCounts(8, 0);

      startRun(runIds[0], visibleChild, "work");
      const releaseChildWait = registerAgentRunCapacityWait(
        runIds[0],
        getAgentRunLifecycleGeneration(),
      );
      try {
        await expectCounts(8, 0);
      } finally {
        releaseChildWait?.();
        clearAgentRunContext(runIds[0]);
      }

      // A yielded parent still owns working descendants, even when they are hidden from the list.
      const childRun = createSubagentRunRecord({
        runId: "counts-child",
        childSessionKey: child,
        requesterSessionKey: idle,
        controllerSessionKey: "agent:work:delegated-controller",
        startedAt: Date.now(),
      });
      const grandchildRun = createSubagentRunRecord({
        runId: "counts-grandchild",
        childSessionKey: grandchild,
        requesterSessionKey: child,
        startedAt: Date.now(),
      });
      retainRun(childRun);
      const delegated = await read({ limit: 100 });
      expect(delegated.sessions.find((row) => row.key === idle)).toMatchObject({
        hasActiveRun: false,
        hasActiveSubagentRun: true,
      });
      expect(delegated.ownerSessionCounts).toEqual(expected(8, 1));
      retainRun(grandchildRun);
      startRun(runIds[0], idle, "main");
      await expectCounts(8, 1);
      clearAgentRunContext(runIds[0]);
      finishRun(childRun);
      await expectCounts(8, 1);
      finishRun(grandchildRun);
      const selections = vi.spyOn(projection, "selectEntries");
      await expectCounts(8, 0);
      // Retained terminal history is not a candidate for the live running-count facet.
      expect(
        selections.mock.calls.filter(
          ([query]) => query?.sessionIdOrKey === idle || query?.sessionIdOrKey === child,
        ),
      ).toEqual([]);
      selections.mockRestore();
      // A later child turn has a new execution ID but retains the original parent lineage.
      startRun(runIds[0], grandchild, "work");
      await expectCounts(8, 1);
      clearAgentRunContext(runIds[0]);
      await expectCounts(8, 0);

      // A sharing/ownership change during readiness must affect the whole facet.
      const ensure = projection.prepareSelection;
      vi.spyOn(projection, "prepareSelection").mockImplementationOnce(async () => {
        assignSessionOwner(
          { agentId: "main", sessionKey: running },
          { owner: actor(bob), assignedBy: actor(ada) },
        );
        await patchSessionEntryCore(
          { agentId: "main", sessionKey: running },
          () => ({ visibility: "draft" }),
          { skipMaintenance: true },
        );
        await ensure();
      });
      await expectCounts(7, 0);
    } finally {
      subagentRuns.delete("counts-child");
      subagentRuns.delete("counts-grandchild");
      releaseWait?.();
      for (const runId of runIds) {
        clearAgentRunContext(runId);
      }
    }
  }));

it("keeps the owner summary complete beyond the people facet cap and resolves merged owners", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = requestContext({ agents: { entries: { main: {} } } });
    setRuntimeConfigSnapshot(context.getRuntimeConfig());
    const profiles = Array.from(
      { length: 61 },
      (_, i) => ensureProfileForEmail("count-owner-" + i + "@example.test").id,
    );
    for (const [index, profileId] of profiles.entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:owner-" + index },
        profileEntry("owner-session-" + index, 100, profileId),
      );
    }
    const client = identifiedClient(profiles[1]!);
    const request = { includeOwnerSessionCounts: true, includePeople: true, limit: 1 };
    const read = (involvingMe = false) =>
      listSessions({ client, context, request: { ...request, involvingMe } });
    const counts = profiles.map((profileId) => count(profileId, 1));
    expect(await read()).toMatchObject({
      ownerSessionCounts: counts.toSorted(byProfile),
      peopleIncomplete: true,
      count: 1,
    });
    expect(await read(true)).toMatchObject({ ownerSessionCounts: [count(profiles[1]!, 1)] });
    mergeProfiles(profiles[0]!, profiles[1]!);
    expect(await read()).toMatchObject({
      ownerSessionCounts: counts
        .slice(1)
        .map((row, i) => count(row.profileId, i === 0 ? 2 : 1))
        .toSorted(byProfile),
    });
    expect(await read(true)).toMatchObject({ ownerSessionCounts: [count(profiles[1]!, 2)] });
  }));

it("updates personal membership after owner, participant, and archive publications while retaining owner facets", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const ada = ensureProfileForEmail("membership-ada@example.test").id;
    const bob = ensureProfileForEmail("membership-bob@example.test").id;
    const context = requestContext({ agents: { entries: { main: {} } } });
    setRuntimeConfigSnapshot(context.getRuntimeConfig());
    const client = identifiedClient(ada);
    for (const [name, profileId] of [
      ["owned", ada],
      ["reassigned", bob],
      ["participant", bob],
    ] as const) {
      replaceSessionEntrySync(mainScope(name), profileEntry(name, 1, profileId));
    }
    const request = { involvingMe: true, includeOwnerSessionCounts: true, limit: 100 };
    const expectMembership = async (names: string[], counts: ReturnType<typeof count>[]) => {
      const result = await listSessions({ client, context, request });
      expect(result.sessions.map((row) => row.key).toSorted()).toEqual(
        names.map((name) => mainScope(name).sessionKey),
      );
      expect(result.ownerSessionCounts).toEqual(counts.toSorted(byProfile));
      return result;
    };
    const initial = await expectMembership(["owned"], [count(ada, 1)]);
    expect(initial.owners?.map((owner) => owner.identity?.id).toSorted()).toEqual(
      [ada, bob].toSorted(),
    );
    assignSessionOwner(mainScope("reassigned"), { owner: actor(ada), assignedBy: actor(bob) });
    recordSessionParticipant(mainScope("participant"), {
      identity: { type: "profile", id: ada },
      promptedAt: 10,
    });
    await expectMembership(["owned", "participant", "reassigned"], [count(ada, 2), count(bob, 1)]);
    await patchSessionEntryCore(mainScope("participant"), () => ({ archivedAt: 20 }));
    await expectMembership(["owned", "reassigned"], [count(ada, 2)]);
  }));
