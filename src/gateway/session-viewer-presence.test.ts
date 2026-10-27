import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listSystemPresence } from "../infra/system-presence.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPresenceRecipientProjection } from "./presence-projection.js";
import type { GatewayClient } from "./server-methods/types.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { createSessionViewerPresenceDeclarations } from "./session-viewer-presence.js";

function connect(scopes?: string[]): GatewayClient["connect"] {
  return {
    minProtocol: 1,
    maxProtocol: 1,
    role: "operator",
    ...(scopes ? { scopes } : {}),
    client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
  };
}
function recipient(scopes = ["operator.admin"]): GatewayClient {
  return { connect: connect(scopes) };
}

function createDeclarations() {
  const client: GatewayWsClient = {
    connId: "conn-a",
    presenceKey: "viewer-timing",
    usesSharedGatewayAuth: false,
    socket: { readyState: 1 } as GatewayWsClient["socket"],
    connect: connect(),
    authenticatedUserId: "viewer@timing.test",
    personPresence: { onlineSince: Date.now() - 1_000 },
  };
  const clients = new GatewayClientRegistry([client]);
  const publishPresence = vi.fn();
  const declarations = createSessionViewerPresenceDeclarations({ clients, publishPresence });
  const row = () => listSystemPresence().find((entry) => entry.user?.id === "viewer@timing.test");
  return { declarations, client, clients, publishPresence, row };
}

describe("session viewer presence declarations", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2041-01-01T00:00:00Z") });
  });
  afterEach(() => {
    vi.setSystemTime(Date.now() + 300_001);
    listSystemPresence();
    vi.useRealTimers();
  });

  it.each([
    ["replaces", ["gamma"], ["gamma"], 2, true],
    ["deduplicates", ["alpha", "beta"], ["alpha", "beta"], 1, false],
  ] as const)("%s the connection session set", (_name, next, watchedSessions, calls, changed) => {
    const { declarations, publishPresence, row } = createDeclarations();
    expect(declarations.replace("conn-a", [" beta ", "alpha", "beta"])).toEqual(["alpha", "beta"]);
    expect(row()?.watchedSessions).toEqual(["alpha", "beta"]);
    const activity = row()?.lastActivityAt;
    vi.setSystemTime(Date.now() + 1_000);
    expect(declarations.replace("conn-a", next)).toEqual(watchedSessions);
    expect(row()).toMatchObject({
      watchedSessions,
      lastActivityAt: changed ? Date.now() : activity,
    });
    expect(publishPresence).toHaveBeenCalledTimes(calls);
  });

  it("publishes an empty declaration and forgets state on disconnect", () => {
    const { declarations, publishPresence, row } = createDeclarations();

    declarations.replace("conn-a", ["alpha"]);
    const activity = row()?.lastActivityAt;
    vi.setSystemTime(Date.now() + 1_000);
    declarations.replace("conn-a", []);
    expect([row()?.watchedSessions, row()?.lastActivityAt]).toEqual([undefined, activity]);
    declarations.replace("conn-a", ["beta"]);
    const nextActivity = row()?.lastActivityAt;
    vi.setSystemTime(Date.now() + 1_000);
    declarations.unsubscribe("conn-a");
    expect(row()?.lastActivityAt).toBe(nextActivity);
    declarations.replace("conn-a", ["beta"]);
    expect(row()?.lastActivityAt).toBe(Date.now());
    expect(publishPresence).toHaveBeenCalledTimes(4);
  });

  it("rejects declarations from inactive connections and after stop", () => {
    const { declarations, client, clients, publishPresence } = createDeclarations();
    client.invalidated = true;
    expect(declarations.replace("conn-a", ["alpha"])).toEqual([]);
    client.invalidated = false;
    clients.delete(client);
    expect(declarations.replace("conn-a", ["alpha"])).toEqual([]);
    clients.add(client);
    declarations.stop();
    expect(declarations.replace("conn-a", ["alpha"])).toEqual([]);
    expect(publishPresence).not.toHaveBeenCalled();
  });
});

describe("presence projection without resident session facts", () => {
  it("preserves admitted presence without requiring its profile in the resident catalog", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "visitor",
            definitions: {
              visitor: {
                sessions: { others: "view" },
                agents: [],
                scopes: ["operator.sessions.write"],
              },
            },
          },
        },
      };
      const presence = [
        {
          ts: 1,
          text: "",
          user: {
            id: "retained-person",
            identity: { type: "profile" as const, id: "retained-person" },
          },
        },
      ];
      const project = createPresenceRecipientProjection({ cfg, presence });
      expect(project(recipient())).toEqual(presence);
      expect(project(recipient(["operator.sessions.read"]))).toEqual([]);
    });
  });

  it("shares watch selection across equal audiences and retires it when authority changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const key = "agent:main:presence-audience";
      const entry = { sessionId: "presence-audience", updatedAt: 1, visibility: "shared" as const };
      replaceSessionEntrySync({ agentId: "main", sessionKey: key }, entry);
      let cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      using _ = { [Symbol.dispose]: retainSessionListForegroundWork() };
      const projection = await createSessionRowProjection({
        cfg,
        modelCatalog: [],
        getPolicyConfig: () => cfg,
      });
      onTestFinished(() => projection.dispose());
      await projection.ensureMaterialized();
      const readTarget = projection.sharingTargetState.bind(projection);
      let selections = 0;
      const targetSpy = vi.spyOn(projection, "sharingTargetState").mockImplementation((query) => {
        const state = readTarget(query);
        if (state.status !== "ready") {
          return state;
        }
        return {
          ...state,
          target: {
            ...state.target,
            entry: {
              ...state.target.entry,
              get incognito() {
                selections++;
                return state.target.entry.incognito;
              },
            },
          },
        };
      });
      onTestFinished(() => targetSpy.mockRestore());
      const person = { text: "watcher", ts: 1 };
      const presence = [{ ...person, watchedSessions: [key] }];
      const project = createPresenceRecipientProjection({ cfg, presence, projection });
      const readers: GatewayClient[] = Array.from({ length: 65 }, () => ({
        ...recipient(["operator.read"]),
        authenticatedUserProfile: {
          profileId: "reader",
          displayName: "Reader",
          hasAvatar: false,
          updatedAt: 1,
        },
      }));
      const pending = recipient(["operator.read"]);
      pending.authenticatedGitHubIdentitySync = async () => ({
        profileId: "pending",
        updatedAt: 1,
      });
      for (const reader of readers) {
        expect(project(reader)).toEqual(presence);
        expect(project(pending)).toEqual([person]);
      }
      expect(selections).toBe(1);

      const reader = readers[0]!;
      reader.connect.scopes!.splice(0);
      expect(project(reader)).toEqual([]);
      reader.connect.scopes!.push("operator.read");
      expect(project(reader)).toEqual(presence);
      reader.authenticatedGitHubIdentitySync = pending.authenticatedGitHubIdentitySync;
      delete reader.authenticatedUserProfile;
      expect(project(reader)).toEqual([person]);

      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { ...entry, visibility: "draft" },
      );
      await projection.prepareMembership();
      expect(project(readers[1]!)).toEqual([person]);
      replaceSessionEntrySync({ agentId: "main", sessionKey: key }, entry);
      await projection.prepareMembership();
      expect(project(readers[1]!)).toEqual(presence);
      cfg = { ...cfg, gateway: { roles: { definitions: {} } } };
      expect(project(readers[1]!)).toEqual([person]);
      cfg = { agents: { entries: { main: {} } } };
      expect(project(readers[1]!)).toEqual(presence);
      projection.dispose();
      expect(projection.sharingRevision).toBeUndefined();
      expect(project(readers[1]!)).toEqual([person]);
    });
  });

  it("omits pending watch references until the session owner publishes ready facts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const key = "agent:main:presence-pending";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: "presence-pending", updatedAt: 1, visibility: "shared" },
      );
      const cfg = { agents: { entries: { main: {} } } };
      using _ = { [Symbol.dispose]: retainSessionListForegroundWork() };
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      using owner = { projection, [Symbol.dispose]: () => projection.dispose() };
      await owner.projection.ensureMaterialized();
      const person = { text: "watcher", ts: 1 };
      const presence = [{ ...person, watchedSessions: [key] }];
      const snapshot = () =>
        createPresenceRecipientProjection({ cfg, presence, projection })(recipient());
      expect(snapshot()).toEqual(presence);
      sessionChanges.emit({ sessionKey: key, factsInvalidated: "category" });
      expect(snapshot()).toEqual([person]);
      await projection.prepareMembership();
      expect(snapshot()).toEqual(presence);
    });
  });

  it("omits durable watches without reading stores and preserves roster scope enforcement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const person = { text: "watcher", ts: 1 };
      const presence = [{ ...person, watchedSessions: ["agent:main:presence-cold"] }];
      const pending = recipient(["operator.read"]);
      pending.authenticatedGitHubIdentitySync = async () => ({
        profileId: "pending",
        updatedAt: 1,
      });
      const node = recipient();
      node.connect.role = "node";
      const sql = observeHostDataSql();
      using _ = { [Symbol.dispose]: sql.restore };
      const project = createPresenceRecipientProjection({ cfg: {}, presence });
      for (const allowed of [recipient(), pending]) {
        expect(project(allowed)).toEqual([person]);
      }
      for (const denied of [recipient([]), node, null]) {
        expect(project(denied)).toEqual([]);
      }
      expect(sql.queries).toEqual([]);
    });
  });
});
