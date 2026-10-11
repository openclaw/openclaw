/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { CronStatus, ModelAuthStatusResult } from "../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import type { SidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import { outboxStorageScope } from "../lib/chat/outbox-payload-store.runtime.ts";
import { captureChatOutboxAdmission } from "../lib/chat/outbox-store.ts";
import { invalidateModelAuthStatusRequests } from "../lib/model-auth-request-state.ts";
import {
  admitStoredChatComposerQueueItem,
  removeStoredChatComposerQueueItem,
} from "../pages/chat/composer-persistence.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  dismissSidebarAttention,
  loadDismissals,
  resolveSidebarAttentionKey,
} from "./sidebar-attention-dismissals.ts";
import {
  createStore,
  cronPage,
  type CompactCronPage,
} from "./sidebar-attention-store.test-support.ts";
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";

describe("sidebar attention source publication", () => {
  let store: SidebarAttentionStore | undefined;

  function inventoryRequest(
    list: (params?: unknown) => unknown,
    jobs = 1,
    auth: () => unknown = () => ({ ts: 1, providers: [] }),
  ) {
    return vi.fn(async (method: string, params?: unknown) =>
      method === "cron.list"
        ? list(params)
        : method === "cron.status"
          ? { enabled: true, triggersEnabled: true, jobs }
          : auth(),
    );
  }

  function startAuthenticatedStore(request: Parameters<typeof mockClient>[0]) {
    const harness = createGatewayHarness(mockClient(request));
    harness.update({ selfUser: { id: "alice", name: "Alice" } });
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreController);
    return { ...harness, attention: store };
  }

  function settleRefresh() {
    return new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
  }

  afterEach(() => {
    store?.dispose();
    store = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([{ restartPending: true }, { suspensionPhase: "draining" as const }])(
    "retains attention while pausing retries and events during %j",
    async (unavailable) => {
      vi.useFakeTimers();
      let failed = false;
      const request = inventoryRequest(() => {
        if (failed) {
          throw new Error("temporarily unavailable");
        }
        return cronPage("incident");
      });
      const harness = startAuthenticatedStore(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.attention.entries).toMatchObject([{ label: "incident" }]);

      failed = true;
      harness.emitEvent("cron", {});
      await vi.advanceTimersByTimeAsync(0);
      request.mockClear();
      harness.update(unavailable);
      harness.emitEvent("cron", {});
      harness.emitEvent("config.changed", {});
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(request).not.toHaveBeenCalled();
      expect(harness.attention.entries).toMatchObject([{ label: "incident" }]);

      failed = false;
      harness.update({ restartPending: false, suspensionPhase: "accepting" });
      await vi.advanceTimersByTimeAsync(0);
      for (const method of ["cron.list", "cron.status"]) {
        expect(request.mock.calls.filter(([name]) => name === method)).toHaveLength(1);
      }
      expect(harness.attention.entries).toMatchObject([{ label: "incident" }]);
    },
  );

  it.each(["cron.list", "cron.status"])(
    "keeps cron inventory after recovering %s, visibility, and idle time",
    async (failedMethod) => {
      vi.useFakeTimers();
      let visibility: DocumentVisibilityState = "visible";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      let failuresRemaining = 2;
      const request = vi.fn(async (method: string) => {
        if (method === failedMethod && failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("temporarily unavailable");
        }
        return method === "cron.list"
          ? cronPage("incident")
          : method === "cron.status"
            ? { enabled: true, triggersEnabled: true, jobs: 1 }
            : { ts: Date.now(), providers: [] };
      });
      const harness = createGatewayHarness(mockClient(request));
      store = createStore(harness.gateway);
      store.activate(SidebarAttentionStoreController);
      await vi.advanceTimersByTimeAsync(0);
      const cronCalls = () => request.mock.calls.filter(([name]) => name === "cron.list").length;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(cronCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(cronCalls()).toBe(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(cronCalls()).toBe(3);
      expect(store.entries).toMatchObject([{ label: "incident" }]);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(60_001);
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      for (const method of ["cron.list", "cron.status", "models.authStatus"]) {
        expect(
          request.mock.calls.filter(([name]) => name === method),
          method,
        ).toHaveLength(method === "models.authStatus" ? 1 : 3);
      }
      harness.emitEvent("config.changed", {});
      await vi.advanceTimersByTimeAsync(0);
      for (const method of ["cron.list", "cron.status"]) {
        expect(
          request.mock.calls.filter(([name]) => name === method),
          method,
        ).toHaveLength(4);
      }
      harness.update({ phase: "reconnecting" });
      harness.update({ phase: "connected" });
      await vi.advanceTimersByTimeAsync(0);
      for (const method of ["cron.list", "cron.status"]) {
        expect(
          request.mock.calls.filter(([name]) => name === method),
          method,
        ).toHaveLength(5);
      }
    },
  );

  it.each(["account", "reconnect", "tenant"] as const)(
    "keeps snoozes isolated across %s switches and reloads",
    async (boundary) => {
      vi.stubGlobal("localStorage", createStorageMock());
      const jobs = [...cronPage("dismissed-incident").jobs, ...cronPage("visible-incident").jobs];
      const request = inventoryRequest(
        () => ({ ...cronPage(), jobs, total: jobs.length }),
        jobs.length,
      );
      const harness = createGatewayHarness(mockClient(request));
      const profile = (id: string) => ({
        id,
        identity: { type: "profile" as const, id },
        name: id,
      });
      const connect = (id: string) => {
        if (boundary === "tenant") {
          harness.update({ phase: "reconnecting", selfUser: null });
          harness.gateway.connection.gatewayUrl = `wss://gateway.test/path?tenant=${id}`;
          harness.gateway.connectionRevision += 1;
        }
        harness.update({
          phase: "connected",
          selfUser: profile(boundary === "tenant" ? "alice" : id),
        });
      };
      connect("alice");
      store = createStore(harness.gateway);
      store.activate(SidebarAttentionStoreController);
      await waitForFast(() => expect(store?.entries).toHaveLength(2));
      store.dismiss({ kind: "cronFailed", signature: "dismissed-incident" });
      expect(store.entries).toMatchObject([{ label: "visible-incident" }]);
      if (boundary === "reconnect") {
        harness.update({ phase: "reconnecting", selfUser: null });
        store.dismiss({ kind: "cronFailed", signature: "visible-incident" });
      }
      connect("bob");
      await waitForFast(() => expect(store?.entries).toHaveLength(2));
      store.dispose();
      store = createStore(harness.gateway);
      store.activate(SidebarAttentionStoreController);
      await waitForFast(() => expect(store?.entries).toHaveLength(2));
      const dismissal = { kind: "cronFailed" as const, signature: "visible-incident" };
      if (boundary === "tenant") {
        store.dismiss(dismissal);
      } else {
        const key = resolveSidebarAttentionKey(harness.gateway);
        if (!key) {
          throw new Error("expected authenticated storage scope");
        }
        dismissSidebarAttention(key, dismissal);
        globalThis.dispatchEvent(new StorageEvent("storage", { key }));
      }
      expect(store.entries).toMatchObject([{ label: "dismissed-incident" }]);
      connect("alice");
      await waitForFast(() =>
        expect(store?.entries).toMatchObject([{ label: "visible-incident" }]),
      );
    },
  );

  it("retires old-account health before the eager facade publishes a storage refresh", async () => {
    let profile = "alice";
    const request = inventoryRequest(() => cronPage(profile));
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
      const request = inventoryRequest((params) => {
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
      }, 2);
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
          expect(store?.entries).toMatchObject([
            { type: "attention", kind: "cronFailed", label: "first" },
            { type: "attention", kind: "cronFailed", label: "later" },
          ]);
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

  it.each(["hidden", "disposed"] as const)(
    "does not restart a changed inventory snapshot after becoming %s during append",
    async (boundary) => {
      let visibility: DocumentVisibilityState = "visible";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      const pendingAppend = deferred<CompactCronPage>();
      const offsets: number[] = [];
      const request = inventoryRequest((params) => {
        const offset = isRecord(params) ? Number(params.offset ?? 0) : 0;
        offsets.push(offset);
        if (offset === 1) {
          return pendingAppend.promise;
        }
        return offsets.length === 1
          ? { ...cronPage("previous"), total: 2, hasMore: true, nextOffset: 1 }
          : cronPage("current");
      }, 2);
      const { attention } = startAuthenticatedStore(request);
      await waitForFast(() => expect(offsets).toEqual([0, 1]));

      if (boundary === "hidden") {
        visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        attention.dispose();
      }
      pendingAppend.resolve({ ...cronPage("changed"), total: 2, offset: 1 });
      await settleRefresh();
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

  it.each(["settled", "pending", "pending with dismissal"] as const)(
    "defers hidden inventory, preserving dismissals and catching up once (%s)",
    async (initial) => {
      vi.stubGlobal("localStorage", createStorageMock());
      let visibility: DocumentVisibilityState = "visible";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      vi.spyOn(Date, "now").mockReturnValue(120_000);
      const pendingList = deferred<CompactCronPage>();
      let listCalls = 0;
      const request = inventoryRequest(
        () => {
          listCalls += 1;
          return initial !== "settled" && listCalls === 1
            ? pendingList.promise
            : cronPage(listCalls === 1 ? "previous" : "current");
        },
        1,
        () => ({ ts: 120_000, providers: [] }),
      );
      const harness = startAuthenticatedStore(request);
      const key = resolveSidebarAttentionKey(harness.gateway);
      if (initial === "settled") {
        await waitForFast(() => expect(store?.entries).toMatchObject([{ label: "previous" }]));
      } else if (initial === "pending") {
        harness.emitEvent("cron", {});
      } else {
        dismissSidebarAttention(key, { kind: "cronFailed", signature: "current" });
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
      if (initial === "pending with dismissal") {
        expect(loadDismissals(key)).toEqual({ cronFailed: ["current"] });
      }
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      await waitForFast(() => {
        if (initial === "pending with dismissal") {
          expect(store?.entries).toEqual([]);
        } else {
          expect(store?.entries).toMatchObject([{ label: "current" }]);
        }
      });
      for (const method of ["cron.list", "cron.status"]) {
        expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(2);
      }
      expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(
        1,
      );
      if (initial === "pending with dismissal") {
        expect(loadDismissals(key)).toEqual({ cronFailed: ["current"] });
      }
    },
  );

  it("publishes progress but retires dismissals only after a fresh complete inventory", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const pages = Array.from({ length: 5 }, () => deferred<CompactCronPage>());
    let listCalls = 0;
    const request = inventoryRequest(() => pages[listCalls++]!.promise);
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
      mockClient(
        inventoryRequest(
          () => cronPage("failed-cron"),
          1,
          () => auth[authCalls++]!.promise,
        ),
      ),
    );
    store = createStore(harness.gateway);
    const publishedCounts: number[] = [];
    store.subscribe(() => publishedCounts.push(store?.entries.length ?? 0));
    store.activate(SidebarAttentionStoreController);
    await waitForFast(() => expect(store?.entries).toHaveLength(1));
    expect(publishedCounts).toContain(1);

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
      mockClient(
        inventoryRequest(
          () => cronPage(`cron-${now}`),
          1,
          () => ({
            ts: now,
            providers:
              ++authCalls === 1
                ? [{ provider: "openai", displayName: "OpenAI", status: "missing", profiles: [] }]
                : [],
          }),
        ),
      ),
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
    harness.emitEvent("chat.metadata.changed", {
      agentId: "main",
      usageUpdatedAt: now,
      modelCatalogChanged: false,
      authChanged: false,
    });
    await Promise.resolve();
    expect(authCalls).toBe(1);
    harness.emitEvent("chat.metadata.changed", {});
    await waitForFast(() => expect(store?.entries).toMatchObject([{ label: `cron-${now}` }]));
    expect(authCalls).toBe(2);
  });

  it.each<{ name: string; row?: Record<string, unknown>; disabled?: boolean }>([
    { name: "request failure" },
    { name: "missing identity", row: { id: undefined } },
    { name: "missing runtime status", row: { lastRunStatus: undefined } },
    { name: "invalid active run", row: { runningAtMs: "0" } },
    { name: "invalid scheduler disablement", row: { autoDisabled: {} } },
    { name: "disabled scheduler status failure", disabled: true },
  ])("preserves loaded attention and dismissals after $name", async ({ row, disabled }) => {
    vi.stubGlobal("localStorage", createStorageMock());
    const page = cronPage("overdue");
    Object.assign(page.jobs[0]!, { lastRunStatus: "ok", nextRunAtMs: 1 });
    let failing = false;
    const request = vi.fn(async (method: string) => {
      if (failing && method === (disabled ? "cron.status" : "cron.list")) {
        if (row) {
          return { ...page, jobs: [{ ...page.jobs[0], ...row }] };
        }
        throw new Error("temporarily unavailable");
      }
      if (method === "cron.list") {
        return page;
      }
      return method === "cron.status"
        ? { enabled: !disabled, triggersEnabled: true, jobs: 1 }
        : { ts: 1, providers: [] };
    });
    const harness = startAuthenticatedStore(request);
    if (disabled) {
      await settleRefresh();
      expect(store?.entries).toEqual([]);
    } else {
      await waitForFast(() => expect(store?.entries).toHaveLength(1));
    }
    failing = true;
    harness.emitEvent("cron", {});
    await settleRefresh();
    if (disabled) {
      expect(store?.entries).toEqual([]);
      return;
    }
    expect(store?.entries).toMatchObject([{ label: "overdue" }]);
    harness.attention.dismiss({ kind: "cronOverdue", signature: "overdue@1" });
    harness.emitEvent("cron", {});
    await settleRefresh();
    expect(loadDismissals(resolveSidebarAttentionKey(harness.gateway))).toEqual({
      cronOverdue: ["overdue@1"],
    });
    failing = false;
    harness.emitEvent("cron", {});
    await settleRefresh();
    expect(store?.entries).toEqual([]);
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
        await settleRefresh();

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

  it("clears reviewed local incidents offline without deleting their drafts", async () => {
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
      storageScope: outboxStorageScope(host),
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
    const dismissal = store.entries[0]?.dismissal;
    expect(dismissal?.kind).toBe("outbox");
    expect(JSON.stringify(store.entries[0])).not.toContain("private submission");
    harness.update({ phase: "reconnecting", hello: null });
    const calls = request.mock.calls.length;
    expect(store.entries.map((entry) => entry.type)).toEqual(["outbox"]);
    expect(sidebarInboxTabCounts(store.entries)).toMatchObject({
      all: 1,
      system: 1,
      automations: 0,
    });
    store.dismiss(dismissal!);
    expect(store.entries).toEqual([]);
    expect(request.mock.calls).toHaveLength(calls);
    harness.update({ phase: "connected" });
    expect(store.entries.some((entry) => entry.type === "outbox")).toBe(false);
    expect(removeStoredChatComposerQueueItem(host, host.sessionKey, row.id, row)).toBe(true);
    expect(store.entries).toEqual([]);
  });
});
