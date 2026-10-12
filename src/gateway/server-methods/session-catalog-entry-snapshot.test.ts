import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  buildSessionCreationStamp,
  inheritSessionCreationPolicy,
} from "../../config/sessions/session-entry-provenance.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  listSessionCatalogEntries,
  type SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import * as userProfileList from "../../state/user-profile-list.js";
import * as userProfiles from "../../state/user-profiles.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { createSessionCatalogRequestEntrySnapshot } from "./session-catalog-entry-snapshot.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{ provider: SessionCatalogProvider }>;
};

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
}));

vi.mock("../../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/runtime.js")>()),
  getActivePluginRegistry: () => hoisted.activeRegistry,
  getPluginRegistryForContext: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));

const { sessionCatalogHandlers } = await import("./session-catalog.js");
let projection: ReturnType<typeof createSessionRowProjectionFixture>;

function setEntries(entries: Array<{ sessionKey: string; entry: Partial<SessionEntry> }>) {
  for (const { sessionKey, entry } of entries) {
    projection.setEntry(sessionKey, { sessionId: sessionKey, updatedAt: 1, ...entry });
  }
}

function provider(id: string, sessionKey: string): SessionCatalogProvider {
  return {
    id,
    label: id.toUpperCase(),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    list: vi.fn(async ({ sessionEntries }) => {
      const entries = listSessionCatalogEntries({
        config: {},
        runtime: createPluginRuntime(),
        sessionEntries,
      });
      const adopted = entries.find((candidate) => candidate.sessionKey === sessionKey);
      return [
        {
          hostId: `gateway:${id}`,
          label: `${id} host`,
          kind: "gateway" as const,
          connected: true,
          sessions: adopted
            ? [
                {
                  threadId: `${id}-thread`,
                  status: "stored" as const,
                  archived: false,
                  sessionKey: adopted.sessionKey,
                  canContinue: true,
                  canArchive: false,
                },
              ]
            : [],
        },
      ];
    }),
  };
}

describe("session catalog entry snapshots", () => {
  afterEach(() => {
    projection.dispose();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
    projection = createSessionRowProjectionFixture({ cfg: {}, store: {} });
  });

  it("resolves catalog senders against current profiles without attributing unknown turns", async () => {
    vi.spyOn(userProfiles, "hasMultipleSessionSharingIdentities").mockReturnValue(false);
    vi.spyOn(userProfileList, "getUserProfileDisplay").mockImplementation((id) => {
      if (id !== "merged-profile") {
        throw new Error("unknown profile");
      }
      return { id: "current-profile", displayName: "Taylor", avatarRevision: "2", hasAvatar: true };
    });
    const items = [
      { type: "userMessage" as const, text: "Unknown author" },
      {
        type: "userMessage" as const,
        text: "Known author",
        sender: { identity: { type: "profile" as const, id: "merged-profile" }, label: "Stale" },
      },
      {
        type: "userMessage" as const,
        text: "Deleted author",
        sender: { identity: { type: "profile" as const, id: "deleted-profile" } },
      },
    ];
    const catalog = provider("external", "unused");
    catalog.read = async ({ hostId, threadId }) => ({
      hostId,
      threadId,
      items,
      nextCursor: "older",
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: catalog }];
    const respond = vi.fn();
    await sessionCatalogHandlers["sessions.catalog.read"]?.({
      params: { catalogId: "external", hostId: "gateway", threadId: "shared" },
      respond,
      context: bindSessionRowProjection({ getRuntimeConfig: () => ({}) }, () => projection),
    } as never);
    expect(respond).toHaveBeenCalledWith(true, {
      hostId: "gateway",
      threadId: "shared",
      nextCursor: "older",
      items: [
        items[0],
        {
          ...items[1],
          sender: {
            identity: { type: "profile", id: "current-profile" },
            label: "Taylor",
            avatarUrl: "/api/users/current-profile/avatar?v=2",
          },
        },
        items[2],
      ],
    });
  });

  it.each([
    [" BLUE ", "blue"],
    ["invalid", undefined],
    [undefined, undefined],
  ])("projects provider color %s to its canonical wire value", (color, expected) => {
    const snapshot = createSessionCatalogRequestEntrySnapshot({
      cfg: {},
      fallbackAgentId: "main",
      projection,
    });
    const host = snapshot.projectHostSessions(
      {
        hostId: "gateway:fixture",
        label: "Fixture",
        kind: "gateway",
        connected: true,
        sessions: [
          {
            threadId: "color-fixture",
            color,
            status: "stored",
            archived: false,
            canContinue: true,
            canArchive: false,
          },
        ],
      },
      new Map(),
    );
    expect(host.sessions[0]?.color).toBe(expected);
  });

  it("reuses planning revisions until entries or configuration change", async () => {
    const key = "agent:main:alpha-adopted";
    setEntries([{ sessionKey: key, entry: { label: "Before" } }]);
    let cfg = {};
    const context = bindSessionRowProjection({ getRuntimeConfig: () => cfg }, () => projection);
    const revisions: Array<object | undefined> = [];
    const labels: Array<string | undefined> = [];
    const catalog = provider("alpha", key);
    const list = catalog.list;
    catalog.list = async (params) => {
      revisions.push(params.sessionEntries?.revision);
      labels.push(params.sessionEntries?.entriesForCatalog?.()[0]?.entry.label);
      return list(params);
    };
    hoisted.activeRegistry.sessionCatalogs.push({ provider: catalog });
    const poll = async () => {
      const respond = vi.fn();
      await sessionCatalogHandlers["sessions.catalog.list"]!({
        params: {},
        respond,
        context,
      } as never);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
    };
    await poll();
    await poll();
    expect(revisions[0]).toBeDefined();
    expect(revisions[1]).toBe(revisions[0]);
    setEntries([{ sessionKey: key, entry: { label: "After", updatedAt: 2 } }]);
    await poll();
    expect(revisions[2]).not.toBe(revisions[1]);
    await poll();
    expect(revisions[3]).toBe(revisions[2]);
    cfg = {};
    await poll();
    expect(revisions[4]).not.toBe(revisions[3]);
    expect(labels).toEqual(["Before", "Before", "After", "After", "After"]);
  });

  it("projects inherited profile creators from stored provenance, not provider metadata", () => {
    const display = vi.spyOn(userProfileList, "getUserProfileDisplay").mockReturnValue({
      id: "current",
      displayName: "Current",
      avatarRevision: "1",
      hasAvatar: false,
    });
    const creation = buildSessionCreationStamp({
      via: "spawn",
      ...inheritSessionCreationPolicy(
        { createdActor: { type: "human", source: "profile", id: "former" }, sandbox: "required" },
        { type: "agent", id: "research" },
      ),
      now: 1,
    });
    const entries = [
      { sessionKey: "agent:main:child", entry: { ...creation, updatedAt: 1 } },
      {
        sessionKey: "agent:main:channel",
        entry: {
          ...buildSessionCreationStamp({
            via: "channel",
            actor: { type: "human", source: "channel", id: "former" },
            sandbox: "required",
            now: 1,
          }),
          updatedAt: 1,
        },
      },
    ];
    setEntries(entries);
    display.mockClear();
    const snapshot = createSessionCatalogRequestEntrySnapshot({
      cfg: {},
      fallbackAgentId: "main",
      projection,
    });
    const host: Parameters<typeof snapshot.projectHostSessions>[0] = {
      hostId: "gateway:fixture",
      label: "Fixture",
      kind: "gateway",
      connected: true,
      sessions: entries.map(({ sessionKey }) => ({
        sessionKey,
        threadId: sessionKey,
        status: "stored",
        archived: false,
        canContinue: true,
        canArchive: false,
        createdActor: { type: "human", id: "provider-spoof" },
      })),
    };
    const instances = new Map();
    snapshot.captureHostInstances(host, instances);
    const projected = snapshot.projectHostSessions(host, instances);
    expect(projected.sessions.map((session) => session.createdActor)).toEqual([
      {
        type: "human",
        id: "former",
        identity: { type: "profile", id: "current" },
        label: "Current",
      },
      {
        type: "human",
        id: "former",
        identity: { type: "legacy", actorType: "human", source: null, id: "former" },
      },
    ]);
    expect(display).toHaveBeenCalledExactlyOnceWith("former");
  });
});
