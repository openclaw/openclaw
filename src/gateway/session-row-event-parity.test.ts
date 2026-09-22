import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import {
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("delivers nested event rows identical to the full list for each viewer and clock without SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const profiles = [
      ensureProfileForEmail("owner@row-parity.test"),
      ensureProfileForEmail("viewer@row-parity.test"),
    ];
    const cfg = {
      ...rolePolicyConfig(),
      agents: { entries: { main: {} }, defaults: { model: { primary: "openai/gpt-5.4" } } },
    };
    const key = "agent:main:parent";
    const childKey = "agent:main:child";
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
    const connection = createGatewayConnectionState({ bootId: "row-parity", cfg });
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
      const send = vi.fn();
      const client = {
        ...sharingPolicyClient({ user: profile.id }),
        connId: `row-parity-${index}`,
        usesSharedGatewayAuth: false,
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: profile.displayName,
          avatarRevision: "1",
          hasAvatar: false,
          updatedAt: now,
        },
        socket: {
          readyState: WebSocket.OPEN,
          bufferedAmount: 0,
          send,
          close: vi.fn(),
          terminate: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          once: vi.fn(),
        },
      } satisfies GatewayWsClient;
      prepareGatewayRecipientProfile(client);
      connection.clients.add(client);
      connection.sessionMessageSubscribers.subscribe(client.connId, key);
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
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const expected = await Promise.all(
        peers.map(async ({ client }) => {
          const result = await listSessions({
            client,
            context,
            request: {
              includeDerivedTitles: true,
              includeLastMessage: true,
              includeActivitySummary: true,
            },
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
          sessionId: "parent-session",
          reason: "run-capacity",
          status: "queued",
          activeRunIds: null,
          label: null,
        };
        connection.broadcast(event, source);
        for (const [index, peer] of peers.entries()) {
          expect(peer.send).toHaveBeenCalled();
          const frame = JSON.parse(peer.send.mock.lastCall![0]);
          expect(frame.payload).toMatchObject({
            status: "queued",
            activeRunIds: null,
            label: null,
          });
          expect(frame.payload.session).toEqual(expected[index]);
        }
      }
      expect(prepares).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    } finally {
      detach();
      connection.mentionInbox.dispose();
      projection.dispose();
      subagentRuns.delete("row-parity-child");
    }
  });
});
