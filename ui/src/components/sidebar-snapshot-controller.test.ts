/* @vitest-environment jsdom */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { clearBootRecords, type BootRecord } from "../app/boot-record.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { createGatewayHarness } from "../app/overlays-access.test-support.ts";
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
import { sidebarSnapshot } from "./sidebar-snapshot.test-support.ts";

const scope = {
  gatewayScope: "wss://sidebar.example",
  recoveryScope: "account-a",
  profileId: "profile-a",
};
const sessionKey = `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000agent:main:cedar`;
const model: SidebarSnapshotModel = {
  ...sidebarSnapshot,
  entries: ["route:usage"],
  ownerId: "profile-a",
  involvingMe: true,
};

function bootRecord(): BootRecord {
  return {
    version: 2,
    authMethod: "trusted-proxy",
    credential: "",
    savedAt: Date.now(),
    scope: scope.gatewayScope,
    recoveryScope: scope.recoveryScope,
    profileId: scope.profileId,
    agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
    groups: [],
    sectionOrder: [],
  };
}
function fixture(initialPageScopeId: string | null = null) {
  let selectedAgentId = "main";
  const agentSelection = { state: { scopeId: initialPageScopeId } };
  const harness = createGatewayHarness(null);
  const { gateway } = harness;
  gateway.connection.gatewayUrl = scope.gatewayScope;
  harness.replaceSnapshotWithoutPublishing({
    assistantAgentId: null,
    phase: "connecting",
    hello: null,
    sessionKey: "",
  });
  const restored = createDeferred();
  let saved = createDeferred();
  let settled = false;
  let captured = model;
  const capture = vi.fn(() => captured);
  const host: ConstructorParameters<typeof SidebarSnapshotController>[0] = {
    sidebarSnapshot: null,
    sessionDataContext: { gateway, agentSelection },
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
      agentSelection.state.scopeId = scopeId;
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
      harness.update({
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

  async function saveSnapshot(value = model) {
    const store = new SessionSnapshotStore();
    store.connect();
    disposers.push(() => store.disconnect());
    await store.writeSidebar(sidebarSnapshotScopeKey(scope), value, parseSidebarSnapshot);
    return store;
  }
  function connect(test: ReturnType<typeof fixture>, admit = true) {
    if (admit) {
      disposers.push(admitSidebarBootScope(test.gateway, { ...scope, scope: scope.gatewayScope }));
    }
    disposers.push(() => test.controller.disconnect());
    test.controller.connect();
  }
  function expectCleared(test: ReturnType<typeof fixture>) {
    expect(test.host.sidebarSnapshot).toBeNull();
    expect(test.controller.saved).toBe(false);
  }
  async function warmFixture(value = model, pageScope: string | null = null) {
    const store = await saveSnapshot(value);
    const test = fixture(pageScope);
    connect(test);
    expect(test.controller.pending).toBe(true);
    await test.restored;
    return { ...test, store };
  }

  it("shares one boot read with route rows and retires both displays on invalidation", async () => {
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
    await saveSnapshot(saved);
    const read = vi.spyOn(SessionSnapshotStore.prototype, "readSidebar");
    const test = fixture();
    const sessions = createSessionCapability(
      test.gateway,
      {
        state: { selectedId: "main" },
        subscribe: () => () => {},
      },
      {
        bootRecord: bootRecord(),
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
    connect(test);
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

  it.each([false, true])(
    "waits for the current snapshot write (reverted: %s)",
    async (reverted) => {
      const test = reverted ? await warmFixture() : fixture();
      const issued = createDeferred();
      const written = createDeferred<boolean>();
      vi.spyOn(SessionSnapshotStore.prototype, "writeSidebar").mockImplementation(() => {
        issued.resolve();
        return written.promise;
      });
      if (!reverted) {
        connect(test, false);
      }
      test.publish();
      const first = test.settle(reverted ? { ...model, peoplePresenceFilter: "all" } : model);
      if (reverted) {
        test.controller.synchronize();
      }
      test.controller.capture();
      await issued.promise;
      const saved = reverted ? test.settle(model) : first;
      try {
        test.controller.capture();
        if (reverted) {
          test.controller.capture();
        }
        expect(test.controller.saved).toBe(false);
      } finally {
        written.resolve(true);
      }
      await saved;
      expect(test.controller.saved).toBe(true);
    },
  );

  it.each(["profile", "connection"] as const)(
    "clears cached display when the %s changes even with the same recovery scope",
    async (change) => {
      const test = await warmFixture();
      if (change === "connection") {
        test.gateway.connectionRevision += 1;
      }
      test.publish(change === "profile" ? { selfUser: { id: "profile-b" } } : {});
      expectCleared(test);
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
      connect(test, false);
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
    expectCleared(test);
  });

  it("preserves same-owner replacement and waits for a new hello after admission retirement", async () => {
    const test = await warmFixture();
    test.publish();
    const replacement = bootRecord();
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
