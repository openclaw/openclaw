import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { listSystemPresence } from "../infra/system-presence.js";
import {
  closeOpenClawAgentDatabaseByPath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPresenceRecipientProjection } from "./presence-projection.js";
import type { GatewayClient } from "./server-methods/types.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createSessionViewerPresenceDeclarations } from "./session-viewer-presence.js";

function createDeclarations() {
  const client: GatewayWsClient = {
    connId: "conn-a",
    presenceKey: "viewer-timing",
    usesSharedGatewayAuth: false,
    socket: { readyState: 1 } as GatewayWsClient["socket"],
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    },
    authenticatedUserId: "viewer@timing.test",
    personPresence: { onlineSince: Date.now() - 1_000 },
  };
  const clients = new GatewayClientRegistry([client]);
  const broadcast = vi.fn();
  const incrementPresenceVersion = vi.fn(() => 2);
  const declarations = createSessionViewerPresenceDeclarations({
    clients,
    broadcast,
    incrementPresenceVersion,
    getHealthVersion: () => 1,
  });
  const row = () => listSystemPresence().find((entry) => entry.user?.id === "viewer@timing.test");
  return { declarations, client, clients, broadcast, incrementPresenceVersion, row };
}

describe("session viewer presence declarations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2041-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.setSystemTime(Date.now() + 300_001);
    listSystemPresence();
    vi.useRealTimers();
  });

  it("replaces rather than accumulates connection session keys", () => {
    const { declarations, broadcast, row } = createDeclarations();

    expect(declarations.replace("conn-a", [" beta ", "alpha", "beta"])).toEqual(["alpha", "beta"]);
    expect(row()?.watchedSessions).toEqual(["alpha", "beta"]);
    vi.setSystemTime(Date.now() + 1_000);
    expect(declarations.replace("conn-a", ["gamma"])).toEqual(["gamma"]);
    expect(row()).toMatchObject({ watchedSessions: ["gamma"], lastActivityAt: Date.now() });
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("publishes an empty declaration and forgets state on disconnect", () => {
    const { declarations, broadcast, row } = createDeclarations();

    declarations.replace("conn-a", ["alpha"]);
    const activity = row()?.lastActivityAt;
    vi.setSystemTime(Date.now() + 1_000);
    declarations.replace("conn-a", []);
    expect(row()?.watchedSessions).toBeUndefined();
    expect(row()?.lastActivityAt).toBe(activity);
    declarations.replace("conn-a", ["beta"]);
    const nextActivity = row()?.lastActivityAt;
    vi.setSystemTime(Date.now() + 1_000);
    declarations.unsubscribe("conn-a");
    expect(row()?.lastActivityAt).toBe(nextActivity);
    declarations.replace("conn-a", ["beta"]);
    expect(row()?.lastActivityAt).toBe(Date.now());
    expect(broadcast).toHaveBeenCalledTimes(4);
  });

  it("does not republish an unchanged set", () => {
    const { declarations, broadcast, incrementPresenceVersion, row } = createDeclarations();

    declarations.replace("conn-a", ["beta", "alpha"]);
    const activity = row()?.lastActivityAt;
    vi.setSystemTime(Date.now() + 1_000);
    declarations.replace("conn-a", ["alpha", "beta"]);

    expect(row()?.lastActivityAt).toBe(activity);
    expect(broadcast).toHaveBeenCalledOnce();
    expect(incrementPresenceVersion).toHaveBeenCalledOnce();
  });

  it("rejects declarations from inactive connections and after stop", () => {
    const { declarations, client, clients, broadcast } = createDeclarations();
    client.invalidated = true;
    expect(declarations.replace("conn-a", ["alpha"])).toEqual([]);
    client.invalidated = false;
    clients.delete(client);
    expect(declarations.replace("conn-a", ["alpha"])).toEqual([]);
    clients.add(client);
    declarations.stop();
    expect(declarations.replace("conn-a", ["alpha"])).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

function recipient(scopes = ["operator.admin"]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    },
  };
}

async function seedColdStore(count: number): Promise<string[]> {
  const keys = Array.from({ length: count }, (_, index) => `agent:main:presence-${index}`);
  for (const [index, sessionKey] of keys.entries()) {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: `presence-${index}`, updatedAt: 1, visibility: "shared" },
    );
  }
  // Fresh read-only handles expose repeated admission work hidden by a warm writer.
  expect(
    closeOpenClawAgentDatabaseByPath(resolveOpenClawAgentSqlitePath({ agentId: "main" })),
  ).toBe(true);
  return keys;
}

describe("presence projection store admission", () => {
  it("bounds a cold fanout to one metadata census per store, including repeated watches and recipients", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const watchedSessions = (await seedColdStore(64)).slice(0, 8);
      const presence = [
        { text: "first watcher", ts: 1, watchedSessions },
        { text: "second watcher", ts: 2, watchedSessions: [...watchedSessions] },
      ];
      const { DatabaseSync } = requireNodeSqlite();
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      try {
        const project = createPresenceRecipientProjection({ cfg: {}, presence });
        expect(project(recipient())).toEqual(presence);
        // Observe real unbounded session reads, without replacing the canonical
        // validator or exact reader. Selected-row queries contain a WHERE clause.
        const censuses = prepare.mock.calls.filter(([sql]) => {
          const normalized = sql.toLowerCase().replaceAll(/\s+/g, " ");
          return normalized.includes('from "session_nodes"') && !normalized.includes(" where ");
        });
        expect(censuses).toHaveLength(1);
        const preparedQueries = prepare.mock.calls.length;
        expect(project(recipient())).toEqual(presence);
        expect(prepare).toHaveBeenCalledTimes(preparedQueries);
      } finally {
        prepare.mockRestore();
      }
    });
  });

  it("does not admit stores until an eligible recipient demands a watched key", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const watchedSessions = await seedColdStore(1);
      const person = { text: "watcher", ts: 1 };
      const presence = [{ ...person, watchedSessions }];
      const pending = recipient(["operator.read"]);
      pending.authenticatedGitHubIdentitySync = async () => ({
        profileId: "pending",
        updatedAt: 1,
      });
      const node = recipient();
      node.connect.role = "node";
      const { DatabaseSync } = requireNodeSqlite();
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      try {
        const project = createPresenceRecipientProjection({ cfg: {}, presence });
        expect(project(pending)).toEqual([person]);
        for (const denied of [recipient([]), node, null]) {
          expect(project(denied)).toEqual([]);
        }
        expect(createPresenceRecipientProjection({ cfg: {}, presence: [] })(recipient())).toEqual(
          [],
        );
        expect(
          createPresenceRecipientProjection({
            cfg: {},
            presence: [person, { ...person, watchedSessions: [] }],
          })(recipient()),
        ).toEqual([person, person]);
        expect(prepare).not.toHaveBeenCalled();

        expect(project(recipient())).toEqual(presence);
        expect(prepare).toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
      }
    });
  });
});
