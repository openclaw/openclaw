/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { ModelAuthStatusResult } from "../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import type { ApplicationContext } from "../app/context.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import type { SidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import { outboxStorageScope } from "../lib/chat/outbox-payload-store.runtime.ts";
import { captureChatOutboxAdmission } from "../lib/chat/outbox-store.ts";
import { readCronInventory } from "../lib/cron/inventory.ts";
import { invalidateModelAuthStatusRequests } from "../lib/model-auth-request-state.ts";
import {
  admitStoredChatComposerQueueItemResult,
  updateStoredChatComposerQueueItems,
} from "../pages/chat/composer-queue-persistence.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  deferredCronFailurePrefix,
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
    methods = ["cron.list"],
  ) {
    for (const method of methods) {
      const calls = request.mock.calls.filter(([name]) => name === method);
      expect(calls, method).toHaveLength(count);
    }
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
    expect(store.hasFailedAutomation).toBe(true);
    const { hello, selfUser } = harness.gateway.snapshot;
    harness.update({ phase: "reconnecting", hello: null, selfUser: undefined });
    expect(store.hasFailedAutomation).toBe(true);
    harness.update({ phase: "connected", hello });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.hasFailedAutomation).toBe(true);
    expect(reads).toBe(1);
    harness.update({ selfUser });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.hasFailedAutomation).toBe(true);
    expect(reads).toBe(2);
    refreshed.resolve(cronPage());
    await vi.advanceTimersByTimeAsync(0);
    expect(store.hasFailedAutomation).toBe(false);
    harness.emitEvent("cron", { action: "finished" });
    harness.update({ phase: "reconnecting", client: mockClient(async () => ({})) });
    expect(store.hasFailedAutomation).toBe(false);
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
    expect(store?.hasFailedAutomation).toBe(true);
    expect(mainAuthCalls).toBe(2);

    oldAuth.resolve(missingAuth(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.entries).toEqual([]);
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
      expect(store?.hasFailedAutomation).toBe(true);

      failed = true;
      harness.emitEvent("cron.inventory.changed", {});
      await vi.advanceTimersByTimeAsync(50);
      request.mockClear();
      harness.update(unavailable);
      harness.emitEvent("cron.inventory.changed", {});
      harness.emitEvent("config.changed", {});
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(request).not.toHaveBeenCalled();
      expect(store?.hasFailedAutomation).toBe(true);

      failed = false;
      harness.update({ restartPending: false, suspensionPhase: "accepting" });
      await vi.advanceTimersByTimeAsync(50);
      expectCalls(request, 1);
      expect(store?.hasFailedAutomation).toBe(true);
    },
  );

  it("keeps cron inventory after recovering a read, visibility, and idle time", async () => {
    vi.useFakeTimers();
    const setVisibility = visibilityControl();
    let failuresRemaining = 2;
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list" && failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("temporarily unavailable");
      }
      return method === "cron.list" ? cronPage("incident") : emptyAuth(Date.now());
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
    expect(store?.hasFailedAutomation).toBe(true);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_001);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expectCalls(request, 3);
    expect(modelAuthRequests(request)).toHaveLength(1);
    harness.emitEvent("config.changed", {});
    await vi.advanceTimersByTimeAsync(50);
    expectCalls(request, 4);
    harness.update({ phase: "reconnecting" });
    harness.update({ phase: "connected" });
    await vi.advanceTimersByTimeAsync(0);
    expectCalls(request, 5);
  });

  it.each(["account", "reconnect", "tenant"] as const)(
    "keeps snoozes isolated across %s switches and reloads",
    async (boundary) => {
      vi.stubGlobal("localStorage", createStorageMock());
      const request = inventoryRequest(
        () => cronPage(),
        () => ({
          ts: 1,
          providers: [
            { provider: "openai", displayName: "OpenAI", status: "missing", profiles: [] },
            { provider: "anthropic", displayName: "Anthropic", status: "missing", profiles: [] },
          ],
        }),
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
      store.dismiss({ kind: "modelAuthExpired", signature: "agent:main\nopenai" });
      expectLabels("Anthropic");
      if (boundary === "reconnect") {
        harness.update({ phase: "reconnecting", selfUser: null });
        store.dismiss({ kind: "modelAuthExpired", signature: "agent:main\nanthropic" });
        expect(store.entries).toEqual([]);
      }
      connect("bob");
      await waitForFast(() => expect(store?.entries).toHaveLength(2));
      store.dispose();
      store = activate(harness);
      await waitForFast(() => expect(store?.entries).toHaveLength(2));
      const dismissal = { kind: "modelAuthExpired" as const, signature: "agent:main\nanthropic" };
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
      expectLabels("OpenAI");
      connect("alice");
      await waitLabels(...(boundary === "reconnect" ? [] : ["Anthropic"]));
    },
  );

  it("imports saved automation dismissals without showing failures in the Inbox", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const legacyImport = pending({ acknowledgedAtMs: 17 });
    const deferredImport = pending({ acknowledgedAtMs: 23 });
    const request = respond({
      "cron.list": () => cronPage("archive"),
      "models.authStatus": () => emptyAuth(),
      "users.prefs.get": () => ({ status: "ok", entries: {} }),
      "cron.acknowledgeFailure": (params) =>
        isRecord(params) && params.id === "paused" ? legacyImport.promise : deferredImport.promise,
    });
    const harness = gateway(request, true);
    const key = resolveSidebarAttentionKey(harness.gateway)!;
    const deferredKey = deferredCronFailurePrefix(key) + "index";
    localStorage.setItem(
      key,
      JSON.stringify({ cronFailed: ["paused"], openClawIdRecoveryUse: ["existing"] }),
    );
    localStorage.setItem(deferredKey, "23");
    store = activate(harness);

    await waitForFast(() => {
      expect(request).toHaveBeenCalledWith("cron.acknowledgeFailure", {
        id: "paused",
        adopt: true,
      });
      expect(store?.hasFailedAutomation).toBe(true);
    });
    expectLabels();
    expect(loadDismissals(key).cronFailed).toEqual(["paused"]);
    legacyImport.resolve({ acknowledgedAtMs: 17 });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("cron.acknowledgeFailure", {
        id: "index",
        failedAtMs: 23,
      }),
    );
    expect(localStorage.getItem(deferredKey)).toBe("23");
    deferredImport.resolve({ acknowledgedAtMs: 23 });

    await waitForFast(() => expect(localStorage.getItem(deferredKey)).toBeNull());
    expect(loadDismissals(key)).toEqual({ openClawIdRecoveryUse: ["existing"] });
  });

  it("keeps a saved account dismissal while its auth status is unavailable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", createStorageMock());
    let status: ModelAuthStatusResult = {
      ...emptyAuth(),
      unavailable: { code: "PREPARED_MODEL_AUTH_UNAVAILABLE", message: "Auth status is preparing" },
    };
    const request = inventoryRequest(
      () => cronPage(),
      () => status,
    );
    const harness = gateway(request, true);
    const dismissal = { kind: "modelAuthExpired", signature: "agent:main\nopenai" } as const;
    const key = resolveSidebarAttentionKey(harness.gateway);
    dismissSidebarAttention(key, dismissal);
    store = activate(harness);

    await vi.advanceTimersByTimeAsync(0);
    expectCalls(request, 1, ["models.authStatus"]);
    expect(loadDismissals(key)).toEqual({ modelAuthExpired: [dismissal.signature] });

    status = missingAuth(2);
    harness.emitEvent("chat.metadata.changed", { agentId: "main", authChanged: true });
    await vi.advanceTimersByTimeAsync(0);
    expectCalls(request, 2, ["models.authStatus"]);
    expect(store.entries).toEqual([]);
  });

  it("retires old-account health before the eager facade publishes a storage refresh", async () => {
    const otherAccount = deferred<CompactCronPage>();
    const request = inventoryRequest(() =>
      profile === "alice" ? cronPage("alice") : otherAccount.promise,
    );
    const harness = gateway(request);
    let profile = "alice";
    harness.update({ selfUser: { id: profile, name: profile } });
    store = activate(harness);
    await waitForFast(() => expect(store?.hasFailedAutomation).toBe(true));
    const published: boolean[] = [];
    store.subscribe(() => {
      if (harness.gateway.snapshot.selfUser?.id === "bob") {
        published.push(store?.hasFailedAutomation ?? false);
      }
    });

    profile = "bob";
    harness.update({ selfUser: { id: profile, name: profile } });
    expect(published).not.toContain(true);
    expect(store.hasFailedAutomation).toBe(false);
    otherAccount.resolve(cronPage("bob"));
    await waitForFast(() => expect(store?.hasFailedAutomation).toBe(true));
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

  it("shows a finishing restart over a dismissed run and keeps that dismissal for later", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const request = inventoryRequest(() => cronPage());
    const harness = gateway(request, true);
    harness.update({
      hello: {
        ...harness.gateway.snapshot.hello!,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["update.run", "update.status"], events: [] },
      },
    });
    const run = createUpdateRunFixture({
      status: "succeeded",
      phase: "finished",
      finishedAtMs: Date.now() - 60_000,
    });
    const runDismissal = {
      kind: "updateAvailable" as const,
      signature: JSON.stringify(["run", run.runId]),
    };
    dismissSidebarAttention(resolveSidebarAttentionKey(harness.gateway), runDismissal);
    const snapshot = {
      approvalQueue: [],
      updateRun: run,
      updateRunAcknowledged: false,
      updateCampaignStatusHydrated: true,
      updateAvailable: null,
      updateSchedule: {
        channel: "stable",
        autoEnabled: true,
        campaign: {
          id: "owed",
          state: "countdown",
          announcedAtMs: 0,
          forceAtMs: 1,
          updatedAtMs: 0,
        },
      },
    };
    const overlays = { snapshot, subscribe: () => () => undefined };
    store = createStore(
      harness.gateway,
      undefined,
      undefined,
      undefined,
      overlays as unknown as ApplicationContext["overlays"],
    );
    // Each loaded source reconciles stored dismissals before it publishes.
    const published = vi.fn();
    store.subscribe(published);
    store.activate(SidebarAttentionStoreOwner);
    await waitForFast(() => expect(published.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(store.entries).toEqual([expect.objectContaining({ type: "update", dismissal: null })]);
    expect(dismissalState(harness)).toEqual({ updateAvailable: [runDismissal.signature] });

    // Turning automatic updates off retires the campaign; the dismissed outcome stays dismissed.
    snapshot.updateSchedule = { channel: "stable", autoEnabled: false } as never;
    expect(store.entries).toEqual([]);
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
              ...cronPage("first", "ok"),
              snapshotRevision: "inventory",
              total: 2,
              hasMore: true,
              nextOffset: 1,
            }
          : { ...cronPage("later"), snapshotRevision: "inventory", total: 2, offset: 1 };
      });
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
        await waitForFast(() => expect(store?.hasFailedAutomation).toBe(true));
      } else {
        await Promise.resolve();
        expect(offsets).toEqual([]);
        expect(store?.hasFailedAutomation).toBe(false);
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
      });
      const { attention, emitEvent } = startAuthenticatedStore(request);
      store = attention;
      await waitForFast(() => expect(offsets).toEqual([0, 1]));

      if (boundary === "hidden") {
        setVisibility("hidden");
      } else {
        attention.dispose();
      }
      emitEvent("cron.inventory.changed", {});
      pendingAppend.resolve({ ...cronPage("changed"), total: 2, offset: 1 });
      await settleRefresh();
      expect(offsets).toEqual([0, 1]);

      if (boundary === "hidden") {
        setVisibility("visible");
        await waitForFast(() => expect(store?.hasFailedAutomation).toBe(true));
        expect(offsets).toEqual([0, 1, 0]);
      }
    },
  );

  it("keeps the last known failure while hidden and catches up once on return", async () => {
    const setVisibility = visibilityControl();
    let listCalls = 0;
    const request = inventoryRequest(
      () => (++listCalls === 1 ? cronPage("previous") : cronPage()),
      () => emptyAuth(),
    );
    const harness = startAuthenticatedStore(request);
    store = harness.attention;
    await waitForFast(() => expect(store?.hasFailedAutomation).toBe(true));

    setVisibility("hidden");
    repeatEvent(() => harness.emitEvent("cron.inventory.changed", {}));
    expect(store.hasFailedAutomation).toBe(true);
    expectCalls(request, 1);

    setVisibility("visible");
    await waitForFast(() => expect(store?.hasFailedAutomation).toBe(false));
    expectCalls(request, 2);
    expectCalls(request, 1, ["models.authStatus"]);
  });

  it("reads scoped failure membership without sorting display rows for each table page", async () => {
    const names = vi.fn();
    const jobs = Array.from({ length: 201 }, (_, index) => {
      const id = `job-${index}`;
      const job = cronPage(id, index === 200 ? "error" : "ok").jobs[0]!;
      return Object.defineProperty(job, "name", {
        get() {
          names();
          return id;
        },
      });
    });
    const offsets: number[] = [];
    const request = inventoryRequest((params) => {
      const offset = isRecord(params) ? Number(params.offset) : 0;
      offsets.push(offset);
      return {
        jobs: jobs.slice(offset, offset + 200),
        snapshotRevision: "membership",
        total: jobs.length,
        limit: 200,
        offset,
        hasMore: offset === 0,
        nextOffset: offset === 0 ? 200 : null,
      };
    });
    store = startAuthenticatedStore(request).attention;
    await waitForFast(() => expect(store?.hasFailedAutomation).toBe(true));
    expect(offsets).toEqual([0, 200]);
    expect(names).not.toHaveBeenCalled();
  });

  it.each([{ job: null }, { job: {} }])(
    "keeps the last failure and retries if a later page contains a malformed job ($job)",
    async ({ job }) => {
      vi.useFakeTimers();
      const offsets: number[] = [];
      const request = inventoryRequest((params) => {
        const offset = isRecord(params) ? Number(params.offset) : 0;
        offsets.push(offset);
        if (offsets.length === 1) {
          return cronPage("previous");
        }
        const page = cronPage("healthy", "ok");
        if (offsets.length === 2) {
          return { ...page, total: 2, hasMore: true, nextOffset: 1 };
        }
        if (offset === 1) {
          return { ...page, jobs: [job], total: 2, offset };
        }
        return page;
      });
      const harness = startAuthenticatedStore(request);
      store = harness.attention;
      await vi.advanceTimersByTimeAsync(0);
      expect(store.hasFailedAutomation).toBe(true);

      harness.emitEvent("cron.inventory.changed", {});
      await vi.advanceTimersByTimeAsync(50);
      expect(offsets).toEqual([0, 0, 1]);
      expect(store.hasFailedAutomation).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(offsets).toEqual([0, 0, 1, 0]);
      expect(store.hasFailedAutomation).toBe(false);
    },
  );

  it.each(["malformed", "rejected"] as const)(
    "applies live failures after a %s superseded request",
    async (response) => {
      vi.useFakeTimers();
      const previous = pending<unknown>(cronPage());
      let reads = 0;
      const request = inventoryRequest(() =>
        ++reads === 1 ? previous.promise : cronPage("incident", "ok"),
      );
      const harness = startAuthenticatedStore(request);
      store = harness.attention;
      const result = Promise.allSettled([
        readCronInventory(harness.gateway.snapshot.client!, { compact: true }),
      ]);
      expectCalls(request, 1);
      harness.emitEvent("cron.inventory.changed", {});
      if (response === "malformed") {
        previous.resolve({ ...cronPage("obsolete"), jobs: [null] });
      } else {
        previous.reject(new Error("inventory unavailable"));
      }
      await vi.advanceTimersByTimeAsync(50);
      if (response === "malformed") {
        expect(await result).toMatchObject([
          { status: "fulfilled", value: { jobs: [{ id: "incident" }] } },
        ]);
      } else {
        expect(await result).toMatchObject([{ status: "rejected" }]);
      }
      expectCalls(request, 2);
      expect(store.hasFailedAutomation).toBe(false);
      const job = eventJob();
      harness.emitEvent("cron", { action: "finished", jobId: job.id, job });
      expect(store.hasFailedAutomation).toBe(true);
      expectCalls(request, 2);
    },
  );

  it.each(["blocked", "needs_attention"] as const)(
    "projects %s from scoped inventory and clears it on meaningful recovery or removal",
    async (outcome) => {
      vi.useFakeTimers();
      const lastMeaningfulResult = { outcome, summary: "Source access required", atMs: 10 };
      const request = inventoryRequest(() => {
        const page = cronPage("incident", "ok");
        page.jobs[0]!.lastMeaningfulResult = lastMeaningfulResult;
        return page;
      });
      const harness = startAuthenticatedStore(request);
      store = harness.attention;
      await vi.advanceTimersByTimeAsync(0);
      expect(store.hasFailedAutomation).toBe(true);
      const publish = (job: ReturnType<typeof eventJob>, action = "finished") =>
        harness.emitEvent("cron", { action, jobId: job.id, job });
      const quiet = eventJob({
        state: { lastRunStatus: "ok", lastRunAtMs: 20, lastMeaningfulResult },
      });
      publish(quiet);
      publish({ ...quiet, state: { ...quiet.state, lastRunAtMs: 30 } });
      expect(store.hasFailedAutomation).toBe(true);
      publish({ ...quiet, enabled: false }, "scheduled");
      expect(store.hasFailedAutomation).toBe(false);
      publish(quiet, "scheduled");
      expect(store.hasFailedAutomation).toBe(true);
      for (const recovered of ["progress", "done"] as const) {
        publish({
          ...quiet,
          state: {
            lastRunStatus: "ok",
            lastMeaningfulResult: { outcome: recovered, summary: "Source processed", atMs: 40 },
          },
        });
        expect(store.hasFailedAutomation).toBe(false);
        publish({ ...quiet, id: "outside-inventory" });
        expect(store.hasFailedAutomation).toBe(false);
        publish(quiet);
        expect(store.hasFailedAutomation).toBe(true);
      }
      publish(quiet, "removed");
      publish(quiet);
      expect(store.hasFailedAutomation).toBe(false);
      expectCalls(request, 1);
    },
  );

  it("keeps the indicator while a replacement inventory is only partially loaded", async () => {
    const remaining = deferred<CompactCronPage>();
    let reads = 0;
    const request = inventoryRequest(() => {
      switch (++reads) {
        case 1:
          return cronPage("failed-job");
        case 2:
          return { ...cronPage("healthy-job", "ok"), total: 2, hasMore: true, nextOffset: 1 };
        default:
          return remaining.promise;
      }
    });
    const harness = startAuthenticatedStore(request);
    store = harness.attention;
    await waitForFast(() => expect(store?.hasFailedAutomation).toBe(true));

    harness.emitEvent("cron.inventory.changed", {});
    await waitForFast(() => expectCalls(request, 3));
    expect(store.hasFailedAutomation).toBe(true);
    remaining.resolve({
      ...cronPage("another-healthy-job", "ok"),
      snapshotRevision: "healthy-job",
      total: 2,
      offset: 1,
    });
    await waitForFast(() => expect(store?.hasFailedAutomation).toBe(false));
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
        () => auth[authCalls++]!.promise,
      ),
    );
    store = createStore(harness.gateway);
    store.activate(SidebarAttentionStoreOwner);
    await waitForFast(() => expect(store?.hasFailedAutomation).toBe(true));
    expect(store.entries).toEqual([]);

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
    repeatEvent(() => harness.emitEvent("cron.inventory.changed", {}));
    auth[2]!.resolve(missingAuth(now, "Cached auth"));
    await waitForFast(() => containsLabel("Cached auth"));
    expect(store.hasFailedAutomation).toBe(true);
    now += 60_002;
    repeatEvent(() => harness.emitEvent("cron.inventory.changed", {}));
    await settleRefresh();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(authCalls).toBe(3);
    containsLabel("Cached auth");
    invalidateModelAuthStatusRequests(harness.gateway.snapshot.client!);
    harness.emitEvent("chat.metadata.changed", {
      agentId: "other",
      modelCatalogChanged: true,
      authChanged: true,
      commandsChanged: false,
    });
    await Promise.resolve();
    expect(authCalls).toBe(3);
    containsLabel("Cached auth");
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

  it("preserves a known failure when a refresh fails", async () => {
    let failing = false;
    const request = inventoryRequest(() => {
      if (failing) {
        throw new Error("temporarily unavailable");
      }
      return cronPage("incident");
    });
    const harness = startAuthenticatedStore(request);
    store = harness.attention;
    await waitForFast(() => expect(store?.hasFailedAutomation).toBe(true));
    failing = true;
    harness.emitEvent("cron.inventory.changed", {});
    await waitForFast(() => expectCalls(request, 2));
    expect(store.hasFailedAutomation).toBe(true);
  });

  it.each(["disconnect", "replace", "dispose"] as const)(
    "retires queued inventory and auth refreshes on %s",
    async (boundary) => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const list = pending(cronPage());
      const auth = pending(emptyAuth());
      const request = respond({
        "cron.list": () => list.promise,
        "models.authStatus": () => auth.promise,
      });
      const harness = gateway(request, true);
      store = createStore(harness.gateway);
      const publish = vi.fn();
      store.subscribe(publish);
      store.activate(SidebarAttentionStoreOwner);
      harness.emitEvent("cron.inventory.changed", {});
      document.dispatchEvent(new Event("visibilitychange"));

      if (boundary === "disconnect") {
        harness.update({ phase: "reconnecting" });
      } else if (boundary === "replace") {
        harness.update({
          client: mockClient(inventoryRequest(() => cronPage("replacement"))),
        });
        await waitForFast(() => expect(store?.hasFailedAutomation).toBe(true));
      } else {
        store.dispose();
      }
      publish.mockClear();
      list.resolve(cronPage("retired"));
      auth.resolve(emptyAuth());
      await settleRefresh();

      expectCalls(request, 1, ["cron.list", "models.authStatus"]);
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
      "models.authStatus": () => missingAuth(1),
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
