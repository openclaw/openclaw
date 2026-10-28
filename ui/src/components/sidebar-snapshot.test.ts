/* @vitest-environment jsdom */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { clearBootRecords, type BootRecord } from "../app/boot-record.ts";
import { makeBootRoster } from "../app/bootstrap.test-support.ts";
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
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../test-helpers/application-context-fixtures.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { parseSidebarSnapshot, type SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";
import { createSidebarSnapshot } from "./sidebar-snapshot.ts";

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
  pages: [],
  pageScopeId: null,
  pinnedSessions: [],
  entries: ["route:usage"],
  sections: [],
  cards: [],
  collapsedAgentIds: [],
  collapsedSections: [],
  plugins: [],
  onlineUsers: [],
  onlineCounts: [],
  peopleSortMode: "presence",
  peopleStatusFilter: "all",
  peoplePresenceFilter: "online",
  offlineUsers: [],
  ownerId: "profile-a",
  involvingMe: true,
  footer: { id: "profile-a", name: "Juniper" },
  brand: { name: "Synthetic workspace", avatar: null, icon: "mark", environment: null },
};

function fixture(initialAgentId = "main", initialPageScopeId: string | null = null) {
  let selectedAgentId = initialAgentId;
  let pageScopeId = initialPageScopeId;
  const publication = createApplicationGateway(
    createApplicationGatewaySnapshot({ phase: "connecting" }),
  );
  const gateway = Object.assign(publication.gateway, {
    connection: { gatewayUrl: scope.gatewayScope, token: "", bootstrapToken: "", password: "" },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    connect() {},
    defer: () => false,
    setSessionKey() {},
    start() {},
    stop() {},
    subscribeEventLog: () => () => {},
    subscribeEvents: () => () => {},
    loadSelfProfile: async () => null,
  }) satisfies ApplicationGateway;
  const restored = createDeferred();
  let saved = createDeferred();
  let settled = false;
  let captured = model;
  const capture = vi.fn(() => captured);
  const foreground = { foregroundReady: true };
  const host: Parameters<typeof createSidebarSnapshot>[0] = {
    sidebarSnapshot: null,
    sessionDataContext: {
      gateway,
      connectionBootstrap: foreground,
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
  const snapshotOwner = createSidebarSnapshot(host);
  snapshotOwner.subscribe(() => {
    if (snapshotOwner.read().saved) {
      saved.resolve();
    }
  });
  return {
    gateway,
    foreground,
    capture,
    host,
    snapshotOwner,
    restored: restored.promise,
    selectPageScope(scopeId: string | null) {
      pageScopeId = scopeId;
      snapshotOwner.synchronize();
    },
    selectAgent(agentId: string) {
      selectedAgentId = agentId;
      snapshotOwner.synchronize();
    },
    settle(value = model) {
      captured = value;
      settled = true;
      saved = createDeferred();
      return saved.promise;
    },
    publish(patch: Partial<ApplicationGatewaySnapshot> = {}) {
      publication.publish({
        ...gateway.snapshot,
        phase: "connected",
        hello: {
          ...gatewayHelloForMethods([]),
          auth: { role: "operator", scopes: [], recoveryScope: scope.recoveryScope },
        },
        selfUser: { id: scope.profileId },
        ...patch,
      });
    },
  };
}

describe("sidebar snapshot lifecycle", () => {
  const disposers: Array<() => void> = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    await clearStoredChatSnapshots();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function capture(controller: ReturnType<typeof createSidebarSnapshot>) {
    controller.capture();
    await vi.advanceTimersByTimeAsync(500);
  }

  async function warmFixture(initial = model) {
    const store = new SessionSnapshotStore();
    store.connect();
    disposers.push(() => store.disconnect());
    await store.writeSidebar(sidebarSnapshotScopeKey(scope), initial, parseSidebarSnapshot);
    const test = fixture();
    disposers.push(
      admitSidebarBootScope(test.gateway, { ...scope, scope: scope.gatewayScope }),
      () => test.snapshotOwner.disconnect(),
    );
    test.snapshotOwner.connect();
    expect(test.snapshotOwner.read().pending).toBe(true);
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
          agents: makeBootRoster(),
          groups: [],
          sectionOrder: [],
        },
      },
    );
    disposers.push(
      () => sessions.dispose(),
      () => test.snapshotOwner.disconnect(),
    );
    test.snapshotOwner.connect();
    await test.restored;
    await vi.runOnlyPendingTimersAsync();
    await sessions.whenCachedRosterSettled();
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
        () => test.snapshotOwner.disconnect(),
      );
      test.snapshotOwner.connect();
      if (timing === "before") {
        await new Promise<void>((resolve) => {
          const stop = test.snapshotOwner.subscribe(() => {
            if (!test.snapshotOwner.read().pending) {
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
      expect(test.snapshotOwner.read().saved).toBe(false);
    },
  );

  it.each(["remove", "reorder"] as const)(
    "persists accepted cached group %s for another offline boot",
    async (action) => {
      const first = { id: "first", label: "Focus", sessionKeys: [] };
      const second = { id: "second", label: "Later", sessionKeys: [] };
      const test = await warmFixture({ ...model, personalGroups: [first, second] });
      const personalGroups = action === "remove" ? [second] : [second, first];
      test.host.sidebarSnapshot!.personalGroups = personalGroups;
      await capture(test.snapshotOwner);
      expect(
        await test.store.readSidebar(sidebarSnapshotScopeKey(scope), parseSidebarSnapshot),
      ).toMatchObject({ personalGroups });
      const next = fixture();
      disposers.push(
        admitSidebarBootScope(next.gateway, { ...scope, scope: scope.gatewayScope }),
        () => next.snapshotOwner.disconnect(),
      );
      next.snapshotOwner.connect();
      await next.restored;
      expect(next.host.sidebarSnapshot?.personalGroups).toEqual(personalGroups);
      expect(test.capture).not.toHaveBeenCalled();
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
      () => test.snapshotOwner.disconnect(),
    );
    test.snapshotOwner.connect();
    expect(test.snapshotOwner.read().pending).toBe(true);
    void test.settle();
    test.publish();
    expect(test.snapshotOwner.read().pending).toBe(false);
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
        () => test.snapshotOwner.disconnect(),
      );
      test.snapshotOwner.connect();
      if (timing === "before") {
        await new Promise<void>((resolve) => {
          const stop = test.snapshotOwner.subscribe(() => {
            if (!test.snapshotOwner.read().pending) {
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
      expect(test.snapshotOwner.read().saved).toBe(false);
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
      () => test.snapshotOwner.disconnect(),
    );
    test.snapshotOwner.connect();
    await test.restored;
    test.selectAgent("other");
    expect(test.host.sidebarSnapshot).toEqual(pages);
  });

  it("restores before hello and saves only after rendering the settled live projection", async () => {
    const test = await warmFixture();
    expect(test.host.sidebarSnapshot).toEqual(model);
    expect(test.gateway.snapshot.phase).toBe("connecting");
    expect(test.snapshotOwner.read().pending).toBe(false);
    test.publish();
    await capture(test.snapshotOwner);
    expect(test.host.sidebarSnapshot).toEqual(model);
    const live = { ...model, brand: { ...model.brand, name: "Updated workspace" } };
    const saved = test.settle(live);
    test.snapshotOwner.synchronize();
    expect(test.host.sidebarSnapshot).toBeNull();
    expect(test.capture).not.toHaveBeenCalled();
    await capture(test.snapshotOwner);
    await saved;
    expect(
      await test.store.readSidebar(sidebarSnapshotScopeKey(scope), parseSidebarSnapshot),
    ).toEqual(live);
  });

  it("keeps admitted rows through unresolved hello and saves only after identity resolves", async () => {
    const test = await warmFixture();
    test.publish({ selfUser: undefined });
    expect(test.host.sidebarSnapshot).toEqual(model);
    const saved = test.settle();
    test.snapshotOwner.synchronize();
    expect(test.host.sidebarSnapshot).toBeNull();
    await capture(test.snapshotOwner);
    expect(test.capture).not.toHaveBeenCalled();
    test.publish();
    await capture(test.snapshotOwner);
    await saved;
    expect(test.capture).toHaveBeenCalledOnce();
  });

  it("hands off the complete roster at idle after the current transcript is ready", async () => {
    const idle = vi.fn<(callback: IdleRequestCallback) => number>().mockReturnValue(1);
    vi.stubGlobal("requestIdleCallback", idle);
    const cancelIdle = vi.fn();
    vi.stubGlobal("cancelIdleCallback", cancelIdle);
    const test = await warmFixture();
    test.foreground.foregroundReady = false;
    test.publish();
    void test.settle();
    test.snapshotOwner.synchronize();
    expect(test.host.sidebarSnapshot).toEqual(model);
    expect(idle).not.toHaveBeenCalled();
    test.foreground.foregroundReady = true;
    document.dispatchEvent(new Event("openclaw-chat-transcript-loading-changed"));
    await Promise.resolve();
    expect(test.host.sidebarSnapshot).toEqual(model);
    expect(idle).toHaveBeenCalledOnce();
    idle.mock.calls[0]![0]({ didTimeout: false, timeRemaining: () => 10 });
    expect(test.host.sidebarSnapshot).toBeNull();
    expect(cancelIdle).toHaveBeenCalledWith(1);
  });

  it.each(["incomplete-roster", "transcript", "scope-change"] as const)(
    "bounds a stalled handoff and retires it on %s",
    async (boundary) => {
      const test = await warmFixture();
      test.foreground.foregroundReady = false;
      test.publish();
      if (boundary !== "incomplete-roster") {
        void test.settle();
      }
      test.snapshotOwner.synchronize();
      await vi.advanceTimersByTimeAsync(2999);
      expect(test.host.sidebarSnapshot).toEqual(model);
      if (boundary === "scope-change") {
        test.publish({ selfUser: { id: "profile-b" } });
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(test.host.sidebarSnapshot).toBeNull();
      expect(test.capture).not.toHaveBeenCalled();
    },
  );

  it("starts a new handoff deadline after reconnecting", async () => {
    const test = await warmFixture();
    test.publish();
    await vi.advanceTimersByTimeAsync(2999);
    test.publish({ phase: "reconnecting" });
    await vi.advanceTimersByTimeAsync(3001);
    test.publish();
    expect(test.host.sidebarSnapshot).toEqual(model);
    await vi.advanceTimersByTimeAsync(2999);
    expect(test.host.sidebarSnapshot).toEqual(model);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.host.sidebarSnapshot).toBeNull();
    expect(test.capture).not.toHaveBeenCalled();
  });

  it.each(["idle", "pagehide", "hidden"] as const)(
    "coalesces a burst and persists its latest shape on %s for the next reload",
    async (boundary) => {
      let idle: IdleRequestCallback | undefined;
      vi.stubGlobal(
        "requestIdleCallback",
        vi.fn((callback: IdleRequestCallback) => {
          idle = callback;
          return 1;
        }),
      );
      vi.stubGlobal(
        "cancelIdleCallback",
        vi.fn(() => {
          idle = undefined;
        }),
      );
      const test = fixture();
      disposers.push(() => test.snapshotOwner.disconnect());
      test.snapshotOwner.connect();
      test.publish();
      void test.settle();
      for (let index = 0; index < 24; index += 1) {
        test.snapshotOwner.capture();
      }
      expect(test.capture).not.toHaveBeenCalled();
      const latest = { ...model, entries: ["route:agents"], collapsedSections: ["online"] };
      const saved = test.settle(latest);
      await vi.advanceTimersByTimeAsync(500);
      expect(test.capture).not.toHaveBeenCalled();
      if (boundary === "idle") {
        idle?.({ didTimeout: false, timeRemaining: () => 50 });
      } else if (boundary === "pagehide") {
        window.dispatchEvent(new Event("pagehide"));
      } else {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      }
      await saved;
      expect(test.capture).toHaveBeenCalledOnce();
      const next = fixture();
      disposers.push(
        admitSidebarBootScope(next.gateway, { ...scope, scope: scope.gatewayScope }),
        () => next.snapshotOwner.disconnect(),
      );
      next.snapshotOwner.connect();
      await next.restored;
      expect(next.host.sidebarSnapshot).toEqual(latest);
      expect(next.gateway.snapshot.phase).toBe("connecting");
    },
  );

  it("cancels pending capture when its account scope retires", async () => {
    const test = await warmFixture();
    void test.settle();
    test.publish();
    test.snapshotOwner.capture();
    clearBootRecords(scope.gatewayScope, { recoveryScope: scope.recoveryScope });
    await vi.advanceTimersByTimeAsync(1500);
    expect(test.capture).not.toHaveBeenCalled();
    expect(
      await test.store.readSidebar(sidebarSnapshotScopeKey(scope), parseSidebarSnapshot),
    ).toBeNull();
  });

  it("does not report an unchanged model saved while its write is pending", async () => {
    const test = fixture();
    const issued = createDeferred();
    const written = createDeferred<boolean>();
    vi.spyOn(SessionSnapshotStore.prototype, "writeSidebar").mockImplementation(() => {
      issued.resolve();
      return written.promise;
    });
    test.snapshotOwner.connect();
    disposers.push(() => test.snapshotOwner.disconnect());
    test.publish();
    const saved = test.settle();
    await capture(test.snapshotOwner);
    await issued.promise;
    try {
      await capture(test.snapshotOwner);
      expect(test.snapshotOwner.read().saved).toBe(false);
    } finally {
      written.resolve(true);
    }
    await saved;
    expect(test.snapshotOwner.read().saved).toBe(true);
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
    void test.settle({ ...model, peoplePresenceFilter: "all" });
    test.snapshotOwner.synchronize();
    await capture(test.snapshotOwner);
    await issued.promise;
    const saved = test.settle(model);
    try {
      await capture(test.snapshotOwner);
      await capture(test.snapshotOwner);
      expect(test.snapshotOwner.read().saved).toBe(false);
    } finally {
      written.resolve(true);
    }
    await saved;
  });

  it.each(["profile", "profileless", "connection"] as const)(
    "clears cached display when the %s changes even with the same recovery scope",
    async (change) => {
      const test = await warmFixture();
      if (change === "connection") {
        test.gateway.connectionRevision += 1;
      }
      test.publish(
        change === "profile"
          ? { selfUser: { id: "profile-b" } }
          : change === "profileless"
            ? { selfUser: null }
            : {},
      );
      expect(test.host.sidebarSnapshot).toBeNull();
      expect(test.snapshotOwner.read().saved).toBe(false);
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
      expect(test.snapshotOwner.read().saved).toBe(kind === "cache-eviction");
    },
  );

  it("discards an admitted boot scope retired before the sidebar mounts", () => {
    const test = fixture();
    disposers.push(admitSidebarBootScope(test.gateway, { ...scope, scope: scope.gatewayScope }));
    clearBootRecords(scope.gatewayScope, { recoveryScope: scope.recoveryScope });
    test.snapshotOwner.connect();
    disposers.push(() => test.snapshotOwner.disconnect());
    expect(test.snapshotOwner.read().pending).toBe(false);
    expect(test.host.sidebarSnapshot).toBeNull();
  });

  it("discards the boot scope before an asynchronous session deletion completes", async () => {
    const test = fixture();
    const deletion = createDeferred();
    const stop = subscribeSnapshotInvalidation(() => deletion.promise);
    disposers.push(admitSidebarBootScope(test.gateway, { ...scope, scope: scope.gatewayScope }));
    const clearing = deleteStoredChatSnapshot(sessionKey);
    try {
      test.snapshotOwner.connect();
      disposers.push(() => test.snapshotOwner.disconnect());
      expect(test.snapshotOwner.read().pending).toBe(false);
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
    test.snapshotOwner.synchronize();
    expect(test.gateway.snapshot.phase).toBe("connecting");
    expect(test.gateway.snapshot.lastErrorAuthReason).toBeUndefined();
    expect(test.host.sidebarSnapshot).toBeNull();
    expect(test.snapshotOwner.read().saved).toBe(false);
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
      agents: makeBootRoster(),
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
    test.snapshotOwner.synchronize();
    await capture(test.snapshotOwner);
    expect(test.capture).not.toHaveBeenCalled();
    test.publish();
    await capture(test.snapshotOwner);
    await saved;
    expect(test.snapshotOwner.read().saved).toBe(true);
    expect(
      await test.store.readSidebar(sidebarSnapshotScopeKey(scope), parseSidebarSnapshot),
    ).toEqual(model);
  });

  it("does not hold a cold render and can save again after remount", async () => {
    const test = fixture();
    disposers.push(() => test.snapshotOwner.disconnect());
    test.snapshotOwner.connect();
    expect(test.snapshotOwner.read().pending).toBe(false);
    test.snapshotOwner.disconnect();
    test.snapshotOwner.connect();
    test.publish();
    const saved = test.settle();
    await capture(test.snapshotOwner);
    await saved;
    const store = new SessionSnapshotStore();
    store.connect();
    disposers.push(() => store.disconnect());
    expect(await store.readSidebar(sidebarSnapshotScopeKey(scope), parseSidebarSnapshot)).toEqual(
      model,
    );
  });
});
