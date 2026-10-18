import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
  type GatewayRequestMock,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { loadModelCatalog, peekModelCatalog } from "../model-catalog-store.ts";
import {
  invalidateChatMetadataForSessionEvent,
  invalidateChatMetadataStore,
  type ChatMetadataResult,
  type ChatMetadataResponse,
} from "./chat-metadata-cache.ts";
import {
  loadChatMetadata,
  peekChatMetadata,
  beginChatMetadataPublication,
  revalidateChatMetadata,
  subscribeChatMetadata,
} from "./chat-metadata-store.ts";

const agentScope = { agentId: "main" };
type Scope = Parameters<typeof loadChatMetadata>[1];
const releases: (() => void)[] = [];
const pendingReads: Promise<unknown>[] = [];
let request: GatewayRequestMock;
let client: GatewayBrowserClient;
beforeEach(() => {
  request = vi.fn<GatewayRequestHandler>();
  client = createTestGatewayClient(request);
});

function pendingMetadata() {
  const result = deferred<ChatMetadataResult>();
  releases.push(() => result.resolve(metadata("current")));
  return result;
}

function load(scope: Scope = agentScope) {
  const result = loadChatMetadata(client, scope);
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
) {
  const release = subscribeChatMetadata(client, scope, listener);
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
      request
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
      expect(request).toHaveBeenCalledTimes(2);
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
    beginChatMetadataPublication(client, scope).publish(legacy);
    expect(peek(scope)).toEqual(commands);
    invalidateChatMetadataStore(client);
    expect(peek(scope)).toBeUndefined();
    expect(await load(scope)).toEqual(commands);
    expect(request).toHaveBeenCalledWith("chat.metadata", {
      agentId: "main",
      includeModels: false,
      ifRevision: "commands-1",
    });
    expect(peek(scope)).toEqual(commands);
    const changed = { ...metadata("new-command"), revision: "commands-2" };
    request.mockResolvedValue(changed);
    invalidateChatMetadataStore(client);
    expect(await load(scope)).toEqual(changed);
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
    await loadChatMetadata(client, { agentId: "main" });
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
    beginChatMetadataPublication(client, scope).publish(metadata("previous"));
    expect(() =>
      beginChatMetadataPublication(client, scope).publish({ revision: "failed" }),
    ).toThrow("Chat commands are unavailable");
    expect(peek(scope)).toBeUndefined();
    invalidateChatMetadataStore(client, undefined, undefined, "refresh", false);
    expect(await load(scope)).toEqual(metadata("recovered"));
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
      const refreshes: Promise<ChatMetadataResult>[] = [];
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
    let following: Promise<ChatMetadataResult> | undefined;
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
    expect(read()).toBe(queued ?? following);
    if (mode !== "invalidated") {
      expect(following).toBe(first);
    }
    expect(request).toHaveBeenCalledOnce();
    const initial = metadata(mode === "shared" ? "current" : "obsolete");
    older.resolve(initial);
    await expect(first).resolves.toEqual(initial);
    if (mode !== "shared") {
      expect(peek()).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(2);
      newer.resolve(metadata("current"));
    }
    await expect(queued ?? following).resolves.toEqual(metadata("current"));
    expect(peek()).toEqual(metadata("current"));
    expect(request).toHaveBeenCalledTimes(mode === "shared" ? 1 : 2);
  });

  it.each([
    ...[load, revalidate].flatMap((read) =>
      [new Error("metadata failed"), undefined].map((failure) => ({
        read,
        failure,
        event: "error",
      })),
    ),
    { read: revalidate, failure: undefined, event: "result" },
  ])("starts a fresh request from a $event observer (%#)", async ({ read, failure, event }) => {
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
        following = read();
      }
    });
    const first = read();
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
      await loadChatMetadata(client, { agentId: "main", sessionKey: `agent:main:${index}` });
    }

    expect(peekChatMetadata(client, mounted)).toEqual(metadata("cached"));
    expect(
      peekChatMetadata(client, { agentId: "main", sessionKey: "agent:main:0" }),
    ).toBeUndefined();
    const recent = { agentId: "main", sessionKey: "agent:main:69" };
    await loadChatMetadata(client, recent);
    expect(request).toHaveBeenCalledTimes(71);
  });

  it.each([false, true])(
    "retires an older plain load while preserving the newest writer (startup=%s)",
    async (startup) => {
      const scope = agentScope;
      const older = pendingMetadata();
      const newer = pendingMetadata();
      request.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      const olderLoad = load(scope);
      const newerLoad = revalidate(scope);
      if (startup) {
        beginChatMetadataPublication(client, scope).publish(metadata("startup"));
      }
      expect.soft(request).toHaveBeenCalledOnce();
      older.resolve(metadata("old-model"));
      await expect(olderLoad).resolves.toEqual(metadata("old-model"));
      expect(peek(scope)).toEqual(startup ? metadata("startup") : undefined);
      newer.resolve(metadata("new-model"));
      await expect(newerLoad).resolves.toEqual(metadata("new-model"));
      expect(peek(scope)).toEqual(metadata(startup ? "startup" : "new-model"));
    },
  );

  it("coalesces another invalidation wave while the trailing read is active", async () => {
    const scope = agentScope;
    const first = pendingMetadata();
    const second = pendingMetadata();
    const current = metadata("current");
    request
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(current);
    const reads: Promise<ChatMetadataResult>[] = [];
    mount(scope, (update) => {
      if (update.type === "invalidated") {
        reads.push(load(scope));
      }
    });
    reads.push(load(scope));
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
    expect(peek(scope)).toEqual(current);
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
        expect(await remounted).toEqual(fresh);
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
      const scope = agentScope;
      vi.useFakeTimers();
      request.mockRejectedValue(startupPending());
      const updates: string[] = [];
      const release = mount(scope, (update) => updates.push(update.type));
      const result = revalidate(scope).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(182_499);
      expect(request).toHaveBeenCalledTimes(39);
      expect(updates).not.toContain("error");
      if (outcome === "ready") {
        request.mockResolvedValue(metadata("ready"));
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toEqual(metadata("ready"));
        expect(peek(scope)).toEqual(metadata("ready"));
      } else {
        release();
        expect(await result).toHaveProperty("name", "AbortError");
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
