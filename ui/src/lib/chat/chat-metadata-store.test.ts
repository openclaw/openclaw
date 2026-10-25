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
import { beginModelCatalogRead, publishModelCatalogResult } from "../model-catalog-cache.ts";
import { loadModelCatalog, peekModelCatalog } from "../model-catalog-store.ts";
import {
  invalidateChatMetadataForSessionEvent,
  invalidateChatMetadataStore,
  type ChatMetadataResult,
  type ChatMetadataResponse,
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
const startupError = {
  code: "UNAVAILABLE",
  message: "Agent is preparing",
  details: { code: "agent-database-inspection-pending" },
  retryable: true,
  retryAfterMs: 250,
};
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
const methods = () => wireRequest.mock.calls.map(([method]) => method);
const counts = () => [request.mock.calls.length, catalogRequest.mock.calls.length];
function autoRefresh(scope: Scope = retained, read = () => refresh().completed) {
  const reads: Promise<void>[] = [];
  const updates: string[] = [];
  mount(scope, (update) => {
    updates.push(update.type);
    if (update.type === "invalidated") {
      reads.push(read());
    }
  });
  return { updates, settled: () => Promise.all(reads) };
}
function holdMetadata() {
  const read = pending(metadata("current"));
  request.mockReturnValueOnce(read.promise);
  return read;
}
const publish = (result: ChatMetadataResponse, scope: Scope = retained) =>
  beginChatMetadataPublication(client, scope).publish(result);
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
const peek = (scope: Scope = agentScope) => peekChatMetadata(client, scope);
function mount(
  scope: Scope = agentScope,
  listener: Parameters<typeof subscribeChatMetadata>[2] = () => {},
  active = () => true,
) {
  const release = subscribeChatMetadata(client, scope, listener, active);
  releases.push(release);
  return release;
}
const startupPending = () => new GatewayRequestError(startupError);
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
  it.each([
    { reason: "patch", released: true, sessionKey: retained.sessionKey },
    { reason: "patch", sessionKey: retained.sessionKey },
    { reason: "reset", sessionKey: retained.sessionKey },
    { reason: "mark-read", catalogChanged: true, sessionKey: retained.sessionKey },
    { reason: "delete", sessionKey: retained.sessionKey },
    { reason: "delete" },
    { reason: "cleanup" },
  ])("preserves commands across $reason invalidation (%#)", async ({ released, ...event }) => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const release = mount(retained, listener);
    publish(metadata("active"));
    publish(empty, agentScope);
    await loadModelCatalog(client, retained);
    if (released) {
      release();
    }
    invalidateChatMetadataForSessionEvent(client, { agentId: "main", ...event }, {});
    if (!released && (event.reason !== "delete" || event.sessionKey)) {
      expect(listener).toHaveBeenLastCalledWith({
        type: "invalidated",
        scope: "session",
        refreshSessionFacts: true,
      });
    }
    expect(peekModelCatalog(client, retained)).toEqual(
      event.reason === "delete" && !event.sessionKey ? { models: [] } : undefined,
    );
    release();
    mount(retained);
    const read = load(retained);
    await vi.advanceTimersByTimeAsync(2_500);
    await read;
    expect(request).not.toHaveBeenCalled();
    expect([peek(retained), peek(agentScope)]).toEqual([metadata("active"), empty]);
  });

  it("revalidates compact commands by revision", async () => {
    const commands = {
      ...metadata("status"),
      revision: "commands-1",
      requiredWorkerInferenceProfileId: "worker-profile",
    };
    const legacy = {
      ...commands,
      models,
      accountSelection: { kind: "automatic", label: "Automatic" },
    } satisfies ChatMetadataResponse;
    request.mockResolvedValue({ unchanged: true, revision: commands.revision });
    mount(retained);
    expect(publish(legacy)).toEqual(commands);
    invalidateChatMetadataStore(client);
    expect(peek(retained)).toBeUndefined();
    await load(retained);
    expect(request).toHaveBeenCalledWith(
      "chat.metadata",
      expect.objectContaining({ ifRevision: "commands-1" }),
    );
    expect(peek(retained)).toEqual(commands);
    const changed = { ...metadata("new-command"), revision: "commands-2" };
    request.mockResolvedValue(changed);
    invalidateChatMetadataStore(client);
    await load(retained);
    expect(peek(retained)).toEqual(changed);
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
    first();
    expect(peek(scope)).toEqual(metadata("locked"));
    const lateStartup = beginChatMetadataPublication(client, scope);
    second();
    void lateStartup.publish(metadata("late"));
    expect(peek(scope)).toEqual(metadata("locked"));
    expect(peek()).toEqual(metadata("neutral"));
  });

  it("retries missing startup commands after a model-only publication", async () => {
    request.mockResolvedValue(metadata("recovered"));
    mount(retained);
    publish(metadata("previous"));
    expect(() => publish({ revision: "failed" })).toThrow("Chat commands are unavailable");
    expect(peek(retained)).toBeUndefined();
    invalidateChatMetadataStore(client, undefined, undefined, "refresh", {
      commandsChanged: false,
    });
    await load(retained);
    expect(peek(retained)).toEqual(metadata("recovered"));
  });

  it.each(["result", "error"])("retires stale %s across waves", async (outcome) => {
    const older = holdMetadata();
    const trailing = holdMetadata();
    request.mockResolvedValue(metadata("current"));
    const scope = { agentId: "main", sessionKey: "agent:main:locked" };
    const { updates, settled } = autoRefresh(scope, () => load(scope));
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
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    for (let index = 0; index < 8; index++) {
      invalidateChatMetadataStore(client);
    }
    expect(request).toHaveBeenCalledTimes(2);
    trailing.resolve(metadata("obsolete-trailing"));
    await settled();
    expect(request).toHaveBeenCalledTimes(3);
    expect(peek(scope)).toEqual(metadata("current"));
    expect(updates).not.toContain("error");
  });

  it.each(["shared", "invalidated", "queued"])("shares %s reentry", async (mode) => {
    const read = mode === "queued" ? load : revalidate;
    const older = holdMetadata();
    const newer = pending(metadata("current"));
    request.mockReturnValue(newer.promise);
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
    const initial = metadata(mode === "shared" ? "current" : "obsolete");
    older.resolve(initial);
    expect(await first).toEqual(read === load ? undefined : initial);
    if (mode !== "shared") {
      expect(peek()).toBeUndefined();
      newer.resolve(metadata("current"));
    }
    await expect(queued ?? following).resolves.toEqual(metadata("current"));
    expect(peek()).toEqual(metadata("current"));
    expect(request).toHaveBeenCalledTimes(mode === "shared" ? 1 : 2);
  });

  it.each(["error", "result"])("starts a fresh request from a %s observer", async (event) => {
    const failure = new GatewayRequestError({
      ...startupError,
      details: { reason: "database-busy" },
    });
    const next = pending(metadata("current"));
    const older = metadata("older");
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
    expect(peek()).toEqual(event === "result" ? older : undefined);
    next.resolve(metadata("current"));
    await expect(following).resolves.toEqual(metadata("current"));
    expect(peek()).toEqual(metadata("current"));
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
    expect(peek(mounted)).toEqual(metadata("cached"));
    expect(peek({ ...agentScope, sessionKey: "agent:main:0" })).toBeUndefined();
  });

  it("keeps startup publication authoritative over queued refreshes", async () => {
    mount(agentScope);
    const older = holdMetadata();
    const newer = holdMetadata();
    const olderLoad = load(agentScope);
    const newerLoad = revalidate(agentScope);
    publish(metadata("startup"), agentScope);
    older.resolve(metadata("old-model"));
    await olderLoad;
    expect(peek()).toEqual(metadata("startup"));
    newer.resolve(metadata("new-model"));
    await expect(newerLoad).resolves.toEqual(metadata("new-model"));
    expect(peek()).toEqual(metadata("startup"));
  });

  it.each(["closed-before", "ready", "closed-during"])("settles startup %s", async (outcome) => {
    vi.useFakeTimers();
    const older = holdMetadata();
    const fresh = metadata("fresh");
    request.mockRejectedValue(startupPending());
    const release = mount(retained);
    const oldRead = load(retained);
    const queued = revalidate(retained).catch((error: unknown) => error);
    release();
    const listener = vi.fn();
    const remount = outcome !== "closed-before";
    const releaseRemount = remount ? mount(retained, listener) : undefined;
    const remounted = remount ? load(retained) : undefined;
    older.resolve(metadata("obsolete"));
    await oldRead;
    await vi.advanceTimersByTimeAsync(0);
    if (remount) {
      await vi.advanceTimersByTimeAsync(182_499);
      expect(request).toHaveBeenCalledTimes(40);
    }
    if (outcome === "ready") {
      request.mockResolvedValue(fresh);
      await vi.advanceTimersByTimeAsync(1);
      expect(await queued).toEqual(fresh);
      expect(listener.mock.calls.filter(([update]) => update.type === "result")).toEqual([
        [{ type: "result", result: fresh }],
      ]);
      releaseRemount?.();
      expect(peek(retained)).toEqual(fresh);
    } else {
      releaseRemount?.();
      expect(await queued).toHaveProperty("name", "AbortError");
      await vi.advanceTimersByTimeAsync(180_000);
      expect(request).toHaveBeenCalledTimes(remount ? 40 : 1);
    }
    await remounted;
    expect(listener.mock.calls.some(([update]) => update.type === "error")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
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
    const { settled } = autoRefresh();
    const publishRevision = (revision: string, catalogChanged = false) =>
      sessionEvent({
        reason: "patch",
        ...(catalogChanged ? { catalogChanged: true } : {}),
        session: { key: retained.sessionKey, sessionModelRevision: revision },
      });
    await refresh().completed;
    wireRequest.mockClear();
    for (let index = 0; index < 50; index++) {
      publishRevision(sessionModelRevision, index % 2 === 0);
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(wireRequest).not.toHaveBeenCalled();
    sessionModelRevision = "selection-2";
    publishRevision(sessionModelRevision, true);
    await settled();
    expect(methods()).toEqual(["models.list"]);
    expect(peek(retained)).toEqual(empty);
    expect(peekModelCatalog(client, retained)?.sessionModelRevision).toBe(sessionModelRevision);
  });

  it("shares a published in-flight catalog with retired and concurrent readers", async () => {
    const catalog = pending({ models });
    catalogRequest
      .mockReturnValueOnce(catalog.promise)
      .mockRejectedValue(new Error("Unexpected replacement"));
    const release = mount(retained);
    const automatic = refresh({ kind: "startup" });
    retireChatMetadataRefresh(client, retained);
    const foreground = loadModelCatalog(client, retained);
    publishModelCatalogResult(beginModelCatalogRead(client, retained), retained, { models });
    await expect(automatic.catalog).resolves.toEqual({ models });
    await expect(foreground).resolves.toEqual({ models });
    await Promise.all([automatic.completed, refresh().completed, refresh().completed]);
    release();
    mount(retained);
    await refresh().completed;
    expect(counts()).toEqual([1, 1]);
    request.mockResolvedValue(metadata("changed"));
    invalidateChatMetadataStore(client, retained);
    await refresh().completed;
    expect(peek(retained)).toEqual(metadata("changed"));
    catalog.resolve({ models });
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
      error: startupError,
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
    request.mockReturnValue(commandsRead.promise);
    catalogRequest.mockReturnValue(catalog.promise);
    mount(retained);
    sessionEvent({ reason: "patch", catalogChanged: true });
    const read = refresh();
    const catalogResult = read.catalog.catch((error: unknown) => error);
    commandsRead.resolve(empty);
    await vi.waitFor(() => expect(peek(retained)).toEqual(empty));
    const failure = new Error("Catalog unavailable");
    catalog.reject(failure);
    await read.completed;
    expect(await catalogResult).toBe(failure);
    expect(peek(retained)).toEqual(empty);
    expect(peekModelCatalog(client, retained)).toBeUndefined();
  });

  it.each(["catalog", "commands"])("resumes hidden startup awaiting %s", async (owner) => {
    const pendingCatalog = pending({ models });
    const oldCommands = pending(empty);
    const missingCommands = pending(empty);
    if (owner === "catalog") {
      catalogRequest.mockReturnValueOnce(pendingCatalog.promise).mockResolvedValue({ models });
    } else {
      request.mockReturnValueOnce(oldCommands.promise).mockReturnValue(missingCommands.promise);
    }
    let active = true;
    const release = mount(retained, undefined, () => active);
    const explicit = owner === "commands" ? revalidateChatMetadata(client, retained) : undefined;
    beginChatMetadataPublication(client, retained);
    const startup = refresh({ kind: "startup" });
    active = false;
    if (owner === "commands") {
      oldCommands.resolve(empty);
      await Promise.all([explicit, startup.completed]);
      active = true;
    }
    const fallback = refresh({ kind: "metadata" });
    if (owner === "catalog") {
      invalidateChatMetadataStore(client, retained);
      release();
      mount(retained, undefined, () => active);
    }
    active = true;
    const visible = refresh();
    pendingCatalog.resolve({ models: [{ id: "old", name: "Old", provider: "test" }] });
    missingCommands.resolve(empty);
    await Promise.all([startup.completed, fallback.completed, visible.completed]);
    expect(counts()).toEqual(owner === "catalog" ? [1, 2] : [2, 1]);
    expect(await visible.catalog).toEqual({ models });
  });
});
