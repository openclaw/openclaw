import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createStoredChatOutboxReader } from "../chat/outbox-store-projection.ts";
import {
  notifyStoredChatOutboxChanges,
  storageTargetForComposer,
  storedChatOutboxScopeKey,
  writeStoredOutboxStore,
} from "../chat/outbox-store.ts";
import { projectsForGateway } from "../projects.ts";
import { createGateway, sessionKey } from "../session-progress-cards.test-support.ts";
import { sessionProgressCardsForGateway } from "../session-progress-cards.ts";
import { createGatewayHarness } from "../session-pull-requests.test-support.ts";
import { sessionPullRequestsForGateway } from "../session-pull-requests.ts";
import {
  projectProgressCard,
  projectProjects,
  projectPullRequests,
  projectStoredOutbox,
} from "./domain-keyed.ts";

describe("scoped domain projections", () => {
  it("acquires a project catalog only for live readers and releases it when idle", async () => {
    const harness = createGatewayHarness();
    harness.setSnapshot({
      ...harness.gateway.snapshot,
      hello: {
        ...harness.gateway.snapshot.hello!,
        features: { methods: ["projects.list"] },
      },
    });
    harness.request.mockResolvedValue({ projects: [] });
    const catalog = projectsForGateway(harness.gateway);
    const projection = projectProjects(catalog);
    onTestFinished(() => projection.dispose());
    expect(projection.read().snapshot.ready).toBe(false);
    expect(harness.subscribeEvents).not.toHaveBeenCalled();
    const stopFirst = projection.subscribe(() => {});
    const stopSecond = projection.subscribe(() => {});
    await catalog.refresh();
    expect(projection.read().snapshot).toEqual({
      result: { projects: [] },
      repositories: [],
      ready: true,
    });
    expect(harness.subscribeEvents).toHaveBeenCalledOnce();
    expect(harness.request).toHaveBeenCalledWith("projects.list", {});
    stopFirst();
    expect(harness.unsubscribeEvents).not.toHaveBeenCalled();
    stopSecond();
    expect(harness.unsubscribeEvents).toHaveBeenCalledOnce();
    expect(projection.read().snapshot.ready).toBe(false);
  });

  it("watches a progress target and replaces its complete owner scope", async () => {
    const harness = createGateway();
    const card = { sessionKey, revision: 1, updatedAt: 1, markdown: "Current work" };
    harness.request.mockResolvedValue({ card });
    const store = sessionProgressCardsForGateway(harness.gateway);
    const target = { sessionKey };
    const projection = projectProgressCard({ store, target });
    const notify = vi.fn();
    projection.subscribe(notify);
    onTestFinished(() => projection.dispose());
    await store.load(target);
    expect(projection.read().card).toEqual(card);
    expect(projection.read().lifetime).toBeDefined();
    const next = createGateway();
    next.request.mockResolvedValue({ card: null });
    const nextStore = sessionProgressCardsForGateway(next.gateway);
    projection.replaceSource({ store: nextStore, target });
    await nextStore.load(target);
    expect(projection.read().card).toBeNull();
    notify.mockClear();
    harness.emitChange(sessionKey, 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("projects only watched pull-request keys and releases Gateway listeners on disposal", () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const key = "agent:main:projected";
    const projection = projectPullRequests({ store, sessionKey: key, options: { passive: true } });
    const notify = vi.fn();
    projection.subscribe(notify);
    onTestFinished(() => projection.dispose());
    expect(projection.read()).toBeUndefined();
    const snapshot = {
      pullRequests: [{ number: 42, state: "open" }],
      rateLimited: false,
      status: "ready",
    };
    harness.emit({ sessions: { [key]: snapshot } });
    expect(projection.read()).toEqual(snapshot);
    projection.replaceSource({ store, sessionKey: "agent:main:other", options: { passive: true } });
    expect(projection.read()).toBeUndefined();
    notify.mockClear();
    harness.emit({ sessions: { [key]: snapshot } });
    expect(notify).not.toHaveBeenCalled();
    projection.dispose();
    expect(harness.unsubscribeEvents).toHaveBeenCalled();
  });

  it("reads outbox badges through the storage owner and detaches its invalidation listener", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const scope = {
      settings: { gatewayUrl: "ws://projection.invalid" },
      connected: false,
      client: null,
    };
    const target = storageTargetForComposer(scope);
    const key = "agent:main:outbox";
    const projection = projectStoredOutbox({ reader: createStoredChatOutboxReader(), scope });
    const notify = vi.fn();
    projection.subscribe(notify);
    onTestFinished(() => projection.dispose());
    expect(projection.read().hasSessionDraft(key)).toBe(false);
    writeStoredOutboxStore(sessionStorage, target, {
      version: 4,
      gatewayOwner: target.gatewayOwner,
      recovery: {},
      sessions: {
        [storedChatOutboxScopeKey({ sessionKey: key })]: { draft: "Unsent", updatedAt: 1 },
      },
    });
    notifyStoredChatOutboxChanges();
    expect(projection.read().hasSessionDraft(key)).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    projection.dispose();
    notify.mockClear();
    notifyStoredChatOutboxChanges();
    expect(notify).not.toHaveBeenCalled();
  });
});
