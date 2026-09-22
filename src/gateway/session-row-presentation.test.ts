import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  getAgentRunLifecycleGeneration,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { readUserProfileIdentity, retainUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createExpectedProfileBinding,
  ExpectedProfileMismatchError,
  prepareGatewayRecipientProfile,
} from "./expected-profile.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it.each(["running", "queued", "capacity-wait"] as const)(
  "projects %s follow-up activity through completed subagent lineage outside the selected list page",
  async (state) => {
    using _ = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const parent = "agent:main:parent";
      const child = "agent:main:subagent:child";
      const grandchild = "agent:main:subagent:grandchild";
      const movedParent = "agent:main:moved-parent";
      const endedAt = Date.now() - 3_600_000;
      for (const [key, owner] of [
        [parent],
        [movedParent],
        [child, parent],
        [grandchild, child],
      ] as const) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: key },
          {
            sessionId: key,
            updatedAt: endedAt,
            label: key === parent ? "Selected parent" : "Hidden child",
            status: "done",
            endedAt,
            ...(owner ? { spawnedBy: owner } : {}),
          },
        );
        if (owner) {
          const entry = createSubagentRunRecord({
            runId: `original:${key}`,
            childSessionKey: key,
            requesterSessionKey: owner,
            requesterDisplayKey: owner,
            task: "Original completed task",
            cleanup: "keep",
            createdAt: endedAt - 1_000,
            startedAt: endedAt - 1_000,
            endedAt,
            outcome: { status: "ok" },
          });
          subagentRuns.set(entry.runId, entry);
          subagentRuns.commitOwnership(entry);
        }
      }
      const retainedRunIds: string[] = [];
      if (state === "running") {
        for (let index = 0; index < 2_048; index++) {
          const entry = createSubagentRunRecord({
            runId: `retained-history-${index}`,
            childSessionKey: `agent:main:subagent:retained-${index}`,
            requesterSessionKey: "agent:main:unrelated-parent",
            createdAt: endedAt - 1_000,
            startedAt: endedAt - 1_000,
            endedAt,
            outcome: { status: "ok" },
            completion: { required: false },
            delivery: { status: "not_required" },
          });
          subagentRuns.set(entry.runId, entry);
          subagentRuns.commitOwnership(entry);
          retainedRunIds.push(entry.runId);
        }
      }
      const projection = await createSessionRowProjection({ cfg });
      const connection = createGatewayConnectionState({ bootId: "follow-up", cfg });
      const runId = "follow-up";
      const claim = claimAgentRunContext(
        runId,
        {
          agentId: "main",
          sessionKey: grandchild,
          sessionId: grandchild,
          ...(state === "capacity-wait" ? {} : { projectSessionActive: true }),
        },
        { trackOwner: true, ownsContext: true },
      );
      const releaseWait =
        state === "running"
          ? undefined
          : registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
      try {
        const list = () =>
          listProjectedSessions({
            projection,
            opts: { search: "Selected parent", limit: 1 },
          });
        const active = await list();
        expect(active.sessions).toHaveLength(1);
        expect(active.sessions[0]).toMatchObject({
          key: parent,
          hasActiveSubagentRun: true,
          childSessions: [child],
        });
        if (retainedRunIds.length) {
          const history = projection.state.rowContext.subagentRuns.latestRunsByChildSessionKey;
          const iterate = history[Symbol.iterator].bind(history);
          let visited = 0;
          const historyIterator = vi
            .spyOn(history, Symbol.iterator)
            .mockImplementation(function* () {
              for (const entry of iterate()) {
                visited++;
                yield entry;
              }
              return undefined;
            });
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: movedParent },
            { sessionId: movedParent, updatedAt: endedAt + 1, label: "Unrelated update" },
          );
          expect((await list()).sessions[0]?.hasActiveSubagentRun).toBe(true);
          expect(visited).toBeLessThan(16);
          historyIterator.mockRestore();
        }
        const presentation = prepareProjectedSessionPresentation(
          projection,
          undefined,
          Date.now(),
          createVisibleActiveSessionRunProjector(
            connection,
            projection.state.rowContext.projectedAgentRuns,
          ),
        );
        expect(presentation.snapshot({ key: child, agentId: "main" }).row).toMatchObject({
          hasActiveSubagentRun: true,
          childSessions: [grandchild],
        });
        expect(presentation.snapshot({ key: grandchild, agentId: "main" }).row).toMatchObject({
          hasActiveSubagentRun: true,
          subagentRunState: "historical",
        });
        const originalChild = subagentRuns.get(`original:${child}`)!;
        const movedChild = {
          ...originalChild,
          generation: 2,
          requesterSessionKey: movedParent,
          controllerSessionKey: movedParent,
        };
        subagentRuns.set(movedChild.runId, movedChild);
        subagentRuns.commitOwnership(movedChild);
        expect((await list()).sessions[0]?.hasActiveSubagentRun).not.toBe(true);
        expect(projection.snapshot({ key: movedParent, agentId: "main" }).row).toMatchObject({
          hasActiveSubagentRun: true,
          childSessions: [child],
        });
        releaseWait?.();
        releaseAgentRunContext(runId, claim);
        const stopped = await list();
        expect(stopped.sessions[0]?.hasActiveSubagentRun).not.toBe(true);
        expect(stopped.sessions[0]?.childSessions).toBeUndefined();
        expect(
          projection.snapshot({ key: movedParent, agentId: "main" }).row?.hasActiveSubagentRun,
        ).not.toBe(true);
        expect(
          projection.snapshot({ key: movedParent, agentId: "main" }).row?.childSessions,
        ).toBeUndefined();
        expect(subagentRuns.get(`original:${grandchild}`)?.execution.endedAt).toBe(endedAt);
      } finally {
        releaseWait?.();
        releaseAgentRunContext(runId, claim);
        projection.dispose();
        connection.mentionInbox.dispose();
        for (const key of [child, grandchild]) {
          subagentRuns.delete(`original:${key}`);
        }
        for (const retainedRunId of retainedRunIds) {
          subagentRuns.delete(retainedRunId);
        }
      }
    });
  },
);

it("presents current recipient roles without SQLite while rejecting source overrides and excluded children", async () => {
  using _ = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("owner@presentation.test");
    const member = ensureProfileForEmail("member@presentation.test");
    const viewer = ensureProfileForEmail("viewer@presentation.test");
    setUserProfileRole(viewer.id, "none");
    const clients = [owner, member, viewer].map((profile) => {
      const client = Object.assign(sharingPolicyClient({ user: profile.id }), {
        connId: profile.id,
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send: vi.fn(),
          close: vi.fn(),
        } as unknown as GatewayWsClient["socket"],
      }) as GatewayWsClient;
      prepareGatewayRecipientProfile(client);
      return client;
    });
    const cfg = rolePolicyConfig();
    const query = { agentId: "main", key: "agent:main:parent" };
    const scope = { agentId: "main", sessionKey: query.key };
    const entry = {
      sessionId: "parent-session",
      updatedAt: Date.now(),
      visibility: "suggest" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
    };
    replaceSessionEntrySync(scope, entry);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:child" },
      {
        sessionId: "child-session",
        updatedAt: Date.now(),
        parentSessionKey: query.key,
      },
    );
    addSessionMember(scope, { identityId: member.id, addedBy: owner.id });
    const projection = await createSessionRowProjection({ cfg });
    const connection = createGatewayConnectionState({ bootId: "presentation", cfg });
    const detach = connection.attachSessionRowProjection(projection);
    for (const client of clients) {
      connection.clients.add(client);
    }
    try {
      const captured = projection.describe(query)!;
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      expect(
        prepareProjectedSessionPresentation(projection).present(captured)?.sharingRole,
      ).toBeUndefined();
      for (const [index, expectedRole, visible] of [
        [0, "owner", true],
        [1, "member", true],
        [2, "viewer", false],
      ] as const) {
        const client = clients[index]!;
        const presentation = prepareProjectedSessionPresentation(projection, client);
        expect(
          presentation.present(captured, { excludedChildKeys: new Set(["agent:main:child"]) }),
        ).toMatchObject({ sharingRole: expectedRole });
        expect(
          presentation.present(captured, { excludedChildKeys: new Set(["agent:main:child"]) })
            ?.childSessions,
        ).toBeUndefined();
        expect(
          canReceiveSessionEvent({
            cfg,
            client,
            sessionKeys: [query.key],
            agentId: "main",
            prepared: {
              sharing: presentation.sharing,
              target: (key) => presentation.target({ ...query, key }),
            },
          }),
        ).toBe(visible);
        expect(presentation.authorizeDescription(query)).toBeNull();
        connection.broadcastToConnIds(
          "sessions.changed",
          {
            sessionKey: query.key,
            agentId: query.agentId,
            session: {
              key: query.key,
              sessionId: entry.sessionId,
              label: null,
              endedAt: null,
              status: "completed",
              activitySummary: { state: "stale", text: "Retained event summary" },
            },
          },
          new Set([client.connId]),
        );
        const socket = vi.mocked(client.socket);
        if (visible) {
          expect(socket.send.mock.calls).toHaveLength(1);
          const frame = JSON.parse(String(socket.send.mock.calls[0]?.[0]));
          const expectedWire = JSON.stringify(
            prepareProjectedSessionPresentation(
              projection,
              client,
              Date.now(),
              createVisibleActiveSessionRunProjector(
                connection,
                projection.state.rowContext.projectedAgentRuns,
              ),
            ).present(captured, {
              includeDerivedTitles: true,
              includeLastMessage: true,
            }),
          );
          expect(frame.payload.session).toEqual(JSON.parse(expectedWire));
          expect(frame.payload.session).not.toMatchObject({ status: "completed", label: null });
        } else {
          expect(socket.send.mock.calls).toHaveLength(0);
        }
      }
      expect(
        prepareProjectedSessionPresentation(projection, clients[0]!).authorizeDescription({
          agentId: "main",
          key: "agent:main:dashboard:incognito-private",
        }),
      ).toMatchObject({ code: "INVALID_REQUEST" });
      const activeRun = {
        controller: new AbortController(),
        sessionKey: query.key,
        sessionId: entry.sessionId,
        agentId: query.agentId,
        startedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      };
      connection.chatAbortControllers.set("old-run", activeRun);
      for (const client of clients) {
        vi.mocked(client.socket).send.mockClear();
      }
      vi.mocked(clients[0]!.socket).send.mockImplementationOnce(() => {
        connection.chatAbortControllers.delete("old-run");
        connection.chatAbortControllers.set("replacement-run", {
          ...activeRun,
          sessionKey: "agent:main:adopted-source",
          sessionId: ` ${entry.sessionId} `,
        });
      });
      connection.broadcastToConnIds(
        "sessions.changed",
        { sessionKey: query.key, agentId: query.agentId },
        new Set(clients.map((client) => client.connId)),
      );
      for (const [index, runId] of [
        [0, "old-run"],
        [1, "replacement-run"],
      ] as const) {
        const sends = vi.mocked(clients[index]!.socket).send.mock.calls;
        expect(sends).toHaveLength(1);
        expect(JSON.parse(String(sends[0]?.[0])).payload.session).toMatchObject({
          hasActiveRun: true,
          activeRunIds: [runId],
        });
      }
      expect(vi.mocked(clients[2]!.socket).send.mock.calls).toHaveLength(0);
      connection.chatAbortControllers.clear();
      expect(prepares).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      prepares.mockRestore();
      exec.mockRestore();
      removeSessionMember(scope, member.id);
      await projection.ensureMaterialized();
      expect(
        prepareProjectedSessionPresentation(projection, clients[1]!).snapshot(query).row
          ?.sharingRole,
      ).toBe("viewer");
      replaceSessionEntrySync(scope, { ...entry, sessionId: "replacement-session" });
      await projection.ensureMaterialized();
      expect(
        prepareProjectedSessionPresentation(projection, clients[0]!).present(captured),
      ).toBeNull();
      const socket = vi.mocked(clients[0]!.socket);
      socket.send.mockClear();
      for (const payload of [
        { sessionId: entry.sessionId, session: { sessionId: "replacement-session" } },
        { session: { sessionId: entry.sessionId } },
        { session: { sessionId: "replacement-session", lifecycleRevision: "retired" } },
      ]) {
        connection.broadcastToConnIds(
          "sessions.changed",
          { sessionKey: query.key, agentId: query.agentId, ...payload },
          new Set([clients[0]!.connId]),
        );
      }
      expect(socket.send.mock.calls).toHaveLength(0);
    } finally {
      detach();
      connection.mentionInbox.dispose();
      projection.dispose();
    }
  });
});

it("preserves selected account across role changes but rejects a changed merge identity without SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const source = ensureProfileForEmail("source@expected-profile.test");
    const target = ensureProfileForEmail("target@expected-profile.test");
    const client = sharingPolicyClient({ user: source.id }) as GatewayWsClient;
    prepareGatewayRecipientProfile(client);
    const release = retainUserProfileCatalog();
    try {
      const binding = (await createExpectedProfileBinding(source.id, client))!;
      const targetBinding = (await createExpectedProfileBinding(
        target.id,
        sharingPolicyClient({ user: target.id }),
      ))!;
      binding.markInvoked();
      setUserProfileRole(source.id, "admin");
      setUserProfileRole(source.id, "member");
      linkEmail("extra@expected-profile.test", source.id);
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      binding.assertCurrent();
      const response = vi.fn();
      binding.guardResponse(response)(true, { session: null });
      expect(response).toHaveBeenCalledWith(true, { session: null });
      expect(prepares).not.toHaveBeenCalled();
      prepares.mockRestore();
      // Moving the last alias triggers the source profile's canonical merge.
      linkEmail("extra@expected-profile.test", target.id);
      linkEmail("source@expected-profile.test", target.id);
      prepareGatewayRecipientProfile(client);
      const afterMerge = vi.spyOn(DatabaseSync.prototype, "prepare");
      expect(() => binding.assertCurrent()).toThrow(ExpectedProfileMismatchError);
      expect(() => targetBinding.assertCurrent()).not.toThrow();
      expect(readUserProfileIdentity(source.id)?.profileId).toBe(target.id);
      expect(afterMerge).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
