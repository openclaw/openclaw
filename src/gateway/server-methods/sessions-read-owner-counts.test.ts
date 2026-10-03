import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
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
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("counts caller-visible open ownership and direct running work across agents before pagination", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const ada = ensureProfileForEmail("counts-ada@example.test").id;
    const bob = ensureProfileForEmail("counts-bob@example.test").id;
    const actor = (id: string) => ({ type: "human", source: "profile", id }) as const;
    const context = requestContext({
      agents: { entries: { main: { default: true }, work: {} } },
    });
    const client = identifiedClient(ada);
    const seed = (name: string, agentId = "main", fields: Partial<SessionEntry> = {}) => {
      const sessionKey = "agent:" + agentId + ":" + name;
      const scope = { agentId, sessionKey };
      const { owner, participants, ...entry } = fields;
      replaceSessionEntrySync(scope, {
        sessionId: name,
        updatedAt: 100,
        visibility: "shared",
        createdActor: actor(ada),
        ...entry,
      });
      const ownerId = owner?.actor.id;
      if (owner && ownerId) {
        assignSessionOwner(scope, {
          owner: { type: owner.actor.type, id: ownerId },
          assignedBy: actor(ada),
        });
      }
      for (const participant of participants ?? []) {
        recordSessionParticipant(scope, { identity: participant.identity, promptedAt: 100 });
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
    seed("stale", "main", { status: "running" });
    seed("reassigned-to-ada", "main", { createdActor: actor(bob), owner: { actor: actor(ada) } });
    seed("reassigned-to-bob", "work", { owner: { actor: actor(bob) } });
    seed("own-draft", "main", { visibility: "draft" });
    seed("dashboard:visible-child", "work", { spawnedBy: idle });
    seed("archive", "main", { archivedAt: 100, status: "running" });
    const privateKey = seed("private", "work", { createdActor: actor(bob), visibility: "draft" });
    seed("incognito", "main", { incognito: true });
    seed("subagent:hidden", "main", { spawnedBy: idle });
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
      registerAgentRunContext(runId!, { sessionKey: key, agentId, projectSessionActive: true });
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
      [
        { profileId: ada, open, running: active },
        { profileId: bob, open: 1, running: 0 },
      ].toSorted((a, b) => a.profileId.localeCompare(b.profileId));
    try {
      await listSessions({ client, context, request });
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      for (const offset of [0, 3, 100]) {
        const result = await listSessions({ client, context, request: { ...request, offset } });
        expect(result).toHaveProperty("ownerSessionCounts.length", 2);
        for (const [index, count] of expected(8, 2).entries()) {
          expect(result).toHaveProperty(["ownerSessionCounts", index, "open"], count.open);
          expect(result).toHaveProperty(["ownerSessionCounts", index, "running"], count.running);
          expect(result).toHaveProperty(
            ["ownerSessionCounts", index, "profileId"],
            count.profileId,
          );
        }
      }
      expect(prepares).not.toHaveBeenCalled();
      prepares.mockRestore();
      expect(
        await listSessions({ client, context, request: { ...request, archived: "all" } }),
      ).toMatchObject({
        ownerSessionCounts: expected(8, 2),
      });
      expect(
        await listSessions({ client, context, request: { ...request, archived: true } }),
      ).toMatchObject({
        ownerSessionCounts: [],
      });
      expect(
        await listSessions({ client, context, request: { ...request, agentId: "work" } }),
      ).toMatchObject({
        ownerSessionCounts: expected(3, 1),
      });
      expect(
        await listSessions({
          client,
          context,
          request: { ...request, includeOwnerSessionCounts: false },
        }),
      ).not.toHaveProperty("ownerSessionCounts");

      // Live registry changes, not persisted status, own the next count.
      clearAgentRunContext(runIds[0]!);
      clearAgentRunContext(runIds[1]!);
      releaseWait?.();
      expect(await listSessions({ client, context, request })).toMatchObject({
        ownerSessionCounts: expected(8, 2),
      });
      clearAgentRunContext(runIds[2]!);
      clearAgentRunContext(runIds[3]!);
      expect(await listSessions({ client, context, request })).toMatchObject({
        ownerSessionCounts: expected(8, 0),
      });

      // A sharing/ownership change during readiness must affect the whole facet.
      const projection = getSessionRowProjection(context)!;
      const ensure = projection.prepareSelection;
      vi.spyOn(projection, "prepareSelection").mockImplementationOnce(async () => {
        assignSessionOwner(
          { agentId: "main", sessionKey: running },
          {
            owner: actor(bob),
            assignedBy: actor(ada),
          },
        );
        await patchSessionEntryCore({ agentId: "main", sessionKey: running }, () => ({
          visibility: "draft",
        }));
        await ensure();
      });
      expect(await listSessions({ client, context, request })).toMatchObject({
        ownerSessionCounts: expected(7, 0),
      });
    } finally {
      releaseWait?.();
      for (const runId of runIds) {
        clearAgentRunContext(runId);
      }
    }
  });
});

it("keeps the owner summary complete beyond the people facet cap and resolves merged owners", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profiles = Array.from(
      { length: 61 },
      (_, i) => ensureProfileForEmail("count-owner-" + i + "@example.test").id,
    );
    for (const [index, profileId] of profiles.entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:owner-" + index },
        {
          sessionId: "owner-session-" + index,
          updatedAt: 100,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: profileId },
        },
      );
    }
    const context = requestContext({ agents: { entries: { main: { default: true } } } });
    const client = identifiedClient(profiles[1]!);
    const request = { includeOwnerSessionCounts: true, includePeople: true, limit: 1 };
    const counts = profiles.map((profileId) => ({ profileId, open: 1, running: 0 }));
    expect(await listSessions({ client, context, request })).toMatchObject({
      ownerSessionCounts: counts.toSorted((a, b) => a.profileId.localeCompare(b.profileId)),
      peopleIncomplete: true,
      count: 1,
    });
    mergeProfiles(profiles[0]!, profiles[1]!);
    expect(await listSessions({ client, context, request })).toMatchObject({
      ownerSessionCounts: counts
        .slice(1)
        .map((count, i) => ({ profileId: count.profileId, open: i === 0 ? 2 : 1, running: 0 }))
        .toSorted((a, b) => a.profileId.localeCompare(b.profileId)),
    });
  });
});
