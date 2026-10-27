import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { getSubagentRunRuntimeKey } from "../agents/subagents/registry/subagent-run-generation.js";
import {
  bindSwarmRunReservation,
  holdQueuedSwarmRun,
  reserveSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  getAgentRunLifecycleGeneration,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { createActiveRpcSourceForTest } from "./server-methods/rpc-source-fixtures.test-support.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import {
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-lifecycle-events.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { withPreparedEventRow } from "./session-event-prepared-row.js";
import { beginSessionPermissionChange } from "./session-permission-change.js";
import { createSessionRowEventPeer } from "./session-row-event.test-support.js";
import {
  prepareProjectedSessionPresentation,
  prepareSessionRowPublication,
} from "./session-row-presentation.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { publishTranscriptFields } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import {
  createTestProjection,
  holdSubagentExecution,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it("delivers nested event rows identical to the full list for each viewer and clock without SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const profiles = [
      ensureProfileForEmail("owner@row-parity.test"),
      ensureProfileForEmail("viewer@row-parity.test"),
      ensureProfileForEmail("other-viewer@row-parity.test"),
    ];
    const cfg = {
      ...rolePolicyConfig(),
      agents: { entries: { main: {} }, defaults: { model: { primary: "openai/gpt-5.4" } } },
    };
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:parent";
    const childKey = "agent:main:child";
    const lineageKey = "agent:main:completed-lineage";
    const controller = "agent:main:unloaded-controller";
    const navigationParent = "agent:main:unloaded-navigation";
    const creator = { type: "human" as const, source: "profile" as const, id: profiles[0]!.id };
    const writeRow = (
      sessionKey: string,
      sessionId: string,
      fields: Partial<InternalSessionEntry>,
    ) =>
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: now - 100, createdActor: creator, visibility: "shared", ...fields },
      );
    writeRow(key, "parent-session", {
      status: "done",
      agentHarnessId: "codex",
      modelProvider: "openai",
      model: "gpt-5.4",
      label: "Parent",
      startedAt: now - 100,
    });
    writeRow(childKey, "child-session", {
      updatedAt: now - 50,
      visibility: "draft",
      parentSessionKey: key,
    });
    writeRow(lineageKey, "lineage-session", {
      endedAt: now - 100,
      status: "done",
      spawnedBy: controller,
      parentSessionKey: navigationParent,
    });
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "row-parity",
      cfg,
    });
    const context = requestContext(cfg);
    rpcSourceTesting.set(
      "current-run",
      await createActiveRpcSourceForTest(
        {},
        {
          sessionKey: key,
          sessionId: "parent-session",
          agentId: "main",
          storeScope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        },
      ),
    );
    subagentRuns.set("row-parity-child", {
      runId: "row-parity-child",
      childSessionKey: childKey,
      requesterSessionKey: key,
      requesterAgentId: "main",
      requesterDisplayKey: key,
      controllerSessionKey: key,
      swarmRequesterSessionKey: key,
      task: "private task",
      cleanup: "keep",
      collect: true,
      groupId: "row-parity-group",
      createdAt: now - 50,
      execution: { status: "terminal", startedAt: now - 50, endedAt: now - 25 },
      completion: { required: false },
      delivery: { status: "not_required" },
      collectorCompletion: { status: "done" },
    });
    await initializeSessionReadContext(context);
    const peers = profiles.map((profile, index) => {
      const { client, send } = createSessionRowEventPeer(profile, `row-parity-${index}`, now);
      connection.clients.add(client);
      connection.sessionMessageSubscribers.subscribe(client.connId, key);
      connection.sessionMessageSubscribers.subscribe(client.connId, lineageKey);
      return { client, send };
    });
    const projection = getSessionRowProjection(context)!;
    const detach = connection.attachSessionRowProjection(projection);
    try {
      await projection.ensureMaterialized();
      const request = {
        includeDerivedTitles: true,
        includeLastMessage: true,
        includeActivitySummary: true,
      };
      await Promise.all(peers.map(({ client }) => listSessions({ client, context, request })));
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const expected = await Promise.all(
        peers.map(async ({ client }) => {
          const result = await listSessions({ client, context, request });
          return result.sessions.find((row) => row.key === key)!;
        }),
      );
      expect(expected[0]).toMatchObject({
        sharingRole: "owner",
        hasActiveRun: true,
        activeRunIds: ["current-run"],
      });
      expect(expected[1]).toMatchObject({ sharingRole: "viewer", hasActiveRun: true });
      expect(expected[0]?.childSessions).toHaveLength(1);
      expect(expected[1]?.childSessions).toBeUndefined();
      expect(expected[0]?.swarm?.groups[0]?.children).toEqual([
        { sessionKey: childKey, status: "done" },
      ]);
      expect(expected[1]?.swarm?.groups[0]?.children).toEqual([]);
      for (const event of ["sessions.changed", "session.message"]) {
        const source = {
          ...buildGatewaySessionSnapshot({
            sessionRow: projection.snapshot({ key, agentId: "main" }).row,
            lifecycle: true,
          }),
          sessionKey: key,
          agentId: "main",
          message: { role: "assistant", content: [{ type: "text", text: 'Shared "🦞"\nbody' }] },
          sessionId: "parent-session",
          reason: "run-capacity",
          status: "queued",
          activeRunIds: null,
          label: null,
        };
        const presentations = vi.spyOn(projection, "present");
        connection.broadcast(event, source);
        // Three independently authorized recipients need only the owner and viewer rows.
        expect(presentations.mock.calls.length).toBeLessThanOrEqual(2);
        presentations.mockRestore();
        for (const [index, peer] of peers.entries()) {
          expect(peer.send).toHaveBeenCalled();
          const frame = JSON.parse(peer.send.mock.lastCall![0]);
          expect(frame.payload).toMatchObject({
            status: "queued",
            activeRunIds: null,
            label: null,
          });
          expect(frame.payload.session).toEqual(expected[index]);
          expect(frame.payload.childSessions).toEqual(expected[index]?.childSessions);
          expect(frame.payload.message).toEqual(source.message);
        }
        if (event === "session.message") {
          for (const publisher of ["non-enumerable", "absent proxy"]) {
            const envelope = { ...source };
            Object.defineProperty(envelope, "childSessions", {
              enumerable: false,
              configurable: true,
              value: [childKey],
            });
            const payload =
              publisher === "non-enumerable"
                ? envelope
                : new Proxy(envelope, {
                    ownKeys(target) {
                      return Reflect.ownKeys(target).filter(
                        (property) => property !== "childSessions",
                      );
                    },
                    getOwnPropertyDescriptor(target, property) {
                      if (property === "childSessions") {
                        throw new Error("unexpected source field probe");
                      }
                      return Reflect.getOwnPropertyDescriptor(target, property);
                    },
                  });
            const previousDeliveries = peers.map((peer) => peer.send.mock.calls.length);
            connection.broadcast(event, payload);
            for (const [index, peer] of peers.entries()) {
              expect(peer.send).toHaveBeenCalledTimes(previousDeliveries[index]! + 1);
              expect(JSON.parse(peer.send.mock.lastCall![0]).payload).not.toHaveProperty(
                "childSessions",
              );
            }
          }
          connection.broadcast(event, {
            ...source,
            toJSON(property: string) {
              return { transformed: property, message: source.message };
            },
          });
          for (const peer of peers) {
            expect(JSON.parse(peer.send.mock.lastCall![0]).payload).toEqual({
              transformed: "payload",
              message: source.message,
            });
          }
          for (const publisher of ["getter", "proxy", "mutation"]) {
            let message = structuredClone(source.message);
            const sourceWithMessage = { ...source, message };
            const payload =
              publisher === "getter"
                ? {
                    ...sourceWithMessage,
                    get message() {
                      return message;
                    },
                  }
                : publisher === "proxy"
                  ? new Proxy(sourceWithMessage, {
                      get(target, property, receiver) {
                        return property === "message"
                          ? message
                          : Reflect.get(target, property, receiver);
                      },
                    })
                  : sourceWithMessage;
            peers[0]!.send.mockImplementationOnce(() => {
              if (publisher === "mutation") {
                message.content[0]!.text = "Mutated body";
              } else {
                message = {
                  role: "assistant",
                  content: [{ type: "text", text: `Replacement from ${publisher}` }],
                };
              }
            });
            connection.broadcast(event, payload);
            expect
              .soft(JSON.parse(peers[0]!.send.mock.lastCall![0]).payload.message)
              .toEqual(source.message);
            expect
              .soft(JSON.parse(peers[1]!.send.mock.lastCall![0]).payload.message)
              .toEqual(message);
          }
          const stateVersion = { presence: 1 };
          connection.broadcast(
            event,
            {
              sessionKey: key,
              agentId: "main",
              sessionId: "parent-session",
              get message() {
                stateVersion.presence = 9;
                return source.message;
              },
            },
            { stateVersion },
          );
          for (const peer of peers) {
            expect
              .soft(JSON.parse(peer.send.mock.lastCall![0]).stateVersion)
              .toEqual({ presence: 1 });
          }
        }
      }
      let finishPermissionChange: (() => void) | undefined;
      peers[1]!.send.mockImplementationOnce(() => {
        finishPermissionChange = beginSessionPermissionChange("parent-session");
      });
      try {
        connection.broadcast("sessions.changed", { sessionKey: key, agentId: "main" });
        for (const [index, peer] of peers.entries()) {
          expect(
            JSON.parse(peer.send.mock.lastCall![0]).payload.session.permissionModePending,
          ).toBe(index === 2);
        }
      } finally {
        finishPermissionChange?.();
      }
      const captured = projection.describe({ key, agentId: "main" })!;
      const originalPreview = captured.lastMessagePreview;
      const preview = "Unchanged preview 🦞 ".repeat(1024);
      const publishPreview = (lastMessagePreview: string | undefined) =>
        publishTranscriptFields(
          captured,
          { lastMessagePreview, fallbackModel: captured.fallbackModel },
          cfg,
          projection.state.rowContext,
        );
      const publication = prepareSessionRowPublication(projection, now);
      const projectRun = createVisibleActiveSessionRunProjector(
        projection.state.rowContext.projectedAgentRuns,
      );
      const present = (index: number) =>
        publication(peers[index]!.client, projectRun).getPresentation().present(captured, request);
      publishPreview(preview);
      const stringify = vi.spyOn(JSON, "stringify");
      try {
        const first = present(1);
        expect(first?.lastMessagePreview).toBe(preview);
        expect(present(2)).toBe(first);
        // Recipient cache lookups must not encode the unchanged large preview again.
        expect(
          stringify.mock.calls.some(([value]) => Array.isArray(value) && value.includes(preview)),
        ).toBe(false);
        publishPreview("Published replacement preview");
        const replacement = present(1);
        expect(replacement).not.toBe(first);
        expect(replacement?.lastMessagePreview).toBe("Published replacement preview");
        expect(present(2)).toBe(replacement);
      } finally {
        stringify.mockRestore();
        publishPreview(originalPreview);
      }
      const compactRequest = { ...request, rowMode: "compact" as const };
      const expiresAt = now - 100 + 30 * 60_000;
      for (const [sampledAt, owners, snapshotAt] of [
        [now, [navigationParent], now],
        [expiresAt, [navigationParent], now],
        [expiresAt + 1, [], expiresAt + 1],
      ] as const) {
        clock.mockReturnValue(sampledAt);
        const children = await listSessions({
          client: peers[0]!.client,
          context,
          request: { ...compactRequest, spawnedBy: navigationParent },
        });
        expect(children.sessions.map((row) => row.key)).toEqual(owners.length ? [lineageKey] : []);
        const listed = await listSessions({
          client: peers[0]!.client,
          context,
          request: compactRequest,
        });
        expect(listed.sessions.find((row) => row.key === lineageKey)).toMatchObject({
          childOwnerSessionKeys: owners,
          snapshotAt,
        });
        for (const event of ["sessions.changed", "session.message"]) {
          connection.broadcast(event, { sessionKey: lineageKey, agentId: "main" });
          for (const peer of peers) {
            const frame = JSON.parse(peer.send.mock.lastCall![0]);
            expect(frame.event).toBe(event);
            expect(frame.payload.session).toMatchObject({
              key: lineageKey,
              childOwnerSessionKeys: owners,
              snapshotAt,
            });
          }
        }
      }
      clock.mockReturnValue(now);
      expect(prepares).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      prepares.mockRestore();
      exec.mockRestore();
      for (const { client } of peers) {
        connection.sessionEventSubscribers.subscribe(client.connId);
      }
      await createLifecycleEventBroadcastHandler(connection)({
        sessionKey: key,
        agentId: "main",
        reason: "update",
      });
      for (const [index, peer] of peers.entries()) {
        const frame = JSON.parse(peer.send.mock.lastCall![0]);
        expect(frame.event).toBe("sessions.changed");
        expect(frame.payload.sessionKey).toBe(key);
        expect(frame.payload.childSessions).toEqual(expected[index]?.childSessions);
      }
    } finally {
      detach();
      await connection.mentionInbox.dispose();
      projection.dispose();
      subagentRuns.delete("row-parity-child");
    }
  });
});

it.each([50, 150, 500])(
  "bounds ancestor membership reads with %i children and 20 viewers",
  async (count) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const owner = ensureProfileForEmail("ancestor-owner@presentation.test");
      const viewers = Array.from({ length: 20 }, (value, i) =>
        ensureProfileForEmail(`ancestor-${i}@presentation.test`),
      );
      setUserProfileRole(viewers[0]!.id, "invited");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const cfg = rolePolicyConfig();
      cfg.gateway!.roles!.definitions.invited = {
        sessions: { others: "invited" },
        agents: "*",
        scopes: ["operator.read", "operator.write"],
      };
      const clients = viewers.map((viewer) => {
        const client = sharingPolicyClient({ user: viewer.id });
        prepareGatewayRecipientProfile(client);
        return client;
      });
      const parent = "agent:main:ancestor-membership";
      const keys = Array.from({ length: count }, (value, i) => `agent:main:subagent:ancestor-${i}`);
      const entry = {
        updatedAt: Date.now(),
        visibility: "shared" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
      };
      seedRow(parent, { ...entry, sessionId: parent });
      for (const key of keys) {
        seedRow(key, { ...entry, sessionId: key, parentSessionKey: parent });
      }
      const scope = { agentId: "main", sessionKey: keys[0]! };
      for (const sessionKey of [parent, scope.sessionKey]) {
        addSessionMember(
          { ...scope, sessionKey },
          { identityId: viewers[0]!.id, addedBy: owner.id },
        );
      }
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      await projection.ensureMaterialized();
      const memberships = vi.spyOn(projection, "readMembership");
      const publish = () =>
        withPreparedEventRow(projection, { agentId: "main", key: keys[1]! }, (read, ancestors) => {
          expect(ancestors?.map((row) => row.key)).toEqual([parent]);
          return clients.map(
            (client) =>
              prepareProjectedSessionPresentation(read!, client).present(ancestors![0]!)
                ?.childSessions,
          );
        });
      await publish();
      for (let event = 0; event < 3; event++) {
        memberships.mockClear();
        await publish();
        expect(memberships.mock.calls.length).toBeLessThanOrEqual(40);
      }
      const visible = () =>
        clients.map(
          (client) =>
            prepareProjectedSessionPresentation(projection, client).snapshot({
              agentId: "main",
              key: parent,
            }).row?.childSessions,
        );
      expect(visible()[0]).toEqual([scope.sessionKey]);
      expect(visible()[1]).toHaveLength(count);
      const publishedMemberRow = () =>
        prepareSessionRowPublication(
          projection,
          Date.now(),
        )(clients[0]!)
          .getPresentation()
          .snapshot({ agentId: "main", key: parent }).row;
      const originalMemberRow = publishedMemberRow();
      removeSessionMember(scope, viewers[0]!.id);
      await projection.ensureMaterialized();
      memberships.mockClear();
      await publish();
      expect(memberships.mock.calls.length).toBeLessThanOrEqual(80);
      expect(visible()[0]).toBeUndefined();
      expect(visible()[1]).toHaveLength(count);
      addSessionMember(scope, { identityId: viewers[0]!.id, addedBy: owner.id });
      await projection.ensureMaterialized();
      await publish();
      expect(visible()[0]).toEqual([scope.sessionKey]);
      expect(publishedMemberRow()).toBe(originalMemberRow);
      const other = { ...scope, sessionKey: keys[1]! };
      addSessionMember(other, { identityId: viewers[0]!.id, addedBy: owner.id });
      await projection.ensureMaterialized();
      publishedMemberRow();
      removeSessionMember(other, viewers[0]!.id);
      await projection.ensureMaterialized();
      expect(publishedMemberRow()).toBe(originalMemberRow);
    });
  },
);

it.each(["running", "queued", "capacity-wait"] as const)(
  "projects %s follow-up activity through completed subagent lineage outside the selected list page",
  async (state) => {
    using _ = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      const parent = "agent:main:parent";
      const child = "agent:main:subagent:child";
      const grandchild = "agent:main:subagent:grandchild";
      const movedParent = "agent:main:moved-parent";
      const endedAt = Date.now() - 3_600_000;
      const recordCompleted = (
        runId: string,
        childSessionKey: string,
        requesterSessionKey: string,
      ) => {
        const entry = createSubagentRunRecord({
          runId,
          childSessionKey,
          requesterSessionKey,
          requesterDisplayKey: requesterSessionKey,
          createdAt: endedAt - 1_000,
          startedAt: endedAt - 1_000,
          endedAt,
          outcome: { status: "ok" },
          ...(runId.startsWith("retained-") ? { delivery: { status: "not_required" } } : {}),
        });
        subagentRuns.set(runId, entry);
        subagentRuns.commitOwnership(entry);
        return runId;
      };
      for (const [key, owner] of [
        [parent],
        [movedParent],
        [child, parent],
        [grandchild, child],
      ] as const) {
        seedRow(key, {
          sessionId: key,
          updatedAt: endedAt,
          label: key === parent ? "Selected parent" : "Hidden child",
          status: "done",
          endedAt,
          ...(owner ? { spawnedBy: owner } : {}),
        });
        if (owner) {
          recordCompleted(`original:${key}`, key, owner);
        }
      }
      const retainedRunIds: string[] = [];
      if (state === "running") {
        for (let index = 0; index < 2_048; index++) {
          retainedRunIds.push(
            recordCompleted(
              `retained-history-${index}`,
              `agent:main:subagent:retained-${index}`,
              "agent:main:unrelated-parent",
            ),
          );
        }
      }
      const projection = await createSessionRowProjection({ cfg });
      const connection = createGatewayConnectionState({
        scheduler: createTestGatewayScheduler(),
        bootId: "follow-up",
        cfg,
      });
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
          seedRow(movedParent, {
            sessionId: movedParent,
            updatedAt: endedAt + 1,
            label: "Unrelated update",
          });
          expect((await list()).sessions[0]?.hasActiveSubagentRun).toBe(true);
          expect(visited).toBeLessThan(16);
          historyIterator.mockRestore();
        }
        const presentation = prepareProjectedSessionPresentation(
          projection,
          undefined,
          Date.now(),
          createVisibleActiveSessionRunProjector(projection.state.rowContext.projectedAgentRuns),
        );
        expect(presentation.snapshot({ key: child, agentId: "main" }).row).toMatchObject({
          hasActiveSubagentRun: true,
          childSessions: [grandchild],
        });
        expect(presentation.snapshot({ key: grandchild, agentId: "main" }).row).toMatchObject({
          hasActiveSubagentRun: true,
          subagentRunState: "historical",
        });
        if (state === "queued") {
          releaseWait?.();
          releaseAgentRunContext(runId, claim);
          const queued = createSubagentRunRecord({
            runId: "reserved-grandchild",
            generation: 2,
            childSessionKey: grandchild,
            requesterSessionKey: child,
            collect: true,
            createdAt: Date.now() - 3 * 3_600_000,
            execution: { status: "queued" },
          });
          subagentRuns.set(queued.runId, queued);
          subagentRuns.commitOwnership(queued);
          reserveSwarmRun({
            runId: queued.runId,
            groupId: "lineage",
            maxConcurrent: 1,
            activeRunIds: [],
          });
          const held = holdQueuedSwarmRun(queued.runId)!;
          try {
            await projection.ensureMaterialized();
            const activeParent = () =>
              prepareProjectedSessionPresentation(projection).snapshot({
                key: parent,
                agentId: "main",
              }).row?.hasActiveSubagentRun;
            expect(activeParent()).not.toBe(true);
            bindSwarmRunReservation(queued.runId, getSubagentRunRuntimeKey(queued));
            expect(activeParent()).toBe(true);
            expect(held.withdraw()).toBe(true);
            expect(activeParent()).not.toBe(true);
          } finally {
            held.withdraw();
            await held.release();
            subagentRuns.delete(queued.runId);
          }
        }
        const originalChild = subagentRuns.get(`original:${child}`)!;
        const movedChild = {
          ...originalChild,
          generation: 2,
          requesterSessionKey: movedParent,
          controllerSessionKey: movedParent,
          execution: { status: "running" as const, startedAt: Date.now() },
        };
        using movedExecution = holdSubagentExecution(movedChild.runId, child);
        subagentRuns.set(movedChild.runId, movedChild);
        subagentRuns.commitOwnership(movedChild);
        expect((await list()).sessions[0]?.hasActiveSubagentRun).not.toBe(true);
        expect(projection.snapshot({ key: movedParent, agentId: "main" }).row).toMatchObject({
          hasActiveSubagentRun: true,
          childSessions: [child],
        });
        releaseWait?.();
        releaseAgentRunContext(runId, claim);
        movedExecution[Symbol.dispose]();
        const finishedChild = {
          ...movedChild,
          execution: { ...movedChild.execution, status: "terminal" as const, endedAt: Date.now() },
        };
        subagentRuns.set(finishedChild.runId, finishedChild);
        subagentRuns.commitOwnership(finishedChild);
        const stopped = await list();
        expect(stopped.sessions[0]?.hasActiveSubagentRun).not.toBe(true);
        expect(stopped.sessions[0]?.childSessions).toEqual([child]);
        const movedRow = projection.snapshot({ key: movedParent, agentId: "main" }).row;
        expect(movedRow?.hasActiveSubagentRun).not.toBe(true);
        expect(movedRow?.childSessions).toBeUndefined();
        expect(subagentRuns.get(`original:${grandchild}`)?.execution.endedAt).toBe(endedAt);
      } finally {
        releaseWait?.();
        releaseAgentRunContext(runId, claim);
        projection.dispose();
        await connection.mentionInbox.dispose();
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
