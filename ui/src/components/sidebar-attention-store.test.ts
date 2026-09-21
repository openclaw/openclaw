/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type {
  CronCompactJob,
  CronJobsListResult,
  CronStatus,
  ModelAuthStatusResult,
} from "../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import type { ApplicationContext } from "../app/context.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import {
  createSidebarAttentionStore,
  type SidebarAttentionStore,
} from "../app/sidebar-attention-store.ts";
import { captureChatOutboxAdmission } from "../lib/chat/outbox-store.ts";
import { invalidateModelAuthStatusRequests } from "../lib/model-auth-request-state.ts";
import {
  admitStoredChatComposerQueueItem,
  removeStoredChatComposerQueueItem,
} from "../pages/chat/composer-persistence.ts";
import { hiddenScopeUpgradeCapability } from "../test-helpers/application-context.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  dismissSidebarAttention,
  loadDismissals,
  resolveSidebarAttentionKey,
} from "./sidebar-attention-dismissals.ts";
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";

type CompactCronPage = CronJobsListResult<CronCompactJob>;

function cronPage(id?: string): CompactCronPage {
  const jobs = id
    ? [
        {
          id,
          name: id,
          enabled: true,
          updatedAtMs: 0,
          scheduleKind: "every" as const,
          nextRunAt: null,
          nextRunAtMs: null,
          lastRunAt: null,
          lastRunAtMs: null,
          lastRunError: null,
          lastRunStatus: "error" as const,
        },
      ]
    : [];
  return {
    jobs,
    snapshotRevision: id ?? "empty",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

describe("sidebar attention source publication", () => {
  let store: SidebarAttentionStore | undefined;

  afterEach(() => {
    store?.dispose();
    store = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createStore(
    gateway: ApplicationContext["gateway"],
    connectionBootstrap?: ApplicationContext["connectionBootstrap"],
  ) {
    const agentSelection = {
      state: { selectedId: "main", scopeId: null },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["agentSelection"];
    return createSidebarAttentionStore({
      gateway,
      agentSelection,
      agents: {
        state: { agentsList: null },
        subscribe: () => () => undefined,
      } as unknown as ApplicationContext["agents"],
      overlays: {
        snapshot: { approvalQueue: [] },
        subscribe: () => () => undefined,
      } as unknown as ApplicationContext["overlays"],
      scopeUpgrade: hiddenScopeUpgradeCapability,
      connectionBootstrap,
    });
  }

  it.each([false, true])(
    "keeps snoozes with their authenticated account across switches and reloads (reconnect: %s)",
    async (reconnect) => {
      vi.stubGlobal("localStorage", createStorageMock());
      const jobs = [...cronPage("dismissed-incident").jobs, ...cronPage("visible-incident").jobs];
      const request = vi.fn(async (method: string) =>
        method === "cron.list"
          ? { ...cronPage(), jobs, total: jobs.length }
          : method === "cron.status"
            ? { enabled: true, triggersEnabled: true, jobs: jobs.length }
            : { ts: 1, providers: [] },
      );
      const harness = createGatewayHarness(mockClient(request));
      harness.update({ selfUser: { id: "alice", name: "Alice" } });
      const alice = {
        id: "alice",
        identity: { type: "profile" as const, id: "alice" },
        name: "Alice",
      };
      const bob = { id: "bob", identity: { type: "profile" as const, id: "bob" }, name: "Bob" };
      harness.update({ selfUser: alice });
      store = createStore(harness.gateway);
      store.activate(SidebarAttentionStoreController);
      await waitForFast(() => expect(store?.entries).toHaveLength(2));
      store.dismiss({ kind: "cronFailed", signature: "dismissed-incident" });
      expect(store.entries).toMatchObject([{ label: "visible-incident" }]);

      // The connection and incident are unchanged; only the authenticated account changes.
      if (reconnect) {
        harness.update({ phase: "reconnecting", selfUser: null });
        store.dismiss({ kind: "cronFailed", signature: "visible-incident" });
      }
      harness.update({ phase: "connected", selfUser: bob });
      await waitForFast(() => expect(store?.entries).toHaveLength(2));
      store.dispose();
      store = createStore(harness.gateway);
      store.activate(SidebarAttentionStoreController);
      await waitForFast(() => expect(store?.entries).toHaveLength(2));

      const bobKey = resolveSidebarAttentionKey(harness.gateway);
      if (!bobKey) {
        throw new Error("expected Bob's authenticated storage scope");
      }
      dismissSidebarAttention(bobKey, { kind: "cronFailed", signature: "visible-incident" });
      globalThis.dispatchEvent(new StorageEvent("storage", { key: bobKey }));
      expect(store.entries).toMatchObject([{ label: "dismissed-incident" }]);

      harness.update({ selfUser: alice });
      await waitForFast(() =>
        expect(store?.entries).toMatchObject([{ label: "visible-incident" }]),
      );
    },
  );

  it("keeps same-profile snoozes isolated between query-routed Gateways", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const jobs = [...cronPage("first-incident").jobs, ...cronPage("second-incident").jobs];
    const request = vi.fn(async (method: string) =>
      method === "cron.list"
        ? { ...cronPage(), jobs, total: jobs.length }
        : method === "cron.status"
          ? { enabled: true, triggersEnabled: true, jobs: jobs.length }
          : { ts: 1, providers: [] },
    );
    const harness = createGatewayHarness(mockClient(request));
    const selfUser = { id: "alice", name: "Alice" };
    const connectTenant = (tenant: string) => {
      harness.update({ phase: "reconnecting", selfUser: null });
      harness.gateway.connection.gatewayUrl = `wss://gateway.test/path?tenant=${tenant}`;
      harness.gateway.connectionRevision += 1;
      harness.update({ phase: "connected", selfUser });
    };
    connectTenant("a");
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    await waitForFast(() => expect(store?.entries).toHaveLength(2));
    store.dismiss({ kind: "cronFailed", signature: "first-incident" });
    expect(store.entries).toMatchObject([{ label: "second-incident" }]);

    connectTenant("b");
    await waitForFast(() => expect(store?.entries).toHaveLength(2));
    store.dismiss({ kind: "cronFailed", signature: "second-incident" });
    expect(store.entries).toMatchObject([{ label: "first-incident" }]);

    connectTenant("a");
    await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "second-incident" }]));
  });

  it("retires old-account health before the eager facade publishes a storage refresh", async () => {
    let profile = "alice";
    const request = vi.fn(async (method: string) =>
      method === "cron.list"
        ? cronPage(profile)
        : method === "cron.status"
          ? { enabled: true, triggersEnabled: true, jobs: 1 }
          : { ts: 1, providers: [] },
    );
    const harness = createGatewayHarness(mockClient(request));
    harness.update({ selfUser: { id: profile, name: profile } });
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "alice" }]));
    const published: string[] = [];
    store.subscribe(() => {
      if (harness.gateway.snapshot.selfUser?.id === "bob") {
        published.push(
          ...(store?.entries.flatMap((entry) =>
            entry.type === "attention" ? [entry.label] : [],
          ) ?? []),
        );
      }
    });
    profile = "bob";
    harness.update({ selfUser: { id: profile, name: profile } });
    await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "bob" }]));
    expect(published).not.toContain("alice");
  });

  it("retires only the current account's scope-upgrade snooze before the Inbox mounts", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const alice = 'openclaw.control.sidebarAttention.v2:["ws://gateway.test","alice"]';
    const bob = 'openclaw.control.sidebarAttention.v2:["ws://gateway.test","bob"]';
    const dismissal = { kind: "scopeUpgrade" as const, signature: "available" };
    dismissSidebarAttention(alice, dismissal);
    dismissSidebarAttention(bob, dismissal);
    const legacyKey = "openclaw.control.sidebarAttention.v1:ws://gateway.test";
    const legacy = JSON.stringify({ scopeUpgrade: ["unknown-owner"] });
    localStorage.setItem(legacyKey, legacy);
    const harness = createGatewayHarness(mockClient(async () => ({})));
    harness.update({
      selfUser: { id: "alice", name: "Alice" },
      hello: {
        ...harness.gateway.snapshot.hello!,
        auth: { role: "operator", scopes: ["operator.admin"] },
      },
    });
    store = createStore(harness.gateway);
    expect(loadDismissals(alice)).toEqual({});
    expect(loadDismissals(bob)).toEqual({ scopeUpgrade: ["available"] });
    expect(localStorage.getItem(legacyKey)).toBe(legacy);
  });

  it.each(["ready", "hidden", "disposed"] as const)(
    "holds automatic cron inventory until chat is ready and respects a %s owner",
    async (boundary) => {
      let visibility: DocumentVisibilityState = "visible";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      const bootstrap = createConnectionBootstrapCoordinator();
      const offsets: number[] = [];
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "cron.list") {
          const offset = isRecord(params) ? Number(params.offset ?? 0) : 0;
          offsets.push(offset);
          return offset === 0
            ? {
                ...cronPage("first"),
                snapshotRevision: "inventory",
                total: 2,
                hasMore: true,
                nextOffset: 1,
              }
            : { ...cronPage("later"), snapshotRevision: "inventory", total: 2, offset: 1 };
        }
        return method === "cron.status"
          ? { enabled: true, triggersEnabled: true, jobs: 2 }
          : { ts: 1, providers: [] };
      });
      const client = mockClient(request);
      const harness = createGatewayHarness(client);
      bootstrap.setForegroundRoute("agent:main:current");
      bootstrap.synchronize({ client, connected: true });
      store = createStore(harness.gateway, bootstrap);
      try {
        store.activate(SidebarAttentionStoreController);
        expect(request.mock.calls.filter(([method]) => method.startsWith("cron."))).toEqual([]);
        if (boundary === "hidden") {
          visibility = "hidden";
        } else if (boundary === "disposed") {
          store.dispose();
        }
        bootstrap.setForegroundPane({}, { sessionKey: "agent:main:current", client, ready: true });
        if (boundary === "ready") {
          await waitForFast(() => expect(offsets).toEqual([0, 1]));
          await waitForFast(() => expect(store?.entries).toHaveLength(2));
        } else {
          await Promise.resolve();
          expect(offsets).toEqual([]);
          expect(request.mock.calls.filter(([method]) => method === "cron.status")).toEqual([]);
        }
      } finally {
        bootstrap.reset();
      }
    },
  );

  it("includes failed automations beyond the first inventory page", async () => {
    const healthy = cronPage("healthy").jobs[0]!;
    const jobs = [
      ...Array.from({ length: 50 }, (_, index) => ({
        ...healthy,
        id: `healthy-${index}`,
        lastRunStatus: "ok" as const,
      })),
      ...cronPage("later-failure").jobs,
    ];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.list") {
        const pagination = isRecord(params) ? params : {};
        const offset = Number(pagination.offset ?? 0);
        const limit = Number(pagination.limit ?? 50);
        const nextOffset = Math.min(offset + limit, jobs.length);
        return {
          jobs: jobs.slice(offset, nextOffset),
          snapshotRevision: "all-jobs",
          total: jobs.length,
          offset,
          limit,
          hasMore: nextOffset < jobs.length,
          nextOffset: nextOffset < jobs.length ? nextOffset : null,
        };
      }
      return method === "cron.status"
        ? { enabled: true, triggersEnabled: true, jobs: jobs.length }
        : { ts: 1, providers: [] };
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({ selfUser: { id: "alice", name: "Alice" } });
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);

    await waitForFast(() =>
      expect(store?.entries).toMatchObject([
        { type: "attention", kind: "cronFailed", label: "later-failure" },
      ]),
    );
  });

  it.each(["hidden", "disposed"] as const)(
    "does not restart a changed inventory snapshot after becoming %s during append",
    async (boundary) => {
      let visibility: DocumentVisibilityState = "visible";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      const pendingAppend = deferred<CompactCronPage>();
      const offsets: number[] = [];
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "cron.list") {
          const offset = isRecord(params) ? Number(params.offset ?? 0) : 0;
          offsets.push(offset);
          if (offset === 1) {
            return pendingAppend.promise;
          }
          return offsets.length === 1
            ? { ...cronPage("previous"), total: 2, hasMore: true, nextOffset: 1 }
            : cronPage("current");
        }
        return method === "cron.status"
          ? { enabled: true, triggersEnabled: true, jobs: 2 }
          : { ts: 1, providers: [] };
      });
      const harness = createGatewayHarness(mockClient(request));
      harness.update({ selfUser: { id: "alice", name: "Alice" } });
      store = createStore(harness.gateway);
      store.activate(SidebarAttentionStoreController);
      await waitForFast(() => expect(offsets).toEqual([0, 1]));

      if (boundary === "hidden") {
        visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        store.dispose();
      }
      pendingAppend.resolve({ ...cronPage("changed"), total: 2, offset: 1 });
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0);
      });
      expect(offsets).toEqual([0, 1]);

      if (boundary === "hidden") {
        visibility = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
        await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "current" }]));
        expect(offsets).toEqual([0, 1, 0]);
      }
    },
  );

  it.each(["list", "status"] as const)(
    "coalesces cron bursts until the whole inventory pair settles (%s first)",
    async (first) => {
      const pendingList = deferred<CompactCronPage>();
      const pendingStatus = deferred<CronStatus>();
      const pendingAuth = deferred<ModelAuthStatusResult>();
      const cronStatus = { enabled: true, triggersEnabled: true, jobs: 1 };
      let listCalls = 0;
      let statusCalls = 0;
      const request = vi.fn((method: string) => {
        if (method === "cron.list") {
          return ++listCalls === 1 ? pendingList.promise : Promise.resolve(cronPage("latest"));
        }
        if (method === "cron.status") {
          return ++statusCalls === 1 ? pendingStatus.promise : Promise.resolve(cronStatus);
        }
        if (method === "models.authStatus") {
          return pendingAuth.promise;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const harness = createGatewayHarness(mockClient(request));
      harness.update({ selfUser: { id: "alice", name: "Alice" } });
      store = createStore(harness.gateway);
      store.activate(SidebarAttentionStoreController);

      try {
        for (let index = 0; index < 20; index++) {
          harness.emitEvent("cron", {});
        }
        expect(listCalls).toBe(1);
        expect(statusCalls).toBe(1);
        expect(
          request.mock.calls.filter(([method]) => method === "models.authStatus"),
        ).toHaveLength(1);

        if (first === "list") {
          pendingList.resolve(cronPage("stale"));
          await pendingList.promise;
        } else {
          pendingStatus.resolve(cronStatus);
          await pendingStatus.promise;
        }
        await Promise.resolve();
        expect(listCalls).toBe(1);
        expect(statusCalls).toBe(1);

        pendingList.resolve(cronPage("stale"));
        pendingStatus.resolve(cronStatus);
        await waitForFast(() =>
          expect(store?.entries).toMatchObject([
            { type: "attention", kind: "cronFailed", label: "latest" },
          ]),
        );
        expect(listCalls).toBe(2);
        expect(statusCalls).toBe(2);
      } finally {
        store?.dispose();
        store = undefined;
        pendingList.resolve(cronPage());
        pendingStatus.resolve(cronStatus);
        pendingAuth.resolve({ ts: 1, providers: [] });
      }
    },
  );

  it.each(["settled", "pending"] as const)(
    "defers hidden cron inventory and catches up once after a %s visible read",
    async (initial) => {
      let visibility: DocumentVisibilityState = "visible";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      vi.spyOn(Date, "now").mockReturnValue(120_000);
      const pendingList = deferred<CompactCronPage>();
      let listCalls = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "cron.list") {
          listCalls += 1;
          return initial === "pending" && listCalls === 1
            ? pendingList.promise
            : cronPage(listCalls === 1 ? "previous" : "current");
        }
        return method === "cron.status"
          ? { enabled: true, triggersEnabled: true, jobs: 1 }
          : { ts: 120_000, providers: [] };
      });
      const harness = createGatewayHarness(mockClient(request));
      harness.update({ selfUser: { id: "alice", name: "Alice" } });
      store = createStore(harness.gateway);
      store.activate(SidebarAttentionStoreController);
      if (initial === "settled") {
        await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "previous" }]));
      } else {
        // A visible invalidation queued behind the pending pair also retires on hide.
        harness.emitEvent("cron", {});
      }
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 20; index++) {
        harness.emitEvent("cron", {});
      }
      pendingList.resolve(cronPage("previous"));
      await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "previous" }]));
      for (const method of ["cron.list", "cron.status", "models.authStatus"]) {
        expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(1);
      }

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "current" }]));
      for (const method of ["cron.list", "cron.status"]) {
        expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(2);
      }
      expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(
        1,
      );
    },
  );

  it("preserves another tab's dismissal when a hidden event invalidates a pending inventory", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.spyOn(Date, "now").mockReturnValue(120_000);
    const pendingList = deferred<CompactCronPage>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return ++listCalls === 1 ? pendingList.promise : cronPage("newer-job");
      }
      return method === "cron.status"
        ? { enabled: true, triggersEnabled: true, jobs: 1 }
        : { ts: 120_000, providers: [] };
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({ selfUser: { id: "alice", name: "Alice" } });
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    dismissSidebarAttention(resolveSidebarAttentionKey(harness.gateway), {
      kind: "cronFailed",
      signature: "newer-job",
    });
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    // The first invalidation arrives only after hiding, with no visible queued refresh.
    harness.emitEvent("cron", {});
    pendingList.resolve(cronPage("previous"));
    await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "previous" }]));
    expect(listCalls).toBe(1);
    expect(loadDismissals(resolveSidebarAttentionKey(harness.gateway))).toEqual({
      cronFailed: ["newer-job"],
    });

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await waitForFast(() => expect(store?.entries).toEqual([]));
    expect(listCalls).toBe(2);
    expect(loadDismissals(resolveSidebarAttentionKey(harness.gateway))).toEqual({
      cronFailed: ["newer-job"],
    });
  });

  it("publishes progress but retires dismissals only after a fresh complete inventory", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const pages = Array.from({ length: 5 }, () => deferred<CompactCronPage>());
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return pages[listCalls++]!.promise;
      }
      if (method === "cron.status") {
        return { enabled: true, triggersEnabled: true, jobs: 1 };
      }
      return { ts: 1, providers: [] };
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({ selfUser: { id: "alice", name: "Alice" } });
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    pages[0]!.resolve(cronPage("dismissed"));
    await waitForFast(() => expect(store?.entries).toHaveLength(1));
    store.dismiss({ kind: "cronFailed", signature: "dismissed" });

    try {
      harness.emitEvent("cron", {});
      for (const index of [1, 2]) {
        await waitForFast(() => expect(listCalls).toBe(index + 1));
        harness.emitEvent("cron", {});
        pages[index]!.resolve(cronPage(`current-${index}`));
        await waitForFast(() =>
          expect(store?.entries).toMatchObject([{ label: `current-${index}` }]),
        );
        expect(loadDismissals(resolveSidebarAttentionKey(harness.gateway))).toEqual({
          cronFailed: ["dismissed"],
        });
      }
      pages[3]!.resolve({ ...cronPage("partial"), hasMore: true, total: 2, nextOffset: 1 });
      await waitForFast(() => expect(listCalls).toBe(5));
      expect(store?.entries).toMatchObject([{ label: "current-2" }]);
      expect(loadDismissals(resolveSidebarAttentionKey(harness.gateway))).toEqual({
        cronFailed: ["dismissed"],
      });
      pages[4]!.resolve({
        ...cronPage("fresh"),
        snapshotRevision: "partial",
        total: 2,
        offset: 1,
      });
      await waitForFast(() =>
        expect(store?.entries).toMatchObject([{ label: "partial" }, { label: "fresh" }]),
      );
      expect(loadDismissals(resolveSidebarAttentionKey(harness.gateway))).toEqual({});
    } finally {
      store.dispose();
      for (const page of pages) {
        page.resolve(cronPage());
      }
    }
  });

  it("queues auth invalidations while publishing progress during repeated events", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let now = 120_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const auth = Array.from({ length: 3 }, () => deferred<ModelAuthStatusResult>());
    let authCalls = 0;
    const harness = createGatewayHarness(
      mockClient(async (method) => {
        if (method === "cron.list") {
          return cronPage("failed-cron");
        }
        if (method === "cron.status") {
          return { enabled: true, triggersEnabled: true, jobs: 1 };
        }
        return auth[authCalls++]!.promise;
      }),
    );
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    await waitForFast(() => expect(store?.entries).toHaveLength(1));

    try {
      for (const index of [0, 1]) {
        now += 60_001;
        for (let event = 0; event < 20; event++) {
          invalidateModelAuthStatusRequests(harness.gateway.snapshot.client!);
          harness.emitEvent("chat.metadata.changed", {});
        }
        expect(authCalls).toBe(index + 1);
        auth[index]!.resolve({
          ts: now,
          providers: [
            {
              provider: "openai",
              displayName: `Current ${index}`,
              status: "missing",
              profiles: [],
            },
          ],
        });
        await waitForFast(() => expect(authCalls).toBe(index + 2));
        expect(store.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ label: `Current ${index}` })]),
        );
      }
      for (let event = 0; event < 20; event++) {
        harness.emitEvent("cron", {});
      }
      auth[2]!.resolve({ ts: now, providers: [] });
      await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "failed-cron" }]));
      expect(authCalls).toBe(3);
    } finally {
      store.dispose();
      for (const pending of auth) {
        pending.resolve({ ts: now, providers: [] });
      }
    }
  });

  it("keeps auth cached across visibility changes until an auth event", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let now = 120_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let authCalls = 0;
    const harness = createGatewayHarness(
      mockClient(async (method) => {
        if (method === "cron.list") {
          return cronPage(`cron-${now}`);
        }
        if (method === "cron.status") {
          return { enabled: true, triggersEnabled: true, jobs: 1 };
        }
        authCalls += 1;
        return {
          ts: now,
          providers:
            authCalls === 1
              ? [{ provider: "openai", displayName: "OpenAI", status: "missing", profiles: [] }]
              : [],
        };
      }),
    );
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    await waitForFast(() => expect(store?.entries).toHaveLength(2));
    for (let index = 0; index < 2; index++) {
      now += 30_001;
      harness.emitEvent("cron", {});
      await waitForFast(() =>
        expect(store?.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ label: `cron-${now}` })]),
        ),
      );
      expect(authCalls).toBe(1);
    }
    document.dispatchEvent(new Event("visibilitychange"));
    expect(authCalls).toBe(1);
    invalidateModelAuthStatusRequests(harness.gateway.snapshot.client!);
    harness.emitEvent("chat.metadata.changed", {});
    await waitForFast(() => expect(store?.entries).toMatchObject([{ label: `cron-${now}` }]));
    expect(authCalls).toBe(2);
  });

  it.each([
    { name: "request failure", row: undefined },
    { name: "missing identity", row: { id: undefined } },
    { name: "missing runtime status", row: { lastRunStatus: undefined } },
    { name: "invalid active run", row: { runningAtMs: "0" } },
    { name: "invalid scheduler disablement", row: { autoDisabled: {} } },
  ])("preserves loaded attention and dismissals after $name", async ({ row }) => {
    vi.stubGlobal("localStorage", createStorageMock());
    const page = cronPage("overdue");
    Object.assign(page.jobs[0]!, { lastRunStatus: "ok", nextRunAtMs: 1 });
    let failing = false;
    const request = vi.fn(async (method: string) => {
      if (failing && method === "cron.list") {
        if (row) {
          return { ...page, jobs: [{ ...page.jobs[0], ...row }] };
        }
        throw new Error("temporarily unavailable");
      }
      if (method === "cron.list") {
        return page;
      }
      if (method === "cron.status") {
        return { enabled: true, triggersEnabled: true, jobs: 1 };
      }
      return { ts: 1, providers: [] };
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({ selfUser: { id: "alice", name: "Alice" } });
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    await waitForFast(() => expect(store?.entries).toHaveLength(1));

    failing = true;
    harness.emitEvent("cron", {});
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(store.entries).toMatchObject([{ label: "overdue" }]);
    store.dismiss({ kind: "cronOverdue", signature: "overdue@1" });
    harness.emitEvent("cron", {});
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(loadDismissals(resolveSidebarAttentionKey(harness.gateway))).toEqual({
      cronOverdue: ["overdue@1"],
    });

    failing = false;
    harness.emitEvent("cron", {});
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(store.entries).toEqual([]);
  });

  it("preserves disabled scheduler attention when cron.status fails", async () => {
    const page = cronPage("overdue");
    Object.assign(page.jobs[0]!, { lastRunStatus: "ok", nextRunAtMs: 1 });
    let failing = false;
    const request = vi.fn(async (method: string) => {
      if (method === "cron.status") {
        if (failing) {
          throw new Error("temporarily unavailable");
        }
        return { enabled: false, triggersEnabled: true, jobs: 1 };
      }
      return method === "cron.list" ? page : { ts: 1, providers: [] };
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({ selfUser: { id: "alice", name: "Alice" } });
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(store.entries).toEqual([]);

    failing = true;
    harness.emitEvent("cron", {});
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    expect(store.entries).toEqual([]);
  });

  it.each(["disconnect", "replace", "dispose"] as const)(
    "retires queued inventory and auth refreshes on %s",
    async (boundary) => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const pendingList = deferred<CompactCronPage>();
      const pendingStatus = deferred<CronStatus>();
      const pendingAuth = deferred<ModelAuthStatusResult>();
      const cronStatus = { enabled: true, triggersEnabled: true, jobs: 1 };
      const request = vi.fn((method: string) => {
        if (method === "cron.list") {
          return pendingList.promise;
        }
        if (method === "cron.status") {
          return pendingStatus.promise;
        }
        if (method === "models.authStatus") {
          return pendingAuth.promise;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const harness = createGatewayHarness(mockClient(request));
      harness.update({ selfUser: { id: "alice", name: "Alice" } });
      store = createStore(harness.gateway);
      const publish = vi.fn();
      store.subscribe(publish);
      store.activate(SidebarAttentionStoreController);
      harness.emitEvent("cron", {});
      document.dispatchEvent(new Event("visibilitychange"));

      try {
        if (boundary === "disconnect") {
          harness.update({ phase: "reconnecting" });
        } else if (boundary === "replace") {
          harness.update({
            client: mockClient(async (method) =>
              method === "cron.list"
                ? cronPage("replacement")
                : method === "cron.status"
                  ? cronStatus
                  : { ts: 1, providers: [] },
            ),
          });
          await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "replacement" }]));
        } else {
          store.dispose();
        }
        publish.mockClear();
        pendingList.resolve(cronPage("retired"));
        pendingStatus.resolve(cronStatus);
        pendingAuth.resolve({ ts: 1, providers: [] });
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 0);
        });

        expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(1);
        expect(request.mock.calls.filter(([method]) => method === "cron.status")).toHaveLength(1);
        expect(
          request.mock.calls.filter(([method]) => method === "models.authStatus"),
        ).toHaveLength(1);
        expect(publish).not.toHaveBeenCalled();
      } finally {
        pendingList.resolve(cronPage());
        pendingStatus.resolve(cronStatus);
        pendingAuth.resolve({ ts: 1, providers: [] });
      }
    },
  );

  it("publishes cron attention while model auth is still pending", async () => {
    let resolveModelAuth!: (status: ModelAuthStatusResult) => void;
    const modelAuth = new Promise<ModelAuthStatusResult>((resolve) => {
      resolveModelAuth = resolve;
    });
    const request = vi.fn((method: string) => {
      if (method === "cron.list") {
        return Promise.resolve(cronPage("failed-cron"));
      }
      if (method === "cron.status") {
        return Promise.resolve({ enabled: true, triggersEnabled: true, jobs: 1 });
      }
      if (method === "models.authStatus") {
        return modelAuth;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const gateway = createGatewayHarness(mockClient(request)).gateway;
    store = createStore(gateway);
    const publishedCounts: number[] = [];
    store.subscribe(() => publishedCounts.push(store?.entries.length ?? 0));
    store.activate(SidebarAttentionStoreController);

    try {
      await waitForFast(() => expect(publishedCounts).toContain(1));
    } finally {
      resolveModelAuth({ ts: 1, providers: [] });
    }
  });

  it("creates one mention owner on activation, retains it without listeners, and disposes it", async () => {
    const mention: MentionInboxItem = {
      id: "mention-first",
      senderProfileId: "alice",
      senderLabel: "Alice",
      sessionKey: "agent:writer:review",
      agentId: "writer",
      sessionTitle: "Review",
      messageId: "message-first",
      createdAt: 1_000,
      expiresAt: 10_000,
    };
    let result = { gatewayInstanceId: "boot-a", revision: 1, items: [mention] };
    const responses: Record<string, unknown> = {
      "cron.list": {
        jobs: [],
        snapshotRevision: "lifecycle",
        total: 0,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: null,
      },
      "cron.status": { enabled: true, triggersEnabled: true, jobs: 0 },
      "models.authStatus": { ts: 1, providers: [] },
    };
    const request = vi.fn(async (method: string) => {
      if (method === "mentions.list") {
        return result;
      }
      if (method in responses) {
        return responses[method];
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({ selfUser: { id: "alice", name: "Alice" } });
    harness.update({
      hello: {
        type: "hello-ok",
        protocol: 1,
        server: { bootId: "boot-a", connId: "connection-a" },
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["mentions.list", "mentions.dismiss"] },
      },
      selfUser: { id: "bob", identity: { type: "profile", id: "bob" }, name: "Bob" },
    });
    store = createStore(harness.gateway);
    expect(request).not.toHaveBeenCalled();
    const publish = vi.fn();
    const stop = store.subscribe(publish);
    const mentions = store.activate(SidebarAttentionStoreController);
    expect(store.activate(SidebarAttentionStoreController)).toBe(mentions);
    await waitForFast(() => expect(mentions.snapshot.items).toEqual([mention]));
    expect(request.mock.calls.filter(([method]) => method === "mentions.list")).toHaveLength(1);

    stop();
    publish.mockClear();
    result = { ...result, revision: 2, items: [{ ...mention, id: "mention-second" }] };
    harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 2 });
    await waitForFast(() =>
      expect(store?.entries.filter((entry) => entry.type === "mention")).toMatchObject([
        { mention: { id: "mention-second" } },
      ]),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(store.activate(SidebarAttentionStoreController)).toBe(mentions);

    store.dispose();
    store = undefined;
    request.mockClear();
    harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 3 });
    await mentions.refresh();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps only nondismissable local incidents available offline and observes canonical removal", async () => {
    const { sidebarInboxTabCounts } = await import("./sidebar-attention-entries.ts");
    vi.stubGlobal("sessionStorage", createStorageMock());
    const request = vi.fn(async (method: string) =>
      method === "cron.list"
        ? cronPage("failed-job")
        : method === "cron.status"
          ? { enabled: true, jobs: 1 }
          : { ts: 1, providers: [] },
    );
    const client = mockClient(request);
    Object.defineProperties(client, {
      recoveryScope: { value: "owner-a" },
      recoveryScopeReady: { value: true },
    });
    const harness = createGatewayHarness(client);
    const host = {
      client,
      connected: true,
      settings: harness.gateway.connection,
      sessionKey: "agent:main:review",
    };
    const row = {
      id: "local-review",
      text: "private submission",
      createdAt: 1,
      sendState: "unconfirmed" as const,
      sendRunId: "run-review",
    };
    expect(
      admitStoredChatComposerQueueItem(
        host,
        captureChatOutboxAdmission(host, host.sessionKey),
        row,
      ),
    ).toBe(true);
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    await waitForFast(() =>
      expect(store?.entries.map((entry) => entry.type)).toEqual(["outbox", "attention"]),
    );
    expect(sidebarInboxTabCounts(store.entries)).toMatchObject({
      all: 2,
      system: 1,
      automations: 1,
    });
    expect(store.entries[0]?.dismissal).toBeNull();
    expect(JSON.stringify(store.entries[0])).not.toContain("private submission");
    harness.update({ phase: "reconnecting", hello: null });
    const calls = request.mock.calls.length;
    expect(store.entries.map((entry) => entry.type)).toEqual(["outbox"]);
    expect(sidebarInboxTabCounts(store.entries)).toMatchObject({
      all: 1,
      system: 1,
      automations: 0,
    });
    expect(removeStoredChatComposerQueueItem(host, host.sessionKey, row.id, row)).toBe(true);
    expect(store.entries).toEqual([]);
    expect(request.mock.calls).toHaveLength(calls);
  });
});
