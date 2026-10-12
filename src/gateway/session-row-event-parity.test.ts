import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import {
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-events.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { beginSessionPermissionChange } from "./session-permission-change.js";
import { createSessionRowEventPeer } from "./session-row-event.test-support.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { publishTranscriptFields } from "./session-row-projection-record.js";
import { rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("delivers nested event rows identical to the full list for each viewer and clock without SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
    const key = "agent:main:parent";
    const childKey = "agent:main:child";
    const lineageKey = "agent:main:completed-lineage";
    const controller = "agent:main:unloaded-controller";
    const navigationParent = "agent:main:unloaded-navigation";
    const creator = { type: "human" as const, source: "profile" as const, id: profiles[0]!.id };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "parent-session",
        updatedAt: now - 100,
        status: "done",
        visibility: "shared",
        createdActor: creator,
        agentHarnessId: "codex",
        modelProvider: "openai",
        model: "gpt-5.4",
        label: "Parent",
        startedAt: now - 100,
      },
    );
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: childKey },
      {
        sessionId: "child-session",
        updatedAt: now - 50,
        visibility: "draft",
        createdActor: creator,
        parentSessionKey: key,
      },
    );
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: lineageKey },
      {
        sessionId: "lineage-session",
        updatedAt: now - 100,
        endedAt: now - 100,
        status: "done",
        visibility: "shared",
        createdActor: creator,
        spawnedBy: controller,
        parentSessionKey: navigationParent,
      },
    );
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "row-parity",
      cfg,
    });
    const context = requestContext(cfg);
    context.chatAbortControllers = connection.chatAbortControllers;
    connection.chatAbortControllers.set("current-run", {
      controller: new AbortController(),
      sessionKey: key,
      sessionId: "parent-session",
      agentId: "main",
      startedAtMs: now - 100,
      expiresAtMs: now + 1000,
    });
    const peers = profiles.map((profile, index) => {
      const { client, send } = createSessionRowEventPeer(profile, `row-parity-${index}`, now);
      connection.clients.add(client);
      connection.sessionMessageSubscribers.subscribe(client.connId, key);
      connection.sessionMessageSubscribers.subscribe(client.connId, lineageKey);
      return { client, send };
    });
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
          const result = await listSessions({
            client,
            context,
            request,
          });
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
            includeSession: true,
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
        connection,
        projection.state.rowContext.projectedAgentRuns,
      );
      const present = (index: number) =>
        publication(peers[index]!.client, projectRun).present(captured, request);
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
        [now, [controller, navigationParent], now],
        [expiresAt, [controller, navigationParent], now],
        [expiresAt + 1, [], expiresAt + 1],
      ] as const) {
        clock.mockReturnValue(sampledAt);
        const children = await listSessions({
          client: peers[0]!.client,
          context,
          request: { ...compactRequest, spawnedBy: controller },
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
