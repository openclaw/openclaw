import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createTestGatewayClient,
  createGatewayRequestMock,
  type GatewayRequestHandler,
  type GatewayRequestMock,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { beginModelCatalogRead, publishModelCatalogResult } from "../model-catalog-cache.ts";
import { loadModelCatalog, peekModelCatalog } from "../model-catalog-store.ts";
import {
  invalidateChatMetadataForSessionEvent,
  invalidateChatMetadataStore,
  type ChatMetadataResult,
  type ChatMetadataResponse,
  type ChatMetadataUpdate,
} from "./chat-metadata-cache.ts";
import {
  loadChatMetadataRefresh,
  peekChatMetadata,
  beginChatMetadataPublication,
  revalidateChatMetadata,
  retireChatMetadataRefresh,
  subscribeChatMetadata,
} from "./chat-metadata-store.ts";

const agentScope = { agentId: "main" };
const retained = { ...agentScope, sessionKey: "agent:main:retained" };
const empty: ChatMetadataResult = { commands: [] };
const models = [{ id: "fresh", name: "Fresh", provider: "test" }];
type Scope = Parameters<typeof loadChatMetadataRefresh>[1];
const releases: (() => void)[] = [];
const pendingReads: Promise<unknown>[] = [];
let request: GatewayRequestMock;
let catalogRequest: GatewayRequestMock;
let client: GatewayBrowserClient;
let wireRequest: GatewayRequestMock;
beforeEach(() => {
  request = vi.fn<GatewayRequestHandler>();
  catalogRequest = vi.fn<GatewayRequestHandler>().mockResolvedValue({ models: [] });
  wireRequest = createGatewayRequestMock((method, ...args) =>
    method === "models.list" ? catalogRequest(method, ...args) : request(method, ...args),
  );
  client = createTestGatewayClient(wireRequest);
});

function pending<T>(fallback: T) {
  const read = deferred<T>();
  releases.push(() => read.resolve(fallback));
  return read;
}
function refresh(options?: Parameters<typeof loadChatMetadataRefresh>[2]) {
  const read = loadChatMetadataRefresh(client, retained, options);
  pendingReads.push(read.completed);
  return read;
}
function sessionEvent(event: Record<string, unknown>) {
  invalidateChatMetadataForSessionEvent(client, { ...retained, ...event }, {});
}
function methods() {
  return wireRequest.mock.calls.map(([method]) => method);
}
function counts() {
  return [request.mock.calls.length, catalogRequest.mock.calls.length];
}
function autoRefresh() {
  const refreshes: Promise<void>[] = [];
  mount(retained, (update) => {
    if (update.type === "invalidated") {
      refreshes.push(refresh().completed);
    }
  });
  return () => Promise.all(refreshes);
}

function pendingMetadata() {
  return pending(metadata("current"));
}

function load(scope: Scope = agentScope) {
  const result = loadChatMetadataRefresh(client, scope).completed;
  pendingReads.push(result);
  return result;
}

function revalidate(scope: Scope = agentScope) {
  const result = revalidateChatMetadata(client, scope);
  pendingReads.push(result);
  return result;
}

function peek(scope: Scope = agentScope) {
  return peekChatMetadata(client, scope);
}

function mount(
  scope: Scope = agentScope,
  listener: Parameters<typeof subscribeChatMetadata>[2] = () => {},
  active = () => true,
) {
  const release = subscribeChatMetadata(client, scope, listener, active);
  releases.push(release);
  return release;
}

function startupPending() {
  return new GatewayRequestError({
    code: "UNAVAILABLE",
    message: "Agent is preparing",
    details: { code: "agent-database-inspection-pending" },
    retryable: true,
    retryAfterMs: 250,
  });
}

function metadata(name: string): ChatMetadataResult {
  return {
    commands: [{ name, description: name, source: "native", scope: "text", acceptsArgs: false }],
  };
}

afterEach(async () => {
  for (const release of releases.splice(0).toReversed()) {
    release();
  }
  await Promise.allSettled(pendingReads.splice(0));
  vi.useRealTimers();
});

describe("chat metadata store", () => {
  it("invalidates subscribed catalogs with their aliases and detailed views after a session patch", async () => {
    request.mockResolvedValue({ models: [] });
    const scope = { agentId: "main", sessionKey: "agent:main:main" };
    const alias = { ...scope, sessionKey: "main" };
    const detailed = { ...scope, includeDetails: true };
    const defaults = {
      hello: {
        ...gatewayHelloForMethods([]),
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: scope.sessionKey,
          },
        },
      },
    };
    mount(scope);
    beginChatMetadataPublication(client, scope).publish(metadata("active"));
    beginChatMetadataPublication(client, alias).publish(metadata("inactive"));
    await Promise.all([scope, alias, detailed].map((params) => loadModelCatalog(client, params)));
    invalidateChatMetadataForSessionEvent(client, { ...scope, reason: "patch" }, defaults);
    expect(peekModelCatalog(client, scope)).toBeUndefined();
    expect(peekModelCatalog(client, alias)).toBeUndefined();
    expect(peekModelCatalog(client, detailed)).toBeUndefined();
  });

  it.each(["before", "after"])(
    "invalidates catalogs when the last subscriber leaves %s a patch",
    async (timing) => {
      const oldModel = { id: "old", name: "Old", provider: "example" };
      const newModel = { ...oldModel, id: "new", name: "New" };
      catalogRequest
        .mockResolvedValueOnce({ models: [oldModel] })
        .mockResolvedValue({ models: [newModel] });
      const scope = { agentId: "main", sessionKey: "agent:main:released" };
      const release = mount(scope);
      beginChatMetadataPublication(client, scope).publish(metadata("cached"));
      await loadModelCatalog(client, scope);
      if (timing === "before") {
        release();
      }
      invalidateChatMetadataForSessionEvent(client, { ...scope, reason: "patch" }, {});
      if (timing === "after") {
        release();
      }
      expect(await loadModelCatalog(client, scope)).toEqual({ models: [newModel] });
      expect(catalogRequest).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ...["patch", "command-metadata", "reset"].map((reason) => ({
      reason,
      catalogChanged: undefined,
    })),
    { reason: "patch", catalogChanged: true },
    { reason: "mark-read", catalogChanged: true },
  ])(
    "classifies $reason invalidation (catalogChanged=$catalogChanged) without discarding unrelated catalogs",
    async ({ reason, catalogChanged }) => {
      request.mockResolvedValue({ models: [] });
      const scope = { agentId: "main", sessionKey: "agent:main:current" };
      const other = { agentId: "main", sessionKey: "agent:main:other" };
      const listener = vi.fn();
      mount(scope, listener);
      beginChatMetadataPublication(client, scope).publish(metadata("before"));
      await Promise.all([loadModelCatalog(client, scope), loadModelCatalog(client, other)]);
      invalidateChatMetadataForSessionEvent(client, { ...scope, reason, catalogChanged }, {});
      expect(listener).toHaveBeenLastCalledWith({
        type: "invalidated",
        scope: "session",
        refreshSessionFacts: true,
      });
      expect(peek(scope)).toEqual(metadata("before"));
      expect(peekModelCatalog(client, scope)).toBeUndefined();
      expect(peekModelCatalog(client, other)).toEqual({ models: [] });
    },
  );

  it("revalidates compact commands by revision without repeating session or account reads", async () => {
    const commands = {
      ...metadata("status"),
      revision: "commands-1",
      requiredWorkerInferenceProfileId: "worker-profile",
    };
    const scope = { agentId: "main", sessionKey: "agent:main:saved" };
    const legacy = {
      ...commands,
      models: [{ id: "old", name: "Old", provider: "example" }],
      accountSelection: { kind: "automatic", label: "Automatic" },
    } satisfies ChatMetadataResponse;
    request.mockResolvedValue({ unchanged: true, revision: commands.revision });
    mount(scope);
    beginChatMetadataPublication(client, scope).publish(legacy);
    expect(peek(scope)).toEqual(commands);
    invalidateChatMetadataStore(client);
    expect(peek(scope)).toBeUndefined();
    await load(scope);
    expect(request).toHaveBeenCalledWith("chat.metadata", {
      agentId: "main",
      includeModels: false,
      ifRevision: "commands-1",
    });
    expect(peek(scope)).toEqual(commands);
    const changed = { ...metadata("new-command"), revision: "commands-2" };
    request.mockResolvedValue(changed);
    invalidateChatMetadataStore(client);
    await load(scope);
    expect(peek(scope)).toEqual(changed);
  });

  it.each([
    { sessionKey: "agent:main:locked" },
    { authProfileId: "personal:person-a:anthropic:one" },
  ])("isolates selected metadata %j and retires unmounted writers", async (selection) => {
    request.mockResolvedValue(metadata("neutral"));
    const scope = { agentId: "main", ...selection };
    const first = mount(scope);
    const second = mount(scope);
    beginChatMetadataPublication(client, scope).publish(metadata("locked"));
    mount(agentScope);
    await load();
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(metadata("neutral"));
    expect(peek(scope)).toEqual(metadata("locked"));
    first();
    expect(peek(scope)).toEqual(metadata("locked"));
    const lateStartup = beginChatMetadataPublication(client, scope);
    second();
    void lateStartup.publish(metadata("late"));
    expect(peek(scope)).toEqual(metadata("locked"));
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(metadata("neutral"));
  });

  it("retries missing startup commands after a model-only publication", async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:commands" };
    request.mockResolvedValue(metadata("recovered"));
    mount(scope);
    beginChatMetadataPublication(client, scope).publish(metadata("previous"));
    expect(() =>
      beginChatMetadataPublication(client, scope).publish({ revision: "failed" }),
    ).toThrow("Chat commands are unavailable");
    expect(peek(scope)).toBeUndefined();
    invalidateChatMetadataStore(client, undefined, undefined, "refresh", {
      commandsChanged: false,
    });
    await load(scope);
    expect(request).toHaveBeenCalledOnce();
    expect(peek(scope)).toEqual(metadata("recovered"));
  });

  it.each(["result", "error"])(
    "coalesces invalidations while retiring stale startup and read %s publications",
    async (outcome) => {
      const older = pendingMetadata();
      const replacement = metadata("current");
      request.mockReturnValueOnce(older.promise).mockResolvedValue(replacement);
      const scope = { agentId: "main", sessionKey: "agent:main:locked" };
      const updates: string[] = [];
      const refreshes: Promise<void>[] = [];
      mount(scope, (update) => {
        updates.push(update.type);
        if (update.type === "invalidated") {
          refreshes.push(load(scope));
        }
      });
      const startup = beginChatMetadataPublication(client, scope);
      const oldRead = load(scope).catch(() => undefined);
      for (let index = 0; index < 8; index++) {
        invalidateChatMetadataStore(client);
      }
      expect.soft(request).toHaveBeenCalledOnce();
      void startup.publish(metadata("obsolete-startup"));
      if (outcome === "error") {
        older.reject(new Error("obsolete-read"));
      } else {
        older.resolve(metadata("obsolete-read"));
      }
      await oldRead;
      await Promise.all(refreshes);
      expect(request).toHaveBeenCalledTimes(2);
      expect(peek(scope)).toEqual(replacement);
      expect(updates).not.toContain("error");
      expect(request).toHaveBeenLastCalledWith("chat.metadata", {
        agentId: scope.agentId,
        includeModels: false,
      });
    },
  );

  it.each([
    ...[
      { kind: "load", read: load },
      { kind: "revalidation", read: revalidate },
    ].flatMap(({ kind, read }) => ["shared", "invalidated"].map((mode) => ({ kind, read, mode }))),
    { kind: "load", read: load, mode: "queued" },
  ])("reserves the current $kind during $mode loading observer reentry", async ({ read, mode }) => {
    const older = pendingMetadata();
    const newer = pendingMetadata();
    request.mockReturnValueOnce(older.promise).mockReturnValue(newer.promise);
    let observed = false;
    let following: Promise<ChatMetadataResult | void> | undefined;
    let queued: Promise<ChatMetadataResult> | undefined;
    mount(agentScope, (update) => {
      if (update.type === "loading" && !observed) {
        observed = true;
        if (mode === "invalidated") {
          invalidateChatMetadataStore(client, agentScope);
        }
        following = read();
        if (mode === "queued") {
          queued = revalidate();
        }
      }
    });
    const first = read();
    expect(following).toBeDefined();
    expect(read()).toBe(read === load ? following : (queued ?? following));
    if (mode !== "invalidated") {
      expect(following).toBe(first);
    }
    expect(request).toHaveBeenCalledOnce();
    const initial = metadata(mode === "shared" ? "current" : "obsolete");
    older.resolve(initial);
    if (read === revalidate) {
      await expect(first).resolves.toEqual(initial);
    } else {
      await first;
    }
    if (mode !== "shared") {
      expect(peek()).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(2);
      newer.resolve(metadata("current"));
    }
    if (queued || read === revalidate) {
      await expect(queued ?? following).resolves.toEqual(metadata("current"));
    } else {
      await following;
    }
    expect(peek()).toEqual(metadata("current"));
    expect(request).toHaveBeenCalledTimes(mode === "shared" ? 1 : 2);
  });

  it.each([
    ...[new Error("metadata failed"), undefined].map((failure) => ({
      failure,
      event: "error",
    })),
    { failure: undefined, event: "result" },
  ])("starts a fresh request from a $event observer (%#)", async ({ failure, event }) => {
    const next = pendingMetadata();
    const older = metadata("older");
    const current = metadata("current");
    if (event === "error") {
      request.mockRejectedValueOnce(failure);
    } else {
      request.mockResolvedValueOnce(older);
    }
    request.mockReturnValue(next.promise);
    let following: Promise<ChatMetadataResult> | undefined;
    mount(agentScope, (update) => {
      if (update.type === event && !following) {
        following = revalidate();
      }
    });
    const first = revalidate();
    if (event === "error") {
      await expect(first).rejects.toBe(failure);
    } else {
      await expect(first).resolves.toEqual(older);
    }
    expect(request).toHaveBeenCalledTimes(2);
    expect(peek()).toEqual(event === "result" ? older : undefined);
    next.resolve(current);
    await expect(following).resolves.toEqual(current);
    expect(peek()).toEqual(current);
  });

  it("bounds inactive session metadata without evicting a mounted conversation", async () => {
    request.mockResolvedValue(metadata("cached"));
    const mounted = { agentId: "main", sessionKey: "agent:main:mounted" };
    mount(mounted);
    await load(mounted);
    for (let index = 0; index < 70; index++) {
      const inactive = { agentId: "main", sessionKey: `agent:main:${index}` };
      const release = mount(inactive);
      await load(inactive);
      release();
    }

    expect(peekChatMetadata(client, mounted)).toEqual(metadata("cached"));
    expect(
      peekChatMetadata(client, { agentId: "main", sessionKey: "agent:main:0" }),
    ).toBeUndefined();
    const recent = { agentId: "main", sessionKey: "agent:main:69" };
    const release = mount(recent);
    await load(recent);
    release();
    expect(request).toHaveBeenCalledTimes(71);
  });

  it.each([false, true])(
    "retires an older automatic refresh while preserving the newest writer (startup=%s)",
    async (startup) => {
      mount(agentScope);
      const older = pendingMetadata();
      const newer = pendingMetadata();
      request.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      const olderLoad = load(agentScope);
      const newerLoad = revalidate(agentScope);
      if (startup) {
        beginChatMetadataPublication(client, agentScope).publish(metadata("startup"));
      }
      expect.soft(request).toHaveBeenCalledOnce();
      older.resolve(metadata("old-model"));
      await olderLoad;
      expect(peek(agentScope)).toEqual(startup ? metadata("startup") : undefined);
      newer.resolve(metadata("new-model"));
      await expect(newerLoad).resolves.toEqual(metadata("new-model"));
      expect(peek(agentScope)).toEqual(metadata(startup ? "startup" : "new-model"));
    },
  );

  it("coalesces another invalidation wave while the trailing read is active", async () => {
    const first = pendingMetadata();
    const second = pendingMetadata();
    const current = metadata("current");
    request
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(current);
    const reads: Promise<void>[] = [];
    mount(agentScope, (update) => {
      if (update.type === "invalidated") {
        reads.push(load(agentScope));
      }
    });
    reads.push(load(agentScope));
    invalidateChatMetadataStore(client);
    first.resolve(metadata("first"));
    await reads[0];
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    for (let index = 0; index < 8; index++) {
      invalidateChatMetadataStore(client);
    }
    expect.soft(request).toHaveBeenCalledTimes(2);
    second.resolve(metadata("second"));
    await Promise.all(reads);
    expect(request).toHaveBeenCalledTimes(3);
    expect(peek(agentScope)).toEqual(current);
  });

  it("retains active ownership across selected-scope unsubscribe and remount", async () => {
    const older = pendingMetadata();
    const fresh = metadata("fresh");
    request.mockReturnValueOnce(older.promise).mockResolvedValue(fresh);
    const scope = { agentId: "main", sessionKey: "agent:main:remounted" };
    const release = mount(scope);
    const oldRead = load(scope);
    const queuedRead = revalidate(scope);
    release();
    const listener = vi.fn();
    const releaseRemount = mount(scope, listener);
    const remountedRead = load(scope);
    expect.soft(request).toHaveBeenCalledOnce();
    older.resolve(metadata("obsolete"));
    await Promise.all([oldRead, queuedRead, remountedRead]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.filter(([update]) => update.type === "result")).toEqual([
      [{ type: "result", result: fresh }],
    ]);
    releaseRemount();
    expect(peek(scope)).toEqual(fresh);
  });

  it.each([false, true])(
    "retires queued startup demand at last unsubscribe (remount=%s)",
    async (remount) => {
      vi.useFakeTimers();
      const older = pendingMetadata();
      const fresh = metadata("fresh");
      request.mockReturnValueOnce(older.promise).mockRejectedValue(startupPending());
      const scope = { agentId: "main", sessionKey: "agent:main:queued-startup" };
      const release = mount(scope);
      const oldRead = load(scope);
      const queued = revalidate(scope).catch((error: unknown) => error);
      release();
      const listener = vi.fn();
      if (remount) {
        mount(scope, listener);
      }
      const remounted = remount ? load(scope) : undefined;
      older.resolve(metadata("obsolete"));
      await oldRead;
      await vi.advanceTimersByTimeAsync(0);
      if (remount) {
        expect(request).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(500);
        expect(request).toHaveBeenCalledTimes(3);
        request.mockResolvedValue(fresh);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await queued).toEqual(fresh);
        await remounted;
        expect(peek(scope)).toEqual(fresh);
        expect(listener.mock.calls.filter(([update]) => update.type === "result")).toEqual([
          [{ type: "result", result: fresh }],
        ]);
      } else {
        expect(request).toHaveBeenCalledOnce();
        expect(await queued).toHaveProperty("name", "AbortError");
        await vi.advanceTimersByTimeAsync(180_000);
        expect(request).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not retry metadata revalidation failures", async () => {
    request.mockRejectedValue(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "database temporarily unavailable",
        details: { reason: "database-busy" },
        retryable: true,
        retryAfterMs: 250,
      }),
    );

    await expect(revalidateChatMetadata(client, { agentId: "main" })).rejects.toThrow(
      "database temporarily unavailable",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["ready", "released"] as const)(
    "keeps agent startup metadata pending for minutes until %s",
    async (outcome) => {
      vi.useFakeTimers();
      request.mockRejectedValue(startupPending());
      const updates: string[] = [];
      const release = mount(agentScope, (update) => updates.push(update.type));
      const result = revalidate(agentScope).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(182_499);
      expect(request).toHaveBeenCalledTimes(39);
      expect(updates).not.toContain("error");
      if (outcome === "ready") {
        request.mockResolvedValue(metadata("ready"));
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toEqual(metadata("ready"));
        expect(peek(agentScope)).toEqual(metadata("ready"));
      } else {
        release();
        expect(await result).toHaveProperty("name", "AbortError");
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("automatic metadata admission", () => {
  beforeEach(() => {
    request.mockResolvedValue(empty);
    catalogRequest.mockResolvedValue({ models });
  });
  it("retains commands and catalogs across activity and refreshes one changed selection", async () => {
    vi.useFakeTimers();
    let sessionModelRevision = "selection-1";
    catalogRequest.mockImplementation(async () => ({ models, sessionModelRevision }));
    const settled = autoRefresh();
    const publish = (revision: string, catalogChanged = false) =>
      sessionEvent({
        reason: "patch",
        ...(catalogChanged ? { catalogChanged: true } : {}),
        session: { key: retained.sessionKey, sessionModelRevision: revision },
      });
    await refresh().completed;
    wireRequest.mockClear();
    for (let index = 0; index < 50; index++) {
      publish(sessionModelRevision, index % 2 === 0);
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(wireRequest).not.toHaveBeenCalled();
    sessionModelRevision = "selection-2";
    publish(sessionModelRevision, true);
    await settled();
    expect(methods()).toEqual(["models.list"]);
    publish(sessionModelRevision);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(wireRequest).toHaveBeenCalledOnce();
    expect(peekChatMetadata(client, retained)).toEqual(empty);
    expect(peekModelCatalog(client, retained)?.sessionModelRevision).toBe(sessionModelRevision);
  });

  it("hands a retiring automatic catalog to its foreground reader without replacing the read", async () => {
    const catalog = pending({ models });
    wireRequest = vi
      .fn()
      .mockReturnValueOnce(catalog.promise)
      .mockRejectedValue(new Error("Unexpected replacement"));
    client = createTestGatewayClient(wireRequest);
    mount(retained);
    const automatic = refresh({ kind: "startup" });
    const automaticCatalog = automatic.catalog.catch((error: unknown) => error);
    retireChatMetadataRefresh(client, retained);
    const foreground = loadModelCatalog(client, retained);
    catalog.resolve({ models });
    await expect(foreground).resolves.toEqual({ models });
    await automatic.completed;
    expect(await automaticCatalog).toEqual({ models });
    expect(wireRequest).toHaveBeenCalledOnce();
  });

  it("cancels startup polling after a retired refresh loses its last subscriber", async () => {
    vi.useFakeTimers();
    const protocol = new GatewayPendingRequests({
      createRequestId: () => "catalog",
      nowMs: Date.now,
    });
    wireRequest = createGatewayRequestMock((method, params, options) =>
      protocol.request({ send: () => {} }, method, params, options),
    );
    client = createTestGatewayClient(wireRequest);
    const release = mount(retained);
    const automatic = refresh({ kind: "startup" });
    const catalog = automatic.catalog.catch((error: unknown) => error);
    protocol.handleResponse({
      type: "res",
      id: "catalog",
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Agent is preparing",
        retryable: true,
        details: { code: "agent-database-inspection-pending" },
        retryAfterMs: 250,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    retireChatMetadataRefresh(client, retained);
    release();
    await automatic.completed;
    expect(await catalog).toHaveProperty("name", "AbortError");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(wireRequest).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes compact commands independently of a failed catalog after a session patch", async () => {
    vi.useFakeTimers();
    const commandsRead = pending(empty);
    const catalog = pending({ models });
    const updates: ChatMetadataUpdate[] = [];
    request.mockReturnValue(commandsRead.promise);
    catalogRequest.mockReturnValue(catalog.promise);
    const commandsPublished = pending(empty);
    mount(retained, (update) => {
      updates.push(update);
      if (update.type === "result") {
        commandsPublished.resolve(update.result);
      }
    });
    sessionEvent({ reason: "patch", catalogChanged: true });
    const read = refresh();
    const catalogResult = read.catalog.catch((error: unknown) => error);
    expect(methods()).toEqual(["models.list", "chat.metadata"]);
    commandsRead.resolve(empty);
    await expect(commandsPublished.promise).resolves.toEqual(empty);
    expect(peekChatMetadata(client, retained)).toEqual(empty);
    const failure = new Error("Catalog unavailable");
    catalog.reject(failure);
    await read.completed;
    expect(await catalogResult).toBe(failure);
    expect(updates.filter((update) => update.type === "result")).toEqual([
      { type: "result", result: empty },
    ]);
    expect(wireRequest.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
    expect(peekModelCatalog(client, retained)).toBeUndefined();
  });

  it("admits metadata after a published catalog settles display before its wire responds", async () => {
    const catalog = pending({ models });
    catalogRequest.mockReturnValue(catalog.promise);
    mount(retained);
    const display = loadModelCatalog(client, retained);
    publishModelCatalogResult(beginModelCatalogRead(client, retained), retained, {
      models,
    });
    await expect(display).resolves.toEqual({ models });

    const read = refresh();
    await expect(read.catalog).resolves.toEqual({ models });
    await read.completed;
    expect(peekChatMetadata(client, retained)).toEqual(empty);
    expect(counts()).toEqual([1, 1]);
  });

  it("reuses metadata across concurrent presentations and route remounts until invalidated", async () => {
    let release = mount(retained);
    const first = refresh();
    const concurrent = refresh();
    await Promise.all([first.completed, concurrent.completed]);
    expect(request).toHaveBeenCalledTimes(1);
    release();

    release = mount(retained);
    await refresh().completed;
    expect(request).toHaveBeenCalledTimes(1);
    release();

    invalidateChatMetadataStore(client, retained);
    mount(retained);
    await refresh().completed;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { reason: "delete", sessionKey: retained.sessionKey },
    { reason: "delete", sessionKey: undefined },
    { reason: "cleanup", sessionKey: undefined },
  ])("retains agent commands before remount after $reason ($sessionKey)", async (event) => {
    const retiredCommands: ChatMetadataResult = {
      commands: [
        { name: "old", description: "", source: "native", scope: "text", acceptsArgs: false },
      ],
    };
    request.mockResolvedValueOnce(retiredCommands).mockResolvedValue(empty);
    const draft = { agentId: "main" };
    beginChatMetadataPublication(client, draft).publish(empty);
    const release = mount(retained);
    await refresh().completed;
    release();

    invalidateChatMetadataForSessionEvent(client, { ...event, agentId: "main" }, {});
    mount(retained);
    await refresh().completed;
    expect(request).toHaveBeenCalledTimes(1);
    expect(peekChatMetadata(client, retained)).toEqual(retiredCommands);
    expect(peekChatMetadata(client, draft)).toEqual(empty);
  });

  it("preserves a hidden startup fallback until remounted demand returns", async () => {
    const oldModels = [{ id: "old", name: "Old", provider: "test" }];
    const pendingCatalog = pending({ models });
    catalogRequest.mockReturnValueOnce(pendingCatalog.promise).mockResolvedValue({ models });
    let active = true;
    const release = mount(retained, undefined, () => active);
    beginChatMetadataPublication(client, retained);
    const startup = refresh({ kind: "startup" });
    active = false;
    const fallback = refresh({ kind: "metadata" });
    invalidateChatMetadataStore(client, retained);
    release();
    mount(retained, undefined, () => active);
    active = true;
    const visible = refresh();
    expect(counts()).toEqual([1, 2]);
    pendingCatalog.resolve({ models: oldModels });
    await Promise.all([startup.completed, fallback.completed, visible.completed]);
    expect(counts()).toEqual([1, 2]);
    expect(await visible.catalog).toEqual({ models });
  });

  it("loads the catalog beside missing commands after startup retired without dispatching", async () => {
    const oldCommands = pending(empty);
    const missingCommands = pending(empty);
    request.mockReturnValueOnce(oldCommands.promise).mockReturnValue(missingCommands.promise);
    let active = true;
    mount(retained, undefined, () => active);
    const explicit = revalidateChatMetadata(client, retained);
    beginChatMetadataPublication(client, retained);
    const startup = refresh({ kind: "startup" });
    active = false;
    oldCommands.resolve(empty);
    await Promise.all([explicit, startup.completed]);
    active = true;
    refresh({ kind: "metadata" });
    const visible = refresh();
    expect(counts()).toEqual([2, 1]);
    expect(await visible.catalog).toEqual({ models });
  });
});
