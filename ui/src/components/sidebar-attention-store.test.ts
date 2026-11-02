/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { CronStatus, ModelAuthStatusResult } from "../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import type { ApplicationContext } from "../app/context.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import type { SidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import { outboxStorageScope } from "../lib/chat/outbox-payload-store.runtime.ts";
import { captureChatOutboxAdmission } from "../lib/chat/outbox-store.ts";
import { invalidateModelAuthStatusRequests } from "../lib/model-auth-request-state.ts";
import {
  admitStoredChatComposerQueueItemResult,
  updateStoredChatComposerQueueItems,
} from "../pages/chat/composer-queue-persistence.ts";
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
  eventJob,
  inventoryRequest,
  startAuthenticatedStore,
  type CompactCronPage,
} from "./sidebar-attention-store.test-support.ts";
import { SidebarAttentionStoreOwner } from "./sidebar-attention-store.ts";
import { inboxMention } from "./sidebar-inbox.test-support.ts";

describe("sidebar attention source publication", () => {
  let store: SidebarAttentionStore | undefined;
  const pendingCleanup: (() => void)[] = [];
  const emptyAuth = (ts = 1): ModelAuthStatusResult => ({ ts, providers: [] });
  const missingAuth = (ts: number, displayName = "OpenAI"): ModelAuthStatusResult => ({
    ts,
    providers: [{ provider: "openai", displayName, status: "missing", profiles: [] }],
  });
  function pending<T>(fallback: T) {
    const result = deferred<T>();
    pendingCleanup.push(() => result.resolve(fallback));
    return result;
  }
  function gateway(request: Parameters<typeof mockClient>[0], authenticated = false) {
    const harness = createGatewayHarness(mockClient(request));
    if (authenticated) {
      harness.update({ selfUser: { id: "alice", name: "Alice" } });
    }
    return harness;
  }
  const modelAuthRequests = (request: ReturnType<typeof inventoryRequest>) =>
    request.mock.calls.filter(([name]) => name === "models.authStatus");
  const dismissalState = (harness: ReturnType<typeof createGatewayHarness>) =>
    loadDismissals(resolveSidebarAttentionKey(harness.gateway));
  function containsLabel(label: string) {
    expect(store?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ label })]));
  }

  function activate(harness: ReturnType<typeof createGatewayHarness>) {
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreOwner);
    return store;
  }
  function expectLabels(...labels: string[]) {
    expect(store?.entries).toMatchObject(labels.map((label) => ({ label })));
  }
  const waitLabels = (...labels: string[]) => waitForFast(() => expectLabels(...labels));
  function visibilityControl() {
    let state: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    return (next: DocumentVisibilityState, notify = true) => {
      state = next;
      if (notify) {
        document.dispatchEvent(new Event("visibilitychange"));
      }
    };
  }
  function expectCalls(
    request: ReturnType<typeof inventoryRequest>,
    count: number,
    methods = ["cron.list", "cron.status"],
  ) {
    for (const method of methods) {
      const calls = request.mock.calls.filter(([name]) => name === method);
      expect(calls, method).toHaveLength(count);
    }
  }
  function inventoryGate(next?: string) {
    const cronStatus = { enabled: true, triggersEnabled: true, jobs: 1 };
    const list = pending(cronPage());
    const status = pending<CronStatus>(cronStatus);
    const auth = pending(emptyAuth());
    let listCalls = 0;
    const request = respond({
      "cron.list": () => (++listCalls === 1 || !next ? list.promise : cronPage(next)),
      "cron.status": () => status.promise,
      "models.authStatus": () => auth.promise,
    });
    return {
      list,
      status,
      cronStatus,
      request,
      finish(id?: string) {
        list.resolve(cronPage(id));
        status.resolve(cronStatus);
        auth.resolve(emptyAuth());
      },
    };
  }
  function emitFinished(harness: ReturnType<typeof createGatewayHarness>) {
    harness.emitEvent("cron", {
      action: "finished",
      jobId: "current",
      job: eventJob({ id: "current" }),
    });
  }
  function repeatEvent(emit: () => void) {
    for (let index = 0; index < 20; index++) {
      emit();
    }
  }
  function settleRefresh() {
    return new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
  }
  function respond(responses: Record<string, (params?: unknown) => unknown>) {
    return vi.fn(async (method: string, params?: unknown) => {
      const response = responses[method];
      if (!response) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return response(params);
    });
  }

  afterEach(async () => {
    store?.dispose();
    store = undefined;
    pendingCleanup.splice(0).forEach((cleanup) => cleanup());
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0);
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps health attention across a same-client blip but clears it for another identity", async () => {
    vi.useFakeTimers();
    const refreshed = deferred<CompactCronPage>();
    let reads = 0;
    const harness = startAuthenticatedStore(
      inventoryRequest(() => (++reads === 1 ? cronPage("retained") : refreshed.promise)),
    );
    store = harness.attention;
    await vi.advanceTimersByTimeAsync(0);
    expect(store.entries).toMatchObject([{ label: "retained" }]);
    const { hello, selfUser } = harness.gateway.snapshot;
    harness.update({ phase: "reconnecting", hello: null, selfUser: undefined });
    expect(store.entries).toMatchObject([{ label: "retained" }]);
    harness.update({ phase: "connected", hello });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.entries).toMatchObject([{ label: "retained" }]);
    expect(reads).toBe(1);
    harness.update({ selfUser });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.entries).toMatchObject([{ label: "retained" }]);
    expect(reads).toBe(2);
    refreshed.resolve(cronPage("refreshed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.entries).toMatchObject([{ label: "refreshed" }]);
    harness.update({ phase: "reconnecting", client: mockClient(async () => ({})) });
    expect(store.entries).toEqual([]);
  });

  it("retains cron inventory without reviving stale auth when returning to an agent", async () => {
    vi.useFakeTimers();
    const inventory = pending(cronPage("incident"));
    const oldAuth = pending(emptyAuth(2));
    const writerAuth = pending(emptyAuth(2));
    const currentAuth = pending(emptyAuth(2));
    let mainAuthCalls = 0;
    const request = respond({
      "cron.list": () => inventory.promise,
      "cron.status": () => ({ enabled: true, jobs: 1 }),
      "models.authStatus": (params) =>
        isRecord(params) && params.agentId === "main"
          ? (++mainAuthCalls === 1 ? oldAuth : currentAuth).promise
          : writerAuth.promise,
    });
    const harness = gateway(request);
    let selectionListener = () => {};
    const selection = {
      state: { selectedId: "main", scopeId: null },
      subscribe: (listener: () => void) => {
        selectionListener = listener;
        return () => {};
      },
    } as unknown as ApplicationContext["agentSelection"];
    store = createStore(harness.gateway, undefined, selection);
    store.activate(SidebarAttentionStoreOwner);
    selection.state.selectedId = "writer";
    selectionListener();
    selectionListener();
    harness.update({});
    await vi.advanceTimersByTimeAsync(0);

    invalidateModelAuthStatusRequests(harness.gateway.snapshot.client!);
    harness.emitEvent("chat.metadata.changed", { authChanged: true });
    selection.state.selectedId = "main";
    selectionListener();
    inventory.resolve(cronPage("incident"));
    currentAuth.resolve(emptyAuth(2));
    await vi.advanceTimersByTimeAsync(0);
    expectLabels("incident");
    expect(mainAuthCalls).toBe(2);

    oldAuth.resolve(missingAuth(1));
    await vi.advanceTimersByTimeAsync(0);
    expectLabels("incident");
    expectCalls(request, 1);
    expect(modelAuthRequests(request)).toEqual([
      ["models.authStatus", { agentId: "main" }],
      ["models.authStatus", { agentId: "writer" }],
      ["models.authStatus", { agentId: "main" }],
    ]);
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
      store = harness.attention;
      await vi.advanceTimersByTimeAsync(0);
      expectLabels("incident");

      failed = true;
      harness.emitEvent("cron", {});
      await vi.advanceTimersByTimeAsync(0);
      request.mockClear();
      harness.update(unavailable);
      harness.emitEvent("cron", {});
      harness.emitEvent("config.changed", {});
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(request).not.toHaveBeenCalled();
      expectLabels("incident");

      failed = false;
      harness.update({ restartPending: false, suspensionPhase: "accepting" });
      await vi.advanceTimersByTimeAsync(0);
      expectCalls(request, 1);
      expectLabels("incident");
    },
  );

  it.each(["cron.list", "cron.status"])(
    "keeps cron inventory after recovering %s, visibility, and idle time",
    async (failedMethod) => {
      vi.useFakeTimers();
      const setVisibility = visibilityControl();
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
            : emptyAuth(Date.now());
      });
      const harness = gateway(request);
      store = activate(harness);
      await vi.advanceTimersByTimeAsync(0);
      const cronCalls = () => request.mock.calls.filter(([name]) => name === "cron.list").length;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(cronCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(cronCalls()).toBe(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(cronCalls()).toBe(3);
      expectLabels("incident");
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(60_001);
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
      expectCalls(request, 3);
      expect(modelAuthRequests(request)).toHaveLength(1);
      harness.emitEvent("config.changed", {});
      await vi.advanceTimersByTimeAsync(0);
      expectCalls(request, 4);
      harness.update({ phase: "reconnecting" });
      harness.update({ phase: "connected" });
      await vi.advanceTimersByTimeAsync(0);
      expectCalls(request, 5);
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
      const harness = gateway(request);
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
      store = activate(harness);
      await waitForFast(() => expect(store?.entries).toHaveLength(2));
      store.dismiss({ kind: "cronFailed", signature: "dismissed-incident" });
      expectLabels("visible-incident");
      if (boundary === "reconnect") {
        harness.update({ phase: "reconnecting", selfUser: null });
        store.dismiss({ kind: "cronFailed", signature: "visible-incident" });
        expect(store.entries).toEqual([]);
      }
      connect("bob");
      await waitForFast(() => expect(store?.entries).toHaveLength(2));
      store.dispose();
      store = activate(harness);
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
      expectLabels("dismissed-incident");
      connect("alice");
      await waitLabels(...(boundary === "reconnect" ? [] : ["visible-incident"]));
    },
  );

  it("retires old-account health before the eager facade publishes a storage refresh", async () => {
    let profile = "alice";
    const request = inventoryRequest(() => cronPage(profile));
    const harness = gateway(request);
    harness.update({ selfUser: { id: profile, name: profile } });
    store = activate(harness);
    await waitLabels("alice");
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
    await waitLabels("bob");
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
    const harness = gateway(async () => ({}));
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
      const setVisibility = visibilityControl();
      const bootstrap = createConnectionBootstrapCoordinator();
      pendingCleanup.push(() => bootstrap.reset());
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
      store.activate(SidebarAttentionStoreOwner);
      expect(request.mock.calls.filter(([method]) => method.startsWith("cron."))).toEqual([]);
      if (boundary === "hidden") {
        setVisibility("hidden", false);
      } else if (boundary === "disposed") {
        store.dispose();
      }
      bootstrap.setForegroundPane({}, { sessionKey: "agent:main:current", client, ready: true });
      if (boundary === "ready") {
        await waitForFast(() => expect(offsets).toEqual([0, 1]));
        await waitLabels("first", "later");
      } else {
        await Promise.resolve();
        expect(offsets).toEqual([]);
        expect(request.mock.calls.filter(([method]) => method === "cron.status")).toEqual([]);
      }
    },
  );

  it.each(["hidden", "disposed"] as const)(
    "does not restart a changed inventory snapshot after becoming %s during append",
    async (boundary) => {
      const setVisibility = visibilityControl();
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
      store = attention;
      await waitForFast(() => expect(offsets).toEqual([0, 1]));

      if (boundary === "hidden") {
        setVisibility("hidden");
      } else {
        attention.dispose();
      }
      pendingAppend.resolve({ ...cronPage("changed"), total: 2, offset: 1 });
      await settleRefresh();
      expect(offsets).toEqual([0, 1]);

      if (boundary === "hidden") {
        setVisibility("visible");
        await waitLabels("current");
        expect(offsets).toEqual([0, 1, 0]);
      }
    },
  );

  it.each(["list", "status"] as const)(
    "coalesces cron bursts until the whole inventory pair settles (%s first)",
    async (first) => {
      const gate = inventoryGate("latest");
      const { request, cronStatus } = gate;
      const harness = gateway(request, true);
      store = activate(harness);

      repeatEvent(() => emitFinished(harness));
      expectCalls(request, 1);
      expectCalls(request, 1, ["models.authStatus"]);

      if (first === "list") {
        gate.list.resolve(cronPage("stale"));
        await gate.list.promise;
      } else {
        gate.status.resolve(cronStatus);
        await gate.status.promise;
      }
      await Promise.resolve();
      expectCalls(request, 1);

      gate.list.resolve(cronPage("stale"));
      gate.status.resolve(cronStatus);
      await waitLabels("latest");
      expectCalls(request, 2);
    },
  );

  it.each(["settled", "pending with dismissal"] as const)(
    "defers hidden inventory, preserving dismissals and catching up once (%s)",
    async (initial) => {
      vi.stubGlobal("localStorage", createStorageMock());
      const setVisibility = visibilityControl();
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
      store = harness.attention;
      const key = resolveSidebarAttentionKey(harness.gateway);
      if (initial === "settled") {
        await waitLabels("previous");
      } else {
        dismissSidebarAttention(key, { kind: "cronFailed", signature: "current" });
      }
      setVisibility("hidden");
      repeatEvent(() => emitFinished(harness));
      pendingList.resolve(cronPage("previous"));
      await waitLabels("previous");
      expectCalls(request, 1, ["cron.list", "cron.status", "models.authStatus"]);
      if (initial === "pending with dismissal") {
        expect(loadDismissals(key)).toEqual({ cronFailed: ["current"] });
      }
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await waitForFast(() => {
        if (initial === "pending with dismissal") {
          expect(store?.entries).toEqual([]);
        } else {
          expectLabels("current");
        }
      });
      expectCalls(request, 2);
      expectCalls(request, 1, ["models.authStatus"]);
      if (initial === "pending with dismissal") {
        expect(loadDismissals(key)).toEqual({ cronFailed: ["current"] });
      }
    },
  );

  it("publishes progress but retires dismissals only after a fresh complete inventory", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const pages = Array.from({ length: 5 }, () => pending(cronPage()));
    let listCalls = 0;
    const request = inventoryRequest(() => pages[listCalls++]!.promise);
    const harness = gateway(request, true);
    store = activate(harness);
    pages[0]!.resolve(cronPage("dismissed"));
    await waitForFast(() => expect(store?.entries).toHaveLength(1));
    store.dismiss({ kind: "cronFailed", signature: "dismissed" });

    harness.emitEvent("cron", {});
    for (const index of [1, 2]) {
      await waitForFast(() => expect(listCalls).toBe(index + 1));
      harness.emitEvent("cron", {});
      pages[index]!.resolve(cronPage(`current-${index}`));
      await waitLabels(`current-${index}`);
      expect(dismissalState(harness)).toEqual({ cronFailed: ["dismissed"] });
    }
    pages[3]!.resolve({ ...cronPage("partial"), hasMore: true, total: 2, nextOffset: 1 });
    await waitForFast(() => expect(listCalls).toBe(5));
    expectLabels("current-2");
    expect(dismissalState(harness)).toEqual({ cronFailed: ["dismissed"] });
    pages[4]!.resolve({ ...cronPage("fresh"), snapshotRevision: "partial", total: 2, offset: 1 });
    await waitLabels("partial", "fresh");
    expect(dismissalState(harness)).toEqual({});
  });

  it("queues auth invalidations, publishes progress, and keeps settled auth cached", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let now = 120_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const auth = Array.from({ length: 4 }, () => pending(emptyAuth(now)));
    let authCalls = 0;
    const harness = gateway(
      inventoryRequest(
        () => cronPage("failed-cron"),
        1,
        () => auth[authCalls++]!.promise,
      ),
    );
    store = createStore(harness.gateway);
    const publishedCounts: number[] = [];
    store.subscribe(() => publishedCounts.push(store?.entries.length ?? 0));
    store.activate(SidebarAttentionStoreOwner);
    await waitForFast(() => expect(store?.entries).toHaveLength(1));
    expect(publishedCounts).toContain(1);

    for (const index of [0, 1]) {
      now += 60_001;
      repeatEvent(() => {
        invalidateModelAuthStatusRequests(harness.gateway.snapshot.client!);
        harness.emitEvent("chat.metadata.changed", {});
      });
      expect(authCalls).toBe(index + 1);
      auth[index]!.resolve(missingAuth(now, `Current ${index}`));
      await waitForFast(() => expect(authCalls).toBe(index + 2));
      containsLabel(`Current ${index}`);
    }
    repeatEvent(() => harness.emitEvent("cron", {}));
    auth[2]!.resolve(missingAuth(now, "Cached auth"));
    await waitForFast(() => containsLabel("Cached auth"));
    containsLabel("failed-cron");
    now += 60_002;
    repeatEvent(() => harness.emitEvent("cron", {}));
    await settleRefresh();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(authCalls).toBe(3);
    containsLabel("Cached auth");
    invalidateModelAuthStatusRequests(harness.gateway.snapshot.client!);
    harness.emitEvent("chat.metadata.changed", {
      agentId: "main",
      usageUpdatedAt: now,
      modelCatalogChanged: false,
      authChanged: false,
    });
    await Promise.resolve();
    expect(authCalls).toBe(3);
    harness.emitEvent("chat.metadata.changed", {});
    expect(authCalls).toBe(4);
    auth[3]!.resolve(missingAuth(now, "Refreshed auth"));
    await waitForFast(() => containsLabel("Refreshed auth"));
  });

  it.each([false, true])("preserves failed inventory (scheduler disabled=%s)", async (disabled) => {
    vi.stubGlobal("localStorage", createStorageMock());
    const page = cronPage("overdue");
    Object.assign(page.jobs[0]!, { lastRunStatus: "ok", nextRunAtMs: 1 });
    let failing = false;
    const request = vi.fn(async (method: string) => {
      if (failing && method === (disabled ? "cron.status" : "cron.list")) {
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
    store = harness.attention;
    await settleRefresh();
    expectLabels(...(disabled ? [] : ["overdue"]));
    failing = true;
    harness.emitEvent("cron", {});
    await settleRefresh();
    expectLabels(...(disabled ? [] : ["overdue"]));
    if (disabled) {
      return;
    }
    harness.attention.dismiss({ kind: "cronOverdue", signature: "overdue@1" });
    harness.emitEvent("cron", {});
    await settleRefresh();
    expect(dismissalState(harness)).toEqual({ cronOverdue: ["overdue@1"] });
    failing = false;
    harness.emitEvent("cron", {});
    await settleRefresh();
    expect(store?.entries).toEqual([]);
  });

  it.each(["disconnect", "replace", "dispose"] as const)(
    "retires queued inventory and auth refreshes on %s",
    async (boundary) => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const gate = inventoryGate();
      const { request, cronStatus } = gate;
      const harness = gateway(request, true);
      store = createStore(harness.gateway);
      const publish = vi.fn();
      store.subscribe(publish);
      store.activate(SidebarAttentionStoreOwner);
      harness.emitEvent("cron", {});
      document.dispatchEvent(new Event("visibilitychange"));

      if (boundary === "disconnect") {
        harness.update({ phase: "reconnecting" });
      } else if (boundary === "replace") {
        harness.update({
          client: mockClient(inventoryRequest(() => cronPage("replacement"), cronStatus.jobs)),
        });
        await waitLabels("replacement");
      } else {
        store.dispose();
      }
      publish.mockClear();
      gate.finish("retired");
      await settleRefresh();

      expectCalls(request, 1, ["cron.list", "cron.status", "models.authStatus"]);
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it.each(["operator.read", "operator.sessions.read", "operator.sessions.write"])(
    "creates and retains one mention owner without broadening inventory access (%s)",
    async (scope) => {
      const mention = inboxMention("mention-first");
      let result = { gatewayInstanceId: "boot-a", revision: 1, items: [mention] };
      const request = respond({
        "mentions.list": () => result,
        "cron.list": () => ({ ...cronPage(), snapshotRevision: "lifecycle" }),
        "cron.status": () => ({ enabled: true, triggersEnabled: true, jobs: 0 }),
        "models.authStatus": () => emptyAuth(),
      });
      const harness = gateway(request);
      harness.update({
        hello: {
          type: "hello-ok",
          protocol: 1,
          server: { bootId: "boot-a", connId: "connection-a" },
          auth: { role: "operator", scopes: [scope] },
          features: { methods: ["mentions.list", "mentions.dismiss"] },
        },
        selfUser: { id: "bob", identity: { type: "profile", id: "bob" }, name: "Bob" },
      });
      store = createStore(harness.gateway);
      expect(request).not.toHaveBeenCalled();
      const mentions = store.activate(SidebarAttentionStoreOwner);
      expect(store.activate(SidebarAttentionStoreOwner)).toBe(mentions);
      await waitForFast(() => expect(mentions.snapshot.items).toEqual([mention]));
      expect(request.mock.calls.filter(([method]) => method === "mentions.list")).toHaveLength(1);
      if (scope !== "operator.read") {
        expect(request.mock.calls.map(([method]) => method)).toEqual(["mentions.list"]);
      }

      result = { ...result, revision: 2, items: [{ ...mention, id: "mention-second" }] };
      harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 2 });
      await waitForFast(() =>
        expect(store?.entries.filter((entry) => entry.type === "mention")).toMatchObject([
          { mention: { id: "mention-second" } },
        ]),
      );

      store.dispose();
      store = undefined;
      request.mockClear();
      harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 3 });
      await mentions.refresh();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("clears reviewed local incidents offline without deleting their drafts", async () => {
    const { sidebarInboxTabCounts } = await import("./sidebar-attention-entries.ts");
    vi.stubGlobal("sessionStorage", createStorageMock());
    const request = respond({
      "cron.list": () => cronPage("failed-job"),
      "cron.status": () => ({ enabled: true, jobs: 1 }),
      "models.authStatus": () => emptyAuth(),
    });
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
      sendState: "held" as const,
      sendRunId: "run-review",
    };
    expect(
      admitStoredChatComposerQueueItemResult(
        host,
        captureChatOutboxAdmission(host, host.sessionKey),
        row,
      ),
    ).toBe("admitted");
    store = activate(harness);
    await import("../lib/chat/outbox-attention.ts");
    await waitForFast(() =>
      expect(store?.entries.map((entry) => entry.type)).toEqual(["outbox", "attention"]),
    );
    const hello = harness.gateway.snapshot.hello;
    const dismissal = store.entries[0]?.dismissal;
    expect(dismissal?.kind).toBe("outbox");
    expect(JSON.stringify(store.entries[0])).not.toContain("private submission");
    harness.update({ phase: "reconnecting", hello: null });
    const calls = request.mock.calls.length;
    expect(store.entries.map((entry) => entry.type)).toEqual(["outbox", "attention"]);
    expect(sidebarInboxTabCounts(store.entries)).toMatchObject({
      all: 2,
      system: 2,
    });
    store.dismiss(dismissal!);
    expect(store.entries.map((entry) => entry.type)).toEqual(["attention"]);
    expect(request.mock.calls).toHaveLength(calls);
    harness.update({ phase: "connected", hello });
    expect(store.entries.some((entry) => entry.type === "outbox")).toBe(false);
    expect(
      updateStoredChatComposerQueueItems(host, host.sessionKey, [{ expected: row, next: null }]),
    ).toBe(true);
    expect(store.entries.map((entry) => entry.type)).toEqual(["attention"]);
  });
});
