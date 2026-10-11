/* @vitest-environment jsdom */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { clearBootRecords, type BootRecord } from "../app/boot-record.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { bootRosterSchema } from "../lib/sessions/session-boot-roster-schema.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import { subscribeSnapshotInvalidation } from "../pages/chat/session-snapshot-invalidation-events.ts";
import {
  clearStoredChatSnapshots,
  deleteStoredChatSnapshot,
} from "../pages/chat/session-snapshot-invalidation.ts";
import {
  admitSidebarBootScope,
  sidebarSnapshotScopeKey,
} from "../pages/chat/session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { SidebarSnapshotController } from "./sidebar-snapshot-controller.ts";
import { parseSidebarSnapshot, type SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

const scope = {
  gatewayScope: "wss://sidebar.example",
  recoveryScope: "account-a",
  profileId: "profile-a",
};
const sessionKey = `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000agent:main:cedar`;
const model: SidebarSnapshotModel = {
  routingDefaults: { mainKey: "main", scope: "per-sender" },
  roster: null,
  mode: "roster",
  navigationView: "sessions",
  navigationScope: "all",
  scopesEquivalent: false,
  pages: [],
  pageScopeId: null,
  pinnedSessions: [],
  entries: ["online", "sessions"],
  sessions: [],
  sections: [],
  cards: [],
  collapsedAgentIds: [],
  collapsedSections: [],
  plugins: [],
  onlineUsers: [],
  onlineCounts: [],
  peopleSortMode: "presence",
  peopleStatusFilter: "all",
  onlineExpanded: true,
  ownerId: "profile-a",
  involvingMe: true,
  footer: { id: "profile-a", name: "Juniper" },
  brand: { name: "Synthetic workspace", avatar: null, icon: "mark", environment: null },
};

function fixture(initialAgentId = "main", initialPageScopeId: string | null = null) {
  let selectedAgentId = initialAgentId;
  let pageScopeId = initialPageScopeId;
  let snapshot: ApplicationGatewaySnapshot = {
    client: null,
    phase: "connecting",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: scope.gatewayScope, token: "", bootstrapToken: "", password: "" },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    connect() {},
    setSessionKey() {},
    start() {},
    stop() {},
    subscribe(listener: (snapshot: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: () => () => {},
    subscribeEvents: () => () => {},
    loadSelfProfile: async () => null,
  } satisfies ApplicationGateway;
  const restored = createDeferred();
  let saved = createDeferred();
  let settled = false;
  let captured = model;
  const capture = vi.fn(() => captured);
  const host: ConstructorParameters<typeof SidebarSnapshotController>[0] = {
    sidebarSnapshot: null,
    sessionDataContext: {
      gateway,
      agentSelection: {
        get state() {
          return { scopeId: pageScopeId };
        },
      },
    },
    expandedAgentId: () => selectedAgentId,
    captureSidebarSnapshot: capture,
    sidebarSnapshotSettled: () => settled,
    restoreSidebarSnapshot(value) {
      host.sidebarSnapshot = value;
      restored.resolve();
    },
    releaseSidebarSnapshot() {
      host.sidebarSnapshot = null;
    },
    clearSidebarSnapshot() {
      host.sidebarSnapshot = null;
    },
  };
  const controller = new SidebarSnapshotController(host);
  controller.subscribe(() => {
    if (controller.saved) {
      saved.resolve();
    }
  });
  return {
    gateway,
    capture,
    host,
    controller,
    restored: restored.promise,
    selectPageScope(scopeId: string | null) {
      pageScopeId = scopeId;
      controller.synchronize();
    },
    selectAgent(agentId: string) {
      selectedAgentId = agentId;
      controller.synchronize();
    },
    settle(value = model) {
      captured = value;
      settled = true;
      saved = createDeferred();
      return saved.promise;
    },
    publish(patch: Partial<ApplicationGatewaySnapshot> = {}) {
      snapshot = {
        ...snapshot,
        phase: "connected",
        hello: {
          ...gatewayHelloForMethods([]),
          auth: { role: "operator", scopes: [], recoveryScope: scope.recoveryScope },
        },
        selfUser: { id: scope.profileId },
        ...patch,
      };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

describe("sidebar snapshot lifecycle", () => {
  const disposers: Array<() => void> = [];
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    await clearStoredChatSnapshots();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function warmFixture() {
    const store = new SessionSnapshotStore();
    store.connect();
    disposers.push(() => store.disconnect());
    await store.writeSidebar(sidebarSnapshotScopeKey(scope), model, parseSidebarSnapshot);
    const test = fixture();
    disposers.push(
      admitSidebarBootScope(test.gateway, { ...scope, scope: scope.gatewayScope }),
      () => test.controller.disconnect(),
    );
    test.controller.connect();
    expect(test.controller.pending).toBe(true);
    await test.restored;
    return { ...test, store };
  }

  it("shares one boot read with route rows and retires both displays on invalidation", async () => {
    const store = new SessionSnapshotStore();
    store.connect();
    disposers.push(() => store.disconnect());
    const roster = {
      agentId: "main",
      result: sessionsResult(
        [{ key: "agent:main:cedar", kind: "direct", displayName: "Cedar" }],
        1,
      ),
      groups: [],
      groupSettings: [],
      sectionOrder: [],
    };
    const saved: SidebarSnapshotModel = { ...model, roster: bootRosterSchema.parse(roster) };
    await store.writeSidebar(sidebarSnapshotScopeKey(scope), saved, parseSidebarSnapshot);
    const read = vi.spyOn(SessionSnapshotStore.prototype, "readSidebar");
    const test = fixture();
    const sessions = createSessionCapability(
      test.gateway,
      {
        state: { selectedId: "main" },
        subscribe: () => () => {},
      },
      {
        bootRecord: {
          version: 2,
          authMethod: "trusted-proxy",
          credential: "",
          savedAt: Date.now(),
          scope: scope.gatewayScope,
          recoveryScope: scope.recoveryScope,
          profileId: scope.profileId,
          agents: {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main" }],
          },
          groups: [],
          sectionOrder: [],
        },
      },
    );
    disposers.push(
      () => sessions.dispose(),
      () => test.controller.disconnect(),
    );
    test.controller.connect();
    await Promise.all([test.restored, sessions.whenCachedRosterSettled()]);
    expect(sessions.state.result?.sessions).toEqual(roster.result.sessions);
    expect(sessions.state.resultCached).toBe(true);
    expect(test.host.sidebarSnapshot).toEqual(saved);
    expect(read).toHaveBeenCalledOnce();
    await deleteStoredChatSnapshot(sessionKey);
    expect(test.host.sidebarSnapshot).toBeNull();
    expect(sessions.state.result).toBeNull();
  });

  it.each(["before", "after"] as const)(
    "rejects another agent's chip snapshot when selection changes %s restoration",
    async (timing) => {
      const store = new SessionSnapshotStore();
      store.connect();
      disposers.push(() => store.disconnect());
      const chip: SidebarSnapshotModel = {
        ...model,
        mode: "chip",
        brand: { ...model.brand, agentId: "main" },
        roster: bootRosterSchema.parse({
          agentId: "main",
          result: sessionsResult([{ key: "agent:main:cedar", kind: "direct" }], 1),
          groups: [],
          groupSettings: [],
          sectionOrder: [],
        }),
      };
      await store.writeSidebar(sidebarSnapshotScopeKey(scope), chip, parseSidebarSnapshot);
      const test = fixture(timing === "before" ? "other" : "main");
      disposers.push(
        admitSidebarBootScope(test.gateway, { ...scope, scope: scope.gatewayScope }),
        () => test.controller.disconnect(),
      );
      test.controller.connect();
      if (timing === "before") {
        await new Promise<void>((resolve) => {
          const stop = test.controller.subscribe(() => {
            if (!test.controller.pending) {
              stop();
              resolve();
            }
          });
        });
      } else {
        await test.restored;
        expect(test.host.sidebarSnapshot).toEqual(chip);
        test.selectAgent("other");
      }
      expect(test.host.sidebarSnapshot).toBeNull();
      expect(test.controller.saved).toBe(false);
    },
  );

  it("keeps the multi-agent roster snapshot across agent selection", async () => {
    const test = await warmFixture();
    test.selectAgent("other");
    expect(test.host.sidebarSnapshot).toEqual(model);
  });

  it("releases a stalled boot read when the live sidebar settles", async () => {
    const stalled = createDeferred<SidebarSnapshotModel | null>();
    vi.spyOn(SessionSnapshotStore.prototype, "readSidebar").mockReturnValue(stalled.promise);
    const test = fixture();
    disposers.push(
      admitSidebarBootScope(test.gateway, { ...scope, scope: scope.gatewayScope }),
      () => test.controller.disconnect(),
    );
    test.controller.connect();
    expect(test.controller.pending).toBe(true);
    void test.settle();
    test.publish();
    expect(test.controller.pending).toBe(false);
    stalled.resolve(model);
    await vi.dynamicImportSettled();
    expect(test.host.sidebarSnapshot).toBeNull();
  });

  it.each(["before", "after"] as const)(
    "rejects a Pages snapshot when its agent filter changes %s restoration",
    async (timing) => {
      const store = new SessionSnapshotStore();
      store.connect();
      disposers.push(() => store.disconnect());
      const pages = { ...model, navigationView: "pages" as const, pageScopeId: "main" };
      await store.writeSidebar(sidebarSnapshotScopeKey(scope), pages, parseSidebarSnapshot);
      const test = fixture("main", timing === "before" ? "other" : "main");
      disposers.push(
        admitSidebarBootScope(test.gateway, { ...scope, scope: scope.gatewayScope }),
        () => test.controller.disconnect(),
      );
      test.controller.connect();
      if (timing === "before") {
        await new Promise<void>((resolve) => {
          const stop = test.controller.subscribe(() => {
            if (!test.controller.pending) {
              stop();
              resolve();
            }
          });
        });
      } else {
        await test.restored;
        test.selectPageScope("other");
      }
      expect(test.host.sidebarSnapshot).toBeNull();
      expect(test.controller.saved).toBe(false);
    },
  );

  it("keeps an all-agent Pages snapshot when only the selected chat agent changes", async () => {
    const store = new SessionSnapshotStore();
    store.connect();
    disposers.push(() => store.disconnect());
    const pages: SidebarSnapshotModel = { ...model, navigationView: "pages", pageScopeId: null };
    await store.writeSidebar(sidebarSnapshotScopeKey(scope), pages, parseSidebarSnapshot);
    const test = fixture();
    disposers.push(
      admitSidebarBootScope(test.gateway, { ...scope, scope: scope.gatewayScope }),
      () => test.controller.disconnect(),
    );
    test.controller.connect();
    await test.restored;
    test.selectAgent("other");
    expect(test.host.sidebarSnapshot).toEqual(pages);
  });

  it("restores before hello and saves only after rendering the settled live projection", async () => {
    const test = await warmFixture();
    expect(test.host.sidebarSnapshot).toEqual(model);
    expect(test.gateway.snapshot.phase).toBe("connecting");
    expect(test.controller.pending).toBe(false);
    test.publish();
    test.controller.capture();
    expect(test.host.sidebarSnapshot).toEqual(model);
    const live = { ...model, brand: { ...model.brand, name: "Updated workspace" } };
    const saved = test.settle(live);
    test.controller.synchronize();
    expect(test.host.sidebarSnapshot).toBeNull();
    expect(test.capture).not.toHaveBeenCalled();
    test.controller.capture();
    await saved;
    expect(
      await test.store.readSidebar(sidebarSnapshotScopeKey(scope), parseSidebarSnapshot),
    ).toEqual(live);
  });

  it("does not report an unchanged model saved while its write is pending", async () => {
    const test = fixture();
    const issued = createDeferred();
    const written = createDeferred<boolean>();
    vi.spyOn(SessionSnapshotStore.prototype, "writeSidebar").mockImplementation(() => {
      issued.resolve();
      return written.promise;
    });
    test.controller.connect();
    disposers.push(() => test.controller.disconnect());
    test.publish();
    const saved = test.settle();
    test.controller.capture();
    await issued.promise;
    try {
      test.controller.capture();
      expect(test.controller.saved).toBe(false);
    } finally {
      written.resolve(true);
    }
    await saved;
    expect(test.controller.saved).toBe(true);
  });

  it("waits for a reverted model to finish writing after a different model was queued", async () => {
    const test = await warmFixture();
    const issued = createDeferred();
    const written = createDeferred<boolean>();
    vi.spyOn(SessionSnapshotStore.prototype, "writeSidebar").mockImplementation(() => {
      issued.resolve();
      return written.promise;
    });
    test.publish();
    void test.settle({ ...model, onlineExpanded: false });
    test.controller.synchronize();
    test.controller.capture();
    await issued.promise;
    const saved = test.settle(model);
    try {
      test.controller.capture();
      test.controller.capture();
      expect(test.controller.saved).toBe(false);
    } finally {
      written.resolve(true);
    }
    await saved;
  });

  it.each(["profile", "connection"] as const)(
    "clears cached display when the %s changes even with the same recovery scope",
    async (change) => {
      const test = await warmFixture();
      if (change === "connection") {
        test.gateway.connectionRevision += 1;
      }
      test.publish(change === "profile" ? { selfUser: { id: "profile-b" } } : {});
      expect(test.host.sidebarSnapshot).toBeNull();
      expect(test.controller.saved).toBe(false);
    },
  );

  it.each(["account", "session", "cache-eviction"] as const)(
    "applies shared %s invalidation to the displayed projection",
    async (kind) => {
      const test = await warmFixture();
      await (kind === "account"
        ? clearStoredChatSnapshots(
            `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000`,
          )
        : deleteStoredChatSnapshot(sessionKey, kind === "cache-eviction" ? kind : undefined));
      expect(test.host.sidebarSnapshot).toEqual(kind === "cache-eviction" ? model : null);
      expect(test.controller.saved).toBe(kind === "cache-eviction");
    },
  );

  it("discards an admitted boot scope retired before the sidebar mounts", () => {
    const test = fixture();
    disposers.push(admitSidebarBootScope(test.gateway, { ...scope, scope: scope.gatewayScope }));
    clearBootRecords(scope.gatewayScope, { recoveryScope: scope.recoveryScope });
    test.controller.connect();
    disposers.push(() => test.controller.disconnect());
    expect(test.controller.pending).toBe(false);
    expect(test.host.sidebarSnapshot).toBeNull();
  });

  it("discards the boot scope before an asynchronous session deletion completes", async () => {
    const test = fixture();
    const deletion = createDeferred();
    const stop = subscribeSnapshotInvalidation(() => deletion.promise);
    disposers.push(admitSidebarBootScope(test.gateway, { ...scope, scope: scope.gatewayScope }));
    const clearing = deleteStoredChatSnapshot(sessionKey);
    try {
      test.controller.connect();
      disposers.push(() => test.controller.disconnect());
      expect(test.controller.pending).toBe(false);
    } finally {
      stop();
      deletion.resolve();
      await clearing;
    }
  });

  it("retires the displayed pre-hello cache when its boot owner rejects admission", async () => {
    const test = await warmFixture();
    clearBootRecords("wss://another.example", { recoveryScope: scope.recoveryScope });
    clearBootRecords(scope.gatewayScope, { recoveryScope: "previous-account" });
    expect(test.host.sidebarSnapshot).toEqual(model);
    clearBootRecords(scope.gatewayScope, { recoveryScope: scope.recoveryScope });
    test.controller.synchronize();
    expect(test.gateway.snapshot.phase).toBe("connecting");
    expect(test.gateway.snapshot.lastErrorAuthReason).toBeUndefined();
    expect(test.host.sidebarSnapshot).toBeNull();
    expect(test.controller.saved).toBe(false);
  });

  it("preserves same-owner replacement and waits for a new hello after admission retirement", async () => {
    const test = await warmFixture();
    test.publish();
    const replacement: BootRecord = {
      version: 2,
      scope: scope.gatewayScope,
      recoveryScope: scope.recoveryScope,
      profileId: scope.profileId,
      authMethod: "trusted-proxy",
      credential: "",
      savedAt: Date.now(),
      agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
      groups: [],
      sectionOrder: [],
    };
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `openclaw.control.bootRecord.v1:${scope.gatewayScope}`,
        newValue: JSON.stringify(replacement),
      }),
    );
    expect(test.host.sidebarSnapshot).toEqual(model);
    clearBootRecords(scope.gatewayScope, { recoveryScope: scope.recoveryScope });
    const saved = test.settle();
    test.controller.synchronize();
    test.controller.capture();
    expect(test.capture).not.toHaveBeenCalled();
    test.publish();
    test.controller.capture();
    await saved;
    expect(test.controller.saved).toBe(true);
    expect(
      await test.store.readSidebar(sidebarSnapshotScopeKey(scope), parseSidebarSnapshot),
    ).toEqual(model);
  });

  it("does not hold a cold render and can save again after remount", async () => {
    const test = fixture();
    disposers.push(() => test.controller.disconnect());
    test.controller.connect();
    expect(test.controller.pending).toBe(false);
    test.controller.disconnect();
    test.controller.connect();
    test.publish();
    const saved = test.settle();
    test.controller.capture();
    await saved;
    const store = new SessionSnapshotStore();
    store.connect();
    disposers.push(() => store.disconnect());
    expect(await store.readSidebar(sidebarSnapshotScopeKey(scope), parseSidebarSnapshot)).toEqual(
      model,
    );
  });
});
