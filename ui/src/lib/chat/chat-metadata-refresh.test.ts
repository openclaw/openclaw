import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { beginModelCatalogRead, publishModelCatalogResult } from "../model-catalog-cache.ts";
import { loadModelCatalog, peekModelCatalog } from "../model-catalog-store.ts";
import {
  invalidateChatMetadataForSessionEvent,
  invalidateChatMetadataStore,
  type ChatMetadataResult,
  type ChatMetadataUpdate,
} from "./chat-metadata-cache.ts";
import {
  beginChatMetadataPublication,
  loadChatMetadataRefresh,
  peekChatMetadata,
  revalidateChatMetadata,
  retireChatMetadataRefresh,
  subscribeChatMetadata,
} from "./chat-metadata-store.ts";

const scope = { agentId: "main", sessionKey: "agent:main:retained" };
const commands: ChatMetadataResult = { commands: [] };
const models = [{ id: "fresh", name: "Fresh", provider: "test" }];
const releases: (() => void)[] = [];
const completions: Promise<unknown>[] = [];

function pending<T>(fallback: T) {
  const read = createDeferred<T>();
  releases.push(() => read.resolve(fallback));
  return read;
}

function refresh(
  client: Parameters<typeof loadChatMetadataRefresh>[0],
  options?: Parameters<typeof loadChatMetadataRefresh>[2],
) {
  const read = loadChatMetadataRefresh(client, scope, options);
  completions.push(read.completed);
  return read;
}

function metadataClient(
  metadataRead = vi.fn().mockResolvedValue(commands),
  catalogRead = vi.fn().mockResolvedValue({ models }),
) {
  const request = vi.fn((method: string) =>
    method === "chat.metadata" ? metadataRead() : catalogRead(),
  );
  return {
    client: createTestGatewayClient(request),
    request,
    metadataRead,
    counts: () => [metadataRead.mock.calls.length, catalogRead.mock.calls.length],
  };
}

function mount(
  client: Parameters<typeof subscribeChatMetadata>[0],
  active = () => true,
  listener: Parameters<typeof subscribeChatMetadata>[2] = () => {},
) {
  const release = subscribeChatMetadata(client, scope, listener, active);
  releases.push(release);
  return release;
}

function autoRefresh(client: Parameters<typeof subscribeChatMetadata>[0]) {
  const refreshes: ReturnType<typeof loadChatMetadataRefresh>[] = [];
  const release = subscribeChatMetadata(client, scope, (update) => {
    if (update.type === "invalidated") {
      refreshes.push(refresh(client));
    }
  });
  releases.push(release);
  return { settled: () => Promise.all(refreshes.map((read) => read.completed)) };
}

afterEach(async () => {
  for (const release of releases.splice(0).toReversed()) {
    release();
  }
  await Promise.allSettled(completions.splice(0));
  vi.useRealTimers();
});

describe("automatic metadata admission", () => {
  it("retains commands and catalogs across activity and refreshes one changed selection", async () => {
    vi.useFakeTimers();
    let sessionModelRevision = "selection-1";
    const { request, client } = metadataClient(
      undefined,
      vi.fn(async () => ({ models, sessionModelRevision })),
    );
    const { settled } = autoRefresh(client);
    const publish = (revision: string, catalogChanged = false) =>
      invalidateChatMetadataForSessionEvent(
        client,
        {
          ...scope,
          reason: "patch",
          ...(catalogChanged ? { catalogChanged: true } : {}),
          session: { key: scope.sessionKey, sessionModelRevision: revision },
        },
        {},
      );
    await refresh(client).completed;
    request.mockClear();
    for (let index = 0; index < 50; index++) {
      publish(sessionModelRevision, index % 2 === 0);
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(request).not.toHaveBeenCalled();
    sessionModelRevision = "selection-2";
    publish(sessionModelRevision, true);
    await settled();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["models.list"]);
    publish(sessionModelRevision);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request).toHaveBeenCalledOnce();
    expect(peekChatMetadata(client, scope)).toEqual(commands);
    expect(peekModelCatalog(client, scope)?.sessionModelRevision).toBe(sessionModelRevision);
  });

  it("hands a retiring automatic catalog to its foreground reader without replacing the read", async () => {
    const catalog = pending({ models });
    const request = vi
      .fn()
      .mockReturnValueOnce(catalog.promise)
      .mockRejectedValue(new Error("Unexpected replacement"));
    const client = createTestGatewayClient(request);
    mount(client);
    const automatic = refresh(client, { kind: "startup" });
    const automaticCatalog = automatic.catalog.catch((error: unknown) => error);
    retireChatMetadataRefresh(client, scope);
    const foreground = loadModelCatalog(client, scope);
    catalog.resolve({ models });
    await expect(foreground).resolves.toEqual({ models });
    await automatic.completed;
    expect(await automaticCatalog).toEqual({ models });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["patch", "command-metadata"])(
    "coalesces unrevisioned %s bursts and admits explicit catalog changes",
    async (reason) => {
      vi.useFakeTimers();
      const { request, client } = metadataClient();
      const { settled } = autoRefresh(client);
      await refresh(client).completed;
      request.mockClear();
      for (let index = 0; index < 5; index++) {
        invalidateChatMetadataForSessionEvent(client, { ...scope, reason }, {});
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await settled();
      expect(request.mock.calls.map(([method]) => method)).toEqual(["models.list"]);
      request.mockClear();
      invalidateChatMetadataForSessionEvent(client, { ...scope, reason }, {});
      expect(request).not.toHaveBeenCalled();
      invalidateChatMetadataForSessionEvent(client, { ...scope, reason, catalogChanged: true }, {});
      await settled();
      expect(request.mock.calls.map(([method]) => method)).toEqual(["models.list"]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels startup polling after a retired refresh loses its last subscriber", async () => {
    vi.useFakeTimers();
    const protocol = new GatewayPendingRequests({
      createRequestId: () => "catalog",
      nowMs: Date.now,
    });
    const request = createGatewayRequestMock((method, params, options) =>
      protocol.request({ send: () => {} }, method, params, options),
    );
    const client = createTestGatewayClient(request);
    const release = mount(client);
    const automatic = refresh(client, { kind: "startup" });
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
    retireChatMetadataRefresh(client, scope);
    release();
    await automatic.completed;
    expect(await catalog).toHaveProperty("name", "AbortError");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["ready", "failed"] as const)(
    "publishes compact commands independently of a %s catalog after a session patch",
    async (outcome) => {
      vi.useFakeTimers();
      const metadata = pending(commands);
      const catalog = pending({ models });
      const updates: ChatMetadataUpdate[] = [];
      const { request, client } = metadataClient(
        vi.fn(() => metadata.promise),
        vi.fn(() => catalog.promise),
      );
      const commandsPublished = pending(commands);
      mount(client, undefined, (update) => {
        updates.push(update);
        if (update.type === "result") {
          commandsPublished.resolve(update.result);
        }
      });
      invalidateChatMetadataForSessionEvent(
        client,
        { ...scope, reason: "patch", catalogChanged: true },
        {},
      );
      const read = refresh(client);
      const catalogResult = read.catalog.catch((error: unknown) => error);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "models.list",
        "chat.metadata",
      ]);
      metadata.resolve(commands);
      await expect(commandsPublished.promise).resolves.toEqual(commands);
      expect(peekChatMetadata(client, scope)).toEqual(commands);
      const failure = new Error("Catalog unavailable");
      if (outcome === "failed") {
        catalog.reject(failure);
      } else {
        catalog.resolve({ models });
      }
      await read.completed;
      expect(await catalogResult).toEqual(outcome === "failed" ? failure : { models });
      expect(updates.filter((update) => update.type === "result")).toEqual([
        { type: "result", result: commands },
      ]);
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
      expect(peekModelCatalog(client, scope)).toEqual(
        outcome === "failed" ? undefined : { models },
      );
    },
  );

  it("admits metadata after a published catalog settles display before its wire responds", async () => {
    const catalog = pending({ models });
    const { client, counts } = metadataClient(
      undefined,
      vi.fn(() => catalog.promise),
    );
    mount(client);
    const display = loadModelCatalog(client, scope);
    publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, { models });
    await expect(display).resolves.toEqual({ models });

    const read = refresh(client);
    await expect(read.catalog).resolves.toEqual({ models });
    await read.completed;
    expect(peekChatMetadata(client, scope)).toEqual(commands);
    expect(counts()).toEqual([1, 1]);
  });

  it("reuses metadata across concurrent presentations and route remounts until invalidated", async () => {
    const { client, metadataRead } = metadataClient();
    let release = mount(client);
    const first = refresh(client);
    const concurrent = refresh(client);
    await Promise.all([first.completed, concurrent.completed]);
    expect(metadataRead).toHaveBeenCalledTimes(1);
    release();

    release = mount(client);
    await refresh(client).completed;
    expect(metadataRead).toHaveBeenCalledTimes(1);
    release();

    invalidateChatMetadataStore(client, scope);
    mount(client);
    await refresh(client).completed;
    expect(metadataRead).toHaveBeenCalledTimes(2);
  });

  it.each([
    { reason: "delete", sessionKey: scope.sessionKey },
    { reason: "delete", sessionKey: undefined },
    { reason: "cleanup", sessionKey: undefined },
  ])("retains agent commands before remount after $reason ($sessionKey)", async (event) => {
    const retiredCommands: ChatMetadataResult = {
      commands: [
        { name: "old", description: "", source: "native", scope: "text", acceptsArgs: false },
      ],
    };
    const { client, metadataRead } = metadataClient(
      vi.fn().mockResolvedValueOnce(retiredCommands).mockResolvedValue(commands),
    );
    const draft = { agentId: "main" };
    beginChatMetadataPublication(client, draft).publish(commands);
    const release = mount(client);
    await refresh(client).completed;
    release();

    invalidateChatMetadataForSessionEvent(client, { ...event, agentId: "main" }, {});
    mount(client);
    await refresh(client).completed;
    expect(metadataRead).toHaveBeenCalledTimes(1);
    expect(peekChatMetadata(client, scope)).toEqual(retiredCommands);
    expect(peekChatMetadata(client, draft)).toEqual(commands);
  });

  it.each(["visible", "remounted"] as const)(
    "preserves a hidden startup fallback until %s demand returns",
    async (returning) => {
      const oldModels = [{ id: "old", name: "Old", provider: "test" }];
      const pendingCatalog = pending({ models });
      const { client, counts } = metadataClient(
        undefined,
        vi.fn().mockReturnValueOnce(pendingCatalog.promise).mockResolvedValue({ models }),
      );
      let active = true;
      const release = mount(client, () => active);
      beginChatMetadataPublication(client, scope);
      const startup = refresh(client, { kind: "startup" });
      active = false;
      const fallback = refresh(client, { kind: "metadata" });
      if (returning !== "visible") {
        invalidateChatMetadataStore(client, scope);
      }
      if (returning === "remounted") {
        release();
        mount(client, () => active);
      }
      active = true;
      const visible = refresh(client);
      expect(counts()).toEqual([1, returning === "visible" ? 1 : 2]);
      pendingCatalog.resolve({ models: oldModels });
      await Promise.all([startup.completed, fallback.completed, visible.completed]);
      expect(counts()).toEqual([1, returning === "visible" ? 1 : 2]);
      expect(await visible.catalog).toEqual({
        models: returning === "visible" ? oldModels : models,
      });
    },
  );

  it("replaces retired running commands when a follower startup omits metadata", async () => {
    const oldCommands = pending(commands);
    const pendingCatalog = pending({ models });
    const { client, counts } = metadataClient(
      vi.fn().mockReturnValueOnce(oldCommands.promise).mockResolvedValue(commands),
      vi.fn(() => pendingCatalog.promise),
    );
    mount(client);
    refresh(client);
    const publication = beginChatMetadataPublication(client, scope);
    refresh(client, { kind: "startup" });
    const fallback = refresh(client, {
      kind: "metadata",
      revalidateMetadata: () => publication.isCurrent(),
    });
    expect(counts()).toEqual([1, 1]);
    oldCommands.resolve(commands);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(counts()).toEqual([2, 1]);
    expect(peekChatMetadata(client, scope)).toEqual(commands);
    pendingCatalog.resolve({ models });
    await fallback.completed;
    expect(await fallback.catalog).toEqual({ models });
  });

  it("loads the catalog beside missing commands after startup retired without dispatching", async () => {
    const oldCommands = pending(commands);
    const missingCommands = pending(commands);
    const { client, counts } = metadataClient(
      vi.fn().mockReturnValueOnce(oldCommands.promise).mockReturnValue(missingCommands.promise),
    );
    let active = true;
    mount(client, () => active);
    const explicit = revalidateChatMetadata(client, scope);
    beginChatMetadataPublication(client, scope);
    const startup = refresh(client, { kind: "startup" });
    active = false;
    oldCommands.resolve(commands);
    await Promise.all([explicit, startup.completed]);
    active = true;
    refresh(client, { kind: "metadata" });
    const visible = refresh(client);
    expect(counts()).toEqual([2, 1]);
    expect(await visible.catalog).toEqual({ models });
  });
});
