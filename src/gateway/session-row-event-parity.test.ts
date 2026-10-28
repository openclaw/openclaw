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
import { prepareLinkedSessionEntryFilter } from "./session-row-prepared-read.js";
import {
  prepareProjectedSessionPresentation,
  prepareSessionRowPublication,
} from "./session-row-presentation.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { publishTranscriptFields } from "./session-row-projection-record.js";
import {
  createTestProjection,
  holdSubagentExecution,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";
import { createProfileSessionEntryFilter } from "./session-sharing-read.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it("delivers nested event rows identical to the full list for each viewer and clock without SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const profiles = ["owner", "viewer", "other-viewer"].map((name) =>
      ensureProfileForEmail(`${name}@row-parity.test`),
    );
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
      seedRow(sessionKey, {
        sessionId,
        updatedAt: now - 100,
        createdActor: creator,
        visibility: "shared",
        ...fields,
      });
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
      return { client, send, frame: () => JSON.parse(send.mock.lastCall![0]) };
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
      const listFor = (
        index: number,
        options: Parameters<typeof listSessions>[0]["request"] = request,
      ) => listSessions({ client: peers[index]!.client, context, request: options });
      await Promise.all(peers.map((_peer, index) => listFor(index)));
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const expected = await Promise.all(
        peers.map(async (_peer, index) => {
          const result = await listFor(index);
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
          const frame = peer.frame();
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
              expect(peer.frame().payload).not.toHaveProperty("childSessions");
            }
          }
          connection.broadcast(event, {
            ...source,
            toJSON(property: string) {
              return { transformed: property, message: source.message };
            },
          });
          for (const peer of peers) {
            expect(peer.frame().payload).toEqual({
              transformed: "payload",
              message: source.message,
            });
          }
          for (const publisher of ["getter", "proxy", "mutation"]) {
            let message = structuredClone(source.message);
            let payload = { ...source, message };
            if (publisher === "getter") {
              Object.defineProperty(payload, "message", { enumerable: true, get: () => message });
            } else if (publisher === "proxy") {
              payload = new Proxy(payload, {
                get(target, property, receiver) {
                  return property === "message" ? message : Reflect.get(target, property, receiver);
                },
              });
            }
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
            expect.soft(peers[0]!.frame().payload.message).toEqual(source.message);
            expect.soft(peers[1]!.frame().payload.message).toEqual(message);
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
            expect.soft(peer.frame().stateVersion).toEqual({ presence: 1 });
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
          expect(peer.frame().payload.session.permissionModePending).toBe(index === 2);
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
      const stringify = vi.spyOn(JSON, "stringify");
      try {
        let previous: ReturnType<typeof present> | undefined;
        for (const value of [preview, "Published replacement preview"]) {
          publishPreview(value);
          stringify.mockClear();
          const row = present(1);
          expect(row?.lastMessagePreview).toBe(value);
          expect(present(2)).toBe(row);
          expect(row).not.toBe(previous);
          // Recipient cache lookups must not encode the unchanged large preview again.
          expect(
            stringify.mock.calls.some(([arg]) => Array.isArray(arg) && arg.includes(value)),
          ).toBe(false);
          previous = row;
        }
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
        const children = await listFor(0, { ...compactRequest, spawnedBy: navigationParent });
        expect(children.sessions.map((row) => row.key)).toEqual(owners.length ? [lineageKey] : []);
        const listed = await listFor(0, compactRequest);
        expect(listed.sessions.find((row) => row.key === lineageKey)).toMatchObject({
          childOwnerSessionKeys: owners,
          snapshotAt,
        });
        for (const event of ["sessions.changed", "session.message"]) {
          connection.broadcast(event, { sessionKey: lineageKey, agentId: "main" });
          for (const peer of peers) {
            const frame = peer.frame();
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
        const frame = peer.frame();
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
      const cfg = rolePolicyConfig();
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
      const query = { agentId: "main", key: parent };
      const member = { identityId: viewers[0]!.id, addedBy: owner.id };
      for (const sessionKey of [parent, scope.sessionKey]) {
        addSessionMember({ ...scope, sessionKey }, member);
      }
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      await projection.ensureMaterialized();
      const memberships = vi.spyOn(projection, "readMembership");
      const publish = () =>
        withPreparedEventRow(projection, { agentId: "main", key: keys[1]! }, (read, ancestors) => {
          expect(ancestors?.map((row) => row.key)).toEqual([parent]);
          for (const client of clients) {
            expect(
              prepareProjectedSessionPresentation(read!, client).present(ancestors![0]!)
                ?.childSessions,
            ).toHaveLength(count);
          }
        });
      await publish();
      for (let event = 0; event < 3; event++) {
        memberships.mockClear();
        await publish();
        expect(memberships.mock.calls.length).toBeLessThanOrEqual(40);
      }
      // The prepared invited-cap contract is narrower than the configurable public view role.
      const canRead = prepareLinkedSessionEntryFilter(
        projection,
        createProfileSessionEntryFilter({ profileId: member.identityId, sessionCap: "invited" }),
        member.identityId,
      );
      const memberView = () => {
        const record = projection.describe(query)!;
        const visibility = projection.readChildVisibility(
          record,
          member.identityId,
          canRead,
          projection.selectEntries,
        );
        const activity = projection.readChildActivity(
          record,
          Date.now(),
          visibility.excludedChildKeys,
          visibility.revision,
        );
        return { childSessions: activity.childSessions, visibility };
      };
      const originalMemberView = memberView();
      expect(originalMemberView.childSessions).toEqual([scope.sessionKey]);
      for (const [index, present, expected] of [
        [0, false, undefined],
        [0, true, [keys[0]]],
        [1, true, [keys[0], keys[1]]],
        [1, false, [keys[0]]],
      ] as const) {
        const target = { ...scope, sessionKey: keys[index]! };
        if (present) {
          addSessionMember(target, member);
        } else {
          removeSessionMember(target, member.identityId);
        }
        await projection.ensureMaterialized();
        memberships.mockClear();
        await publish();
        const current = memberView();
        expect(memberships.mock.calls.length).toBeLessThanOrEqual(80);
        expect(current.childSessions).toEqual(expected);
        if (expected?.length === 1) {
          expect(current.visibility.childKey).toBe(originalMemberView.visibility.childKey);
          expect(current.visibility.swarmKey).toBe(originalMemberView.visibility.swarmKey);
        }
      }
    });
  },
);

it.each(["running", "queued", "capacity-wait"] as const)(
  "projects %s follow-up activity through completed subagent lineage outside the selected list page",
  async (state) => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      const parent = "agent:main:parent";
      const child = "agent:main:subagent:child";
      const grandchild = "agent:main:subagent:grandchild";
      const movedParent = "agent:main:moved-parent";
      const endedAt = Date.now() - 3_600_000;
      const registered = new Set<string>();
      using _ = { [Symbol.dispose]: () => registered.forEach((id) => subagentRuns.delete(id)) };
      const commit = (entry: ReturnType<typeof createSubagentRunRecord>) => {
        registered.add(entry.runId);
        subagentRuns.set(entry.runId, entry);
        subagentRuns.commitOwnership(entry);
        return entry;
      };
      const lineage = [[parent], [movedParent], [child, parent], [grandchild, child]] as const;
      const retainedHistory = Array.from(
        { length: state === "running" ? 2_048 : 0 },
        (_value, index) =>
          [`agent:main:subagent:retained-${index}`, "agent:main:unrelated-parent"] as const,
      );
      for (const [index, [key, owner]] of [...lineage, ...retainedHistory].entries()) {
        const retained = index >= lineage.length;
        if (!retained) {
          seedRow(key, {
            sessionId: key,
            updatedAt: endedAt,
            label: key === parent ? "Selected parent" : "Hidden child",
            status: "done",
            endedAt,
            ...(owner ? { spawnedBy: owner } : {}),
          });
        }
        if (owner) {
          commit(
            createSubagentRunRecord({
              runId: `original:${key}`,
              childSessionKey: key,
              requesterSessionKey: owner,
              requesterDisplayKey: owner,
              createdAt: endedAt - 1_000,
              startedAt: endedAt - 1_000,
              endedAt,
              outcome: { status: "ok" },
              ...(retained ? { delivery: { status: "not_required" } } : {}),
            }),
          );
        }
      }
      using projection = await createTestProjection({ cfg });
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
      using execution = {
        [Symbol.dispose]() {
          releaseWait?.();
          releaseAgentRunContext(runId, claim);
        },
      };
      const snapshot = (key: string) =>
        prepareProjectedSessionPresentation(
          projection,
          undefined,
          Date.now(),
          createVisibleActiveSessionRunProjector(projection.state.rowContext.projectedAgentRuns),
        ).snapshot({ key, agentId: "main" }).row;
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
      if (state === "running") {
        const history = projection.state.rowContext.subagentRuns.latestRunsByChildSessionKey;
        const iterate = history[Symbol.iterator].bind(history);
        let visited = 0;
        const historyIterator = vi.spyOn(history, Symbol.iterator).mockImplementation(function* () {
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
      expect(snapshot(child)).toMatchObject({
        hasActiveSubagentRun: true,
        childSessions: [grandchild],
      });
      expect(snapshot(grandchild)).toMatchObject({
        hasActiveSubagentRun: true,
        subagentRunState: "historical",
      });
      if (state === "queued") {
        execution[Symbol.dispose]();
        const queued = commit(
          createSubagentRunRecord({
            runId: "reserved-grandchild",
            generation: 2,
            childSessionKey: grandchild,
            requesterSessionKey: child,
            collect: true,
            createdAt: Date.now() - 3 * 3_600_000,
            execution: { status: "queued" },
          }),
        );
        reserveSwarmRun({
          runId: queued.runId,
          groupId: "lineage",
          maxConcurrent: 1,
          activeRunIds: [],
        });
        const held = holdQueuedSwarmRun(queued.runId)!;
        try {
          await projection.ensureMaterialized();
          const activeParent = () => snapshot(parent)?.hasActiveSubagentRun;
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
      commit(movedChild);
      expect((await list()).sessions[0]?.hasActiveSubagentRun).not.toBe(true);
      expect(snapshot(movedParent)).toMatchObject({
        hasActiveSubagentRun: true,
        childSessions: [child],
      });
      execution[Symbol.dispose]();
      movedExecution[Symbol.dispose]();
      commit({
        ...movedChild,
        execution: { ...movedChild.execution, status: "terminal" as const, endedAt: Date.now() },
      });
      const stopped = await list();
      expect(stopped.sessions[0]?.hasActiveSubagentRun).not.toBe(true);
      expect(stopped.sessions[0]?.childSessions).toEqual([child]);
      const movedRow = snapshot(movedParent);
      expect(movedRow?.hasActiveSubagentRun).not.toBe(true);
      expect(movedRow?.childSessions).toBeUndefined();
      expect(subagentRuns.get(`original:${grandchild}`)?.execution.endedAt).toBe(endedAt);
    });
  },
);
