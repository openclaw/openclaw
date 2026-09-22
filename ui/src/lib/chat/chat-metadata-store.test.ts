import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  gatewayStartupUnavailableDetails,
} from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { invalidateChatMetadataStore, type ChatMetadataResult } from "./chat-metadata-cache.ts";
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

function startupUnavailableError(retryAfterMs = 250): GatewayRequestError {
  return new GatewayRequestError({
    code: "UNAVAILABLE",
    message: "gateway startup sidecars are still initializing",
    details: gatewayStartupUnavailableDetails(),
    retryable: true,
    retryAfterMs,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("chat metadata store", () => {
  it("keeps legacy startup and RPC models out of the commands cache", async () => {
    const commands = metadata("status");
    const legacy = {
      ...commands,
      models: [{ id: "old", name: "Old", provider: "example" }],
      accountSelection: { kind: "automatic", label: "Automatic" },
    };
    const client = clientWith(vi.fn().mockResolvedValue(legacy));
    beginChatMetadataPublication(client, { agentId: "main" }).publish(legacy);
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(commands);
    invalidateChatMetadataStore(client);
    expect(await loadChatMetadata(client, { agentId: "main" })).toEqual(commands);
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
    lateStartup.publish(metadata("late"));
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
      startup.publish(metadata("obsolete-startup"));
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
      expect(request).toHaveBeenLastCalledWith("chat.metadata", scope);
      unsubscribe();
    },
  );

  it("returns a cached result without requesting it again", async () => {
    const result = metadata("cached-model");
    const request = vi.fn().mockResolvedValue(result);
    const client = clientWith(request);

    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toEqual(result);
    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toEqual(result);

    expect(request).toHaveBeenCalledOnce();
  });

  it("shares one pending load between concurrent readers", async () => {
    const pending = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const client = clientWith(request);

    const first = loadChatMetadata(client, { agentId: "main" });
    const second = loadChatMetadata(client, { agentId: "main" });

    expect(second).toBe(first);
    expect(request).toHaveBeenCalledOnce();
    pending.resolve(metadata("shared-model"));
    await expect(first).resolves.toEqual(metadata("shared-model"));
  });

  it.each([
    { kind: "load", read: loadChatMetadata },
    { kind: "revalidation", read: revalidateChatMetadata },
  ])("keeps the replacement $kind pending after reentrant invalidation", async ({ read }) => {
    const older = deferred<ChatMetadataResult>();
    const newer = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const client = clientWith(request);
    const scope = { agentId: "main" };
    let invalidated = false;
    let replacement: Promise<ChatMetadataResult> | undefined;
    const unsubscribe = subscribeChatMetadata(client, scope, (update) => {
      if (update.type === "loading" && !invalidated) {
        invalidated = true;
        invalidateChatMetadataStore(client, scope);
        replacement = read(client, scope);
      }
    });
    const first = read(client, scope);
    try {
      expect(replacement).toBeDefined();
      const following = read(client, scope);
      expect(following).toBe(replacement);
      expect(request).toHaveBeenCalledOnce();
      older.resolve(metadata("obsolete"));
      await first;
      expect(peekChatMetadata(client, scope)).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(2);
      newer.resolve(metadata("current"));
      await expect(following).resolves.toEqual(metadata("current"));
      expect(peekChatMetadata(client, scope)).toEqual(metadata("current"));
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      older.resolve(metadata("obsolete"));
      newer.resolve(metadata("current"));
      await Promise.allSettled([first, replacement]);
      unsubscribe();
    }
  });

  describe.each([
    { kind: "load", read: loadChatMetadata },
    { kind: "revalidation", read: revalidateChatMetadata },
  ])("$kind publication boundaries", ({ read }) => {
    it("lets a loading observer share the active request", async () => {
      const pending = deferred<ChatMetadataResult>();
      const request = vi.fn().mockReturnValue(pending.promise);
      const client = clientWith(request);
      const scope = { agentId: "main" };
      let observed = false;
      let following: Promise<ChatMetadataResult> | undefined;
      const unsubscribe = subscribeChatMetadata(client, scope, (update) => {
        if (update.type === "loading" && !observed) {
          observed = true;
          following = read(client, scope);
        }
      });
      const first = read(client, scope);
      try {
        expect(request).toHaveBeenCalledOnce();
        pending.resolve(metadata("current"));
        await expect(following).resolves.toEqual(metadata("current"));
        await first;
      } finally {
        pending.resolve(metadata("current"));
        await Promise.allSettled([first, following]);
        unsubscribe();
      }
    });

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

  it("clears a failed pending load so a later read can retry", async () => {
    const result = metadata("recovered-model");
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("metadata unavailable"))
      .mockResolvedValueOnce(result);
    const client = clientWith(request);

    await expect(loadChatMetadata(client, { agentId: "main" })).rejects.toThrow(
      "metadata unavailable",
    );
    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toEqual(result);

    expect(request).toHaveBeenCalledTimes(2);
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

  it("uses remembered startup metadata as the current snapshot", async () => {
    const result = metadata("startup-model");
    const request = vi.fn();
    const client = clientWith(request);

    beginChatMetadataPublication(client, { agentId: "main" }).publish(result);

    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(result);
    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toEqual(result);
    expect(request).not.toHaveBeenCalled();
  });

  it("notifies subscribers across publication and invalidation", () => {
    const client = clientWith(vi.fn());
    const listener = vi.fn();
    const unsubscribe = subscribeChatMetadata(client, { agentId: "main" }, listener);

    beginChatMetadataPublication(client, { agentId: "main" }).publish(metadata("first-model"));
    invalidateChatMetadataStore(client);
    beginChatMetadataPublication(client, { agentId: "main" }).publish(metadata("second-model"));

    expect(listener.mock.calls.filter(([update]) => update.type !== "loading")).toHaveLength(3);
    unsubscribe();
    beginChatMetadataPublication(client, { agentId: "main" }).publish(metadata("ignored-model"));
    expect(listener.mock.calls.filter(([update]) => update.type !== "loading")).toHaveLength(3);
  });

  it("keeps a ready snapshot after its last subscriber releases", async () => {
    const result = metadata("cached-after-release");
    const request = vi.fn();
    const client = clientWith(request);
    const unsubscribe = subscribeChatMetadata(client, { agentId: "main" }, () => undefined);
    beginChatMetadataPublication(client, { agentId: "main" }).publish(result);

    unsubscribe();

    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(result);
    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toEqual(result);
    expect(request).not.toHaveBeenCalled();
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

  it("drops every agent snapshot when the client store is invalidated", async () => {
    const main = metadata("main-model");
    const worker = metadata("worker-model");
    const request = vi.fn().mockResolvedValue(main);
    const client = clientWith(request);
    beginChatMetadataPublication(client, { agentId: "main" }).publish(main);
    beginChatMetadataPublication(client, { agentId: "worker" }).publish(worker);

    invalidateChatMetadataStore(client);

    expect(peekChatMetadata(client, { agentId: "main" })).toBeUndefined();
    expect(peekChatMetadata(client, { agentId: "worker" })).toBeUndefined();
    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toEqual(main);
    expect(request).toHaveBeenCalledOnce();
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

  it("does not let an older plain load clobber a newer revalidation", async () => {
    const older = deferred<ChatMetadataResult>();
    const newer = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const client = clientWith(request);

    const olderLoad = loadChatMetadata(client, { agentId: "main" });
    const newerLoad = revalidateChatMetadata(client, { agentId: "main" });
    expect.soft(request).toHaveBeenCalledOnce();
    older.resolve(metadata("old-model"));
    await expect(olderLoad).resolves.toEqual(metadata("old-model"));
    expect(peekChatMetadata(client, { agentId: "main" })).toBeUndefined();
    newer.resolve(metadata("new-model"));
    await expect(newerLoad).resolves.toEqual(metadata("new-model"));

    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(metadata("new-model"));
  });

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

  it("keeps newer startup publication authoritative while active and queued reads settle", async () => {
    const older = deferred<ChatMetadataResult>();
    const newer = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const client = clientWith(request);
    const scope = { agentId: "main" };
    const oldRead = loadChatMetadata(client, scope);
    const queuedRead = revalidateChatMetadata(client, scope);
    beginChatMetadataPublication(client, scope).publish(metadata("startup"));
    expect.soft(request).toHaveBeenCalledOnce();
    older.resolve(metadata("old"));
    await oldRead;
    newer.resolve(metadata("queued"));
    await queuedRead;
    expect(peekChatMetadata(client, scope)).toEqual(metadata("startup"));
  });

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

  it("keeps queued startup revalidation within its original retry window", async () => {
    vi.useFakeTimers();
    const older = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(metadata("late"));
    const client = clientWith(request);
    const scope = { agentId: "main" };
    const first = loadChatMetadata(client, scope);
    const refresh = revalidateChatMetadata(client, scope, { startupRetryWindowMs: 250 });
    const expired = expect(refresh).rejects.toThrow("New-session metadata retry deadline elapsed");
    await vi.advanceTimersByTimeAsync(250);
    await expired;
    expect(request).toHaveBeenCalledOnce();
    older.resolve(metadata("old"));
    await first;
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries canonical startup unavailability and caches the recovered commands", async () => {
    vi.useFakeTimers();
    const result = metadata("recovered-model");
    const request = vi
      .fn()
      .mockRejectedValueOnce(startupUnavailableError(250))
      .mockResolvedValueOnce(result);
    const client = clientWith(request);

    const refresh = revalidateChatMetadata(
      client,
      { agentId: "main" },
      {
        startupRetryWindowMs: 60_000,
      },
    );
    await vi.advanceTimersByTimeAsync(249);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(refresh).resolves.toEqual(result);
    expect(request).toHaveBeenCalledTimes(2);
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(result);
  });

  it("does not retry unrelated retryable unavailable errors", async () => {
    vi.useFakeTimers();
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

    const refresh = revalidateChatMetadata(
      client,
      { agentId: "main" },
      {
        startupRetryWindowMs: 60_000,
      },
    );
    const rejection = expect(refresh).rejects.toThrow("database temporarily unavailable");
    await vi.advanceTimersByTimeAsync(2_000);

    await rejection;
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops startup retries at the configured deadline", async () => {
    vi.useFakeTimers();
    const startedAt = Date.UTC(2026, 7, 2);
    vi.setSystemTime(startedAt);
    const attemptTimes: number[] = [];
    const request = vi.fn().mockImplementation(() => {
      attemptTimes.push(Date.now());
      return Promise.reject(startupUnavailableError(2_000));
    });
    const client = clientWith(request);
    const refresh = revalidateChatMetadata(
      client,
      { agentId: "main" },
      {
        startupRetryWindowMs: 60_000,
      },
    );
    const rejection = expect(refresh).rejects.toThrow("gateway startup sidecars");

    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;

    expect(attemptTimes).toHaveLength(30);
    expect(attemptTimes[0]).toBe(startedAt);
    expect(attemptTimes.at(-1)).toBe(startedAt + 58_000);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "chat.metadata",
      { agentId: "main" },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
    expect(request).toHaveBeenLastCalledWith(
      "chat.metadata",
      { agentId: "main" },
      { timeoutMs: 2_000 },
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
