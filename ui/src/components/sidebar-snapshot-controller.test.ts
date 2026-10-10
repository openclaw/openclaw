/* @vitest-environment jsdom */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { clearBootRecords, type BootRecord } from "../app/boot-record.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/gateway.ts";
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
  mode: "roster",
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

function fixture() {
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
    sessionDataContext: { gateway },
    addController() {},
    removeController() {},
    updateComplete: Promise.resolve(true),
    requestUpdate() {
      if (controller.saved) {
        saved.resolve();
      }
    },
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
  return {
    gateway,
    capture,
    host,
    controller,
    restored: restored.promise,
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
      () => test.controller.hostDisconnected(),
    );
    test.controller.hostConnected();
    expect(test.controller.pending).toBe(true);
    await test.restored;
    return { ...test, store };
  }

  it("restores before hello and saves only after rendering the settled live projection", async () => {
    const test = await warmFixture();
    expect(test.host.sidebarSnapshot).toEqual(model);
    expect(test.gateway.snapshot.phase).toBe("connecting");
    expect(test.controller.pending).toBe(false);
    test.publish();
    test.controller.hostUpdated();
    expect(test.host.sidebarSnapshot).toEqual(model);
    const live = { ...model, brand: { ...model.brand, name: "Updated workspace" } };
    const saved = test.settle(live);
    test.controller.hostUpdated();
    expect(test.host.sidebarSnapshot).toBeNull();
    expect(test.capture).not.toHaveBeenCalled();
    test.controller.hostUpdated();
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
    test.controller.hostConnected();
    disposers.push(() => test.controller.hostDisconnected());
    test.publish();
    const saved = test.settle();
    test.controller.hostUpdated();
    await issued.promise;
    try {
      test.controller.hostUpdated();
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
    test.controller.hostUpdated();
    test.controller.hostUpdated();
    await issued.promise;
    const saved = test.settle(model);
    try {
      test.controller.hostUpdated();
      test.controller.hostUpdated();
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
    test.controller.hostConnected();
    disposers.push(() => test.controller.hostDisconnected());
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
      test.controller.hostConnected();
      disposers.push(() => test.controller.hostDisconnected());
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
    test.controller.hostUpdate();
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
    test.controller.hostUpdate();
    test.controller.hostUpdated();
    expect(test.capture).not.toHaveBeenCalled();
    test.publish();
    test.controller.hostUpdated();
    await saved;
    expect(test.controller.saved).toBe(true);
    expect(
      await test.store.readSidebar(sidebarSnapshotScopeKey(scope), parseSidebarSnapshot),
    ).toEqual(model);
  });

  it("does not hold a cold render and can save again after remount", async () => {
    const test = fixture();
    disposers.push(() => test.controller.hostDisconnected());
    test.controller.hostConnected();
    expect(test.controller.pending).toBe(false);
    test.controller.hostDisconnected();
    test.controller.hostConnected();
    test.publish();
    const saved = test.settle();
    test.controller.hostUpdated();
    await saved;
    const store = new SessionSnapshotStore();
    store.connect();
    disposers.push(() => store.disconnect());
    expect(await store.readSidebar(sidebarSnapshotScopeKey(scope), parseSidebarSnapshot)).toEqual(
      model,
    );
  });
});
