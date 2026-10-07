import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { invalidateModelCatalogCache } from "../model-catalog-cache.ts";
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

function clientWith(request: ReturnType<typeof vi.fn>): GatewayBrowserClient {
  return { request } as unknown as GatewayBrowserClient;
}

function metadata(name: string): ChatMetadataResult {
  return {
    commands: [{ name, description: name, source: "native", scope: "text", acceptsArgs: false }],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("chat metadata store", () => {
  it("publishes compact commands while an invalidated queued catalog is pending", async () => {
    vi.useFakeTimers();
    const older = deferred<{ models: [] }>();
    const current = deferred<{ models: [] }>();
    const catalogs = vi.fn().mockReturnValueOnce(older.promise).mockReturnValue(current.promise);
    const client = clientWith(
      vi.fn((method: string) =>
        method === "models.list" ? catalogs() : Promise.resolve(metadata("current")),
      ),
    );
    const scope = { agentId: "main", sessionKey: "agent:main:current" };
    const listener = vi.fn();
    const release = subscribeChatMetadata(client, scope, listener);
    const retired = loadModelCatalog(client, scope).catch(() => undefined);
    invalidateModelCatalogCache(client, scope);
    const queued = loadModelCatalog(client, scope);
    invalidateChatMetadataForSessionEvent(client, { ...scope, reason: "patch" }, {});
    older.reject(new Error("Old catalog unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(catalogs).toHaveBeenCalledTimes(2);
    const read = loadChatMetadata(client, scope);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(listener.mock.calls.filter(([update]) => update.type === "result")).toEqual([
        [{ type: "result", result: metadata("current") }],
      ]);
      await expect(read).resolves.toEqual(metadata("current"));
      current.resolve({ models: [] });
      await Promise.all([read, queued]);
      expect(listener).toHaveBeenLastCalledWith({ type: "result", result: metadata("current") });
      expect(peekModelCatalog(client, scope)).toBeUndefined();
      await expect(loadModelCatalog(client, scope)).resolves.toEqual({ models: [] });
      expect(peekModelCatalog(client, scope)).toEqual({ models: [] });
      expect(listener.mock.calls.filter(([update]) => update.type === "result")).toHaveLength(1);
    } finally {
      current.resolve({ models: [] });
      await Promise.all([read, retired, queued]);
      release();
    }
  });

  it("invalidates subscribed catalogs with their aliases and detailed views after a session patch", async () => {
    const client = clientWith(vi.fn().mockResolvedValue({ models: [] }));
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
    const release = subscribeChatMetadata(client, scope, () => {});
    beginChatMetadataPublication(client, scope).publish(metadata("active"));
    beginChatMetadataPublication(client, alias).publish(metadata("inactive"));
    await Promise.all([scope, alias, detailed].map((params) => loadModelCatalog(client, params)));
    invalidateChatMetadataForSessionEvent(client, { ...scope, reason: "patch" }, defaults);
    expect(peekModelCatalog(client, scope)).toBeUndefined();
    expect(peekModelCatalog(client, alias)).toBeUndefined();
    expect(peekModelCatalog(client, detailed)).toBeUndefined();
    release();
  });

  it.each(["before", "after"])(
    "invalidates catalogs when the last subscriber leaves %s a patch",
    async (timing) => {
      const oldModel = { id: "old", name: "Old", provider: "example" };
      const newModel = { ...oldModel, id: "new", name: "New" };
      const request = vi
        .fn()
        .mockResolvedValueOnce({ models: [oldModel] })
        .mockResolvedValue({ models: [newModel] });
      const client = clientWith(request);
      const scope = { agentId: "main", sessionKey: "agent:main:released" };
      const release = subscribeChatMetadata(client, scope, () => {});
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
      const client = clientWith(vi.fn().mockResolvedValue({ models: [] }));
      const scope = { agentId: "main", sessionKey: "agent:main:current" };
      const other = { agentId: "main", sessionKey: "agent:main:other" };
      const listener = vi.fn();
      const release = subscribeChatMetadata(client, scope, listener);
      beginChatMetadataPublication(client, scope).publish(metadata("before"));
      await Promise.all([loadModelCatalog(client, scope), loadModelCatalog(client, other)]);
      const sessionOnly = !catalogChanged && (reason === "patch" || reason === "command-metadata");
      invalidateChatMetadataForSessionEvent(client, { ...scope, reason, catalogChanged }, {});
      expect(listener).toHaveBeenLastCalledWith({
        type: "invalidated",
        scope: sessionOnly ? "session" : "full",
        refreshSessionFacts: sessionOnly,
      });
      expect(peekChatMetadata(client, scope)).toBeUndefined();
      expect(peekModelCatalog(client, scope)).toBeUndefined();
      expect(peekModelCatalog(client, other)).toEqual({ models: [] });
      release();
    },
  );

  it("requests compact metadata and keeps startup models out of the commands cache", async () => {
    const commands = metadata("status");
    const legacy = {
      ...commands,
      models: [{ id: "old", name: "Old", provider: "example" }],
      accountSelection: { kind: "automatic", label: "Automatic" },
    } satisfies ChatMetadataResponse;
    const request = vi.fn().mockResolvedValue(commands);
    const client = clientWith(request);
    beginChatMetadataPublication(client, { agentId: "main" }).publish(legacy);
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(commands);
    invalidateChatMetadataStore(client);
    expect(await loadChatMetadata(client, { agentId: "main" })).toEqual(commands);
    expect(request).toHaveBeenCalledWith("chat.metadata", {
      agentId: "main",
      includeModels: false,
    });
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(commands);
  });

  it.each([
    { sessionKey: "agent:main:locked" },
    { authProfileId: "personal:person-a:anthropic:one" },
  ])("isolates selected metadata %j and retires unmounted writers", async (selection) => {
    const client = clientWith(vi.fn().mockResolvedValue(metadata("neutral")));
    const scope = { agentId: "main", ...selection };
    const first = subscribeChatMetadata(client, scope, () => {});
    const second = subscribeChatMetadata(client, scope, () => {});
    beginChatMetadataPublication(client, scope).publish(metadata("locked"));
    await loadChatMetadata(client, { agentId: "main" });
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(metadata("neutral"));
    expect(peekChatMetadata(client, scope)).toEqual(metadata("locked"));
    first();
    expect(peekChatMetadata(client, scope)).toEqual(metadata("locked"));
    const lateStartup = beginChatMetadataPublication(client, scope);
    second();
    void lateStartup.publish(metadata("late"));
    expect(peekChatMetadata(client, scope)).toEqual(metadata("locked"));
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(metadata("neutral"));
  });

  it.each(["result", "error"])(
    "coalesces invalidations while retiring stale startup and read %s publications",
    async (outcome) => {
      const older = deferred<ChatMetadataResult>();
      const replacement = metadata("current");
      const request = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(replacement);
      const client = clientWith(request);
      const scope = { agentId: "main", sessionKey: "agent:main:locked" };
      const updates: string[] = [];
      const refreshes: Promise<ChatMetadataResult>[] = [];
      const unsubscribe = subscribeChatMetadata(client, scope, (update) => {
        updates.push(update.type);
        if (update.type === "invalidated") {
          refreshes.push(loadChatMetadata(client, scope));
        }
      });
      const startup = beginChatMetadataPublication(client, scope);
      const oldRead = loadChatMetadata(client, scope).catch(() => undefined);
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
      expect(peekChatMetadata(client, scope)).toEqual(replacement);
      expect(updates).not.toContain("error");
      expect(request).toHaveBeenLastCalledWith("chat.metadata", { ...scope, includeModels: false });
      unsubscribe();
    },
  );

  it.each(
    [
      { kind: "load", read: loadChatMetadata },
      { kind: "revalidation", read: revalidateChatMetadata },
    ].flatMap(({ kind, read }) => [false, true].map((invalidate) => ({ kind, read, invalidate }))),
  )(
    "shares the current $kind during loading observer reentry (invalidate=$invalidate)",
    async ({ read, invalidate }) => {
      const older = deferred<ChatMetadataResult>();
      const newer = deferred<ChatMetadataResult>();
      const request = invalidate
        ? vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
        : vi.fn().mockReturnValue(older.promise);
      const client = clientWith(request);
      const scope = { agentId: "main" };
      let observed = false;
      let following: Promise<ChatMetadataResult> | undefined;
      const unsubscribe = subscribeChatMetadata(client, scope, (update) => {
        if (update.type === "loading" && !observed) {
          observed = true;
          if (invalidate) {
            invalidateChatMetadataStore(client, scope);
          }
          following = read(client, scope);
        }
      });
      const first = read(client, scope);
      try {
        expect(following).toBeDefined();
        expect(read(client, scope)).toBe(following);
        if (!invalidate) {
          expect(following).toBe(first);
        }
        expect(request).toHaveBeenCalledOnce();
        older.resolve(metadata(invalidate ? "obsolete" : "current"));
        await first;
        if (invalidate) {
          expect(peekChatMetadata(client, scope)).toBeUndefined();
          expect(request).toHaveBeenCalledTimes(2);
          newer.resolve(metadata("current"));
        }
        await expect(following).resolves.toEqual(metadata("current"));
        expect(peekChatMetadata(client, scope)).toEqual(metadata("current"));
        expect(request).toHaveBeenCalledTimes(invalidate ? 2 : 1);
      } finally {
        older.resolve(metadata("obsolete"));
        newer.resolve(metadata("current"));
        await Promise.allSettled([first, following]);
        unsubscribe();
      }
    },
  );

  describe.each([
    { kind: "load", read: loadChatMetadata },
    { kind: "revalidation", read: revalidateChatMetadata },
  ])("$kind publication boundaries", ({ read }) => {
    it.each([new Error("metadata failed"), undefined])(
      "lets an error observer start a fresh request after %s",
      async (failure) => {
        const request = vi
          .fn()
          .mockRejectedValueOnce(failure)
          .mockResolvedValue(metadata("current"));
        const client = clientWith(request);
        const scope = { agentId: "main" };
        let retry: Promise<ChatMetadataResult> | undefined;
        const unsubscribe = subscribeChatMetadata(client, scope, (update) => {
          if (update.type === "error" && !retry) {
            retry = read(client, scope);
          }
        });
        const first = read(client, scope);
        try {
          await expect(first).rejects.toBe(failure);
          await expect(retry).resolves.toEqual(metadata("current"));
          expect(request).toHaveBeenCalledTimes(2);
          expect(peekChatMetadata(client, scope)).toEqual(metadata("current"));
        } finally {
          await Promise.allSettled([first, retry]);
          unsubscribe();
        }
      },
    );
  });

  it("starts a fresh revalidation requested by a result observer", async () => {
    const next = deferred<ChatMetadataResult>();
    const older = metadata("older");
    const current = metadata("current");
    const request = vi.fn().mockResolvedValueOnce(older).mockReturnValue(next.promise);
    const client = clientWith(request);
    const scope = { agentId: "main" };
    let following: Promise<ChatMetadataResult> | undefined;
    const release = subscribeChatMetadata(client, scope, (update) => {
      if (update.type === "result" && !following) {
        following = revalidateChatMetadata(client, scope);
      }
    });
    const first = revalidateChatMetadata(client, scope);
    try {
      await expect(first).resolves.toEqual(older);
      expect(request).toHaveBeenCalledTimes(2);
      expect(peekChatMetadata(client, scope)).toEqual(older);
      next.resolve(current);
      await expect(following).resolves.toEqual(current);
      expect(peekChatMetadata(client, scope)).toEqual(current);
    } finally {
      next.resolve(current);
      await Promise.allSettled([first, following]);
      release();
    }
  });

  it("bounds inactive session metadata without evicting a mounted conversation", async () => {
    const request = vi.fn().mockResolvedValue(metadata("cached"));
    const client = clientWith(request);
    const mounted = { agentId: "main", sessionKey: "agent:main:mounted" };
    const release = subscribeChatMetadata(client, mounted, () => {});
    await loadChatMetadata(client, mounted);
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
    release();
  });

  it("keeps the stale snapshot readable while one fresh revalidation replaces it", async () => {
    const oldResult = metadata("old-model");
    const nextResult = metadata("next-model");
    const refresh = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValue(refresh.promise);
    const client = clientWith(request);
    beginChatMetadataPublication(client, { agentId: "main" }).publish(oldResult);

    const first = revalidateChatMetadata(client, { agentId: "main" });
    const second = revalidateChatMetadata(client, { agentId: "main" });

    expect(second).toBe(first);
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(oldResult);
    expect(request).toHaveBeenCalledOnce();
    refresh.resolve(nextResult);
    await expect(first).resolves.toEqual(nextResult);
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(nextResult);
  });

  it.each([false, true])(
    "retires an older plain load while preserving the newest writer (startup=%s)",
    async (startup) => {
      const older = deferred<ChatMetadataResult>();
      const newer = deferred<ChatMetadataResult>();
      const request = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      const client = clientWith(request);
      const scope = { agentId: "main" };
      const olderLoad = loadChatMetadata(client, scope);
      const newerLoad = revalidateChatMetadata(client, scope);
      if (startup) {
        beginChatMetadataPublication(client, scope).publish(metadata("startup"));
      }
      expect.soft(request).toHaveBeenCalledOnce();
      older.resolve(metadata("old-model"));
      await expect(olderLoad).resolves.toEqual(metadata("old-model"));
      expect(peekChatMetadata(client, scope)).toEqual(startup ? metadata("startup") : undefined);
      newer.resolve(metadata("new-model"));
      await expect(newerLoad).resolves.toEqual(metadata("new-model"));
      expect(peekChatMetadata(client, scope)).toEqual(metadata(startup ? "startup" : "new-model"));
    },
  );

  it("coalesces another invalidation wave while the trailing read is active", async () => {
    const first = deferred<ChatMetadataResult>();
    const second = deferred<ChatMetadataResult>();
    const current = metadata("current");
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(current);
    const client = clientWith(request);
    const scope = { agentId: "main" };
    const reads: Promise<ChatMetadataResult>[] = [];
    const unsubscribe = subscribeChatMetadata(client, scope, (update) => {
      if (update.type === "invalidated") {
        reads.push(loadChatMetadata(client, scope));
      }
    });
    reads.push(loadChatMetadata(client, scope));
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
    expect(peekChatMetadata(client, scope)).toEqual(current);
    unsubscribe();
  });

  it("retains active ownership across selected-scope unsubscribe and remount", async () => {
    const older = deferred<ChatMetadataResult>();
    const fresh = metadata("fresh");
    const request = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(fresh);
    const client = clientWith(request);
    const scope = { agentId: "main", sessionKey: "agent:main:remounted" };
    const release = subscribeChatMetadata(client, scope, () => {});
    const oldRead = loadChatMetadata(client, scope);
    const queuedRead = revalidateChatMetadata(client, scope);
    release();
    const listener = vi.fn();
    const releaseRemount = subscribeChatMetadata(client, scope, listener);
    const remountedRead = loadChatMetadata(client, scope);
    expect.soft(request).toHaveBeenCalledOnce();
    older.resolve(metadata("obsolete"));
    await Promise.all([oldRead, queuedRead, remountedRead]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.filter(([update]) => update.type === "result")).toEqual([
      [{ type: "result", result: fresh }],
    ]);
    releaseRemount();
    expect(peekChatMetadata(client, scope)).toEqual(fresh);
  });

  it.each([false, true])(
    "retires queued startup demand at last unsubscribe (remount=%s)",
    async (remount) => {
      vi.useFakeTimers();
      const older = deferred<ChatMetadataResult>();
      const fresh = metadata("fresh");
      const request = vi
        .fn()
        .mockReturnValueOnce(older.promise)
        .mockRejectedValue(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Agent is preparing",
            retryable: true,
            details: { code: "agent-database-inspection-pending" },
            retryAfterMs: 250,
          }),
        );
      const client = clientWith(request);
      const scope = { agentId: "main", sessionKey: "agent:main:queued-startup" };
      const release = subscribeChatMetadata(client, scope, () => {});
      const oldRead = loadChatMetadata(client, scope);
      const queued = revalidateChatMetadata(client, scope).catch((error: unknown) => error);
      release();
      const listener = vi.fn();
      const releaseRemount = remount ? subscribeChatMetadata(client, scope, listener) : undefined;
      const remounted = remount ? loadChatMetadata(client, scope) : undefined;
      try {
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
      } finally {
        request.mockResolvedValue(fresh);
        older.resolve(metadata("obsolete"));
        releaseRemount?.();
        await vi.advanceTimersByTimeAsync(5_000);
        await Promise.allSettled([oldRead, queued, remounted]);
      }
    },
  );

  it("reserves the active request before loading listeners request another refresh", async () => {
    const older = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(metadata("fresh"));
    const client = clientWith(request);
    const scope = { agentId: "main" };
    const reads: Promise<ChatMetadataResult>[] = [];
    let reentered = false;
    const release = subscribeChatMetadata(client, scope, (update) => {
      if (update.type === "loading" && !reentered) {
        reentered = true;
        reads.push(loadChatMetadata(client, scope), revalidateChatMetadata(client, scope));
      }
    });
    const first = loadChatMetadata(client, scope);
    expect.soft(request).toHaveBeenCalledOnce();
    expect(reads[0]).toBe(first);
    older.resolve(metadata("old"));
    await Promise.all([first, ...reads]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(peekChatMetadata(client, scope)).toEqual(metadata("fresh"));
    release();
  });

  it("does not retry metadata revalidation failures", async () => {
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "database temporarily unavailable",
        details: { reason: "database-busy" },
        retryable: true,
        retryAfterMs: 250,
      }),
    );
    const client = clientWith(request);

    await expect(revalidateChatMetadata(client, { agentId: "main" })).rejects.toThrow(
      "database temporarily unavailable",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["ready", "released"] as const)(
    "keeps agent startup metadata pending for minutes until %s",
    async (outcome) => {
      vi.useFakeTimers();
      const starting = new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Agent main is still preparing its database.",
        details: { code: "agent-database-inspection-pending", agentId: "main" },
        retryable: true,
        retryAfterMs: 250,
      });
      const request = vi.fn().mockRejectedValue(starting);
      const client = clientWith(request);
      const scope = { agentId: "main" };
      const updates: string[] = [];
      const release = subscribeChatMetadata(client, scope, (update) => updates.push(update.type));
      const result = revalidateChatMetadata(client, scope).catch((error: unknown) => error);
      try {
        await vi.advanceTimersByTimeAsync(182_499);
        expect(request).toHaveBeenCalledTimes(39);
        expect(updates).not.toContain("error");
        if (outcome === "ready") {
          request.mockResolvedValue(metadata("ready"));
          await vi.advanceTimersByTimeAsync(1);
          expect(await result).toEqual(metadata("ready"));
          expect(peekChatMetadata(client, scope)).toEqual(metadata("ready"));
        } else {
          release();
          expect(await result).toHaveProperty("name", "AbortError");
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release();
        await result;
      }
    },
  );
});
