import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { loadModelCatalog, peekModelCatalog } from "../model-catalog-store.ts";
import {
  invalidateChatMetadataForSessionEvent,
  invalidateChatMetadataStore,
  type ChatMetadataResult,
  type ChatMetadataUpdate,
} from "./chat-metadata-cache.ts";
import {
  beginChatMetadataPublication,
  loadChatMetadata,
  loadChatMetadataRefresh,
  peekChatMetadata,
  retireChatMetadataRefresh,
  subscribeChatMetadata,
} from "./chat-metadata-store.ts";

const scope = { agentId: "main", sessionKey: "agent:main:retained" };
const commands: ChatMetadataResult = { commands: [] };
const models = [{ id: "fresh", name: "Fresh", provider: "test" }];

afterEach(() => vi.useRealTimers());

describe("automatic metadata admission", () => {
  it("retains commands and catalogs across activity and refreshes one changed selection", async () => {
    vi.useFakeTimers();
    let sessionModelRevision = "selection-1";
    const request = vi.fn(async (method: string) =>
      method === "chat.metadata" ? commands : { models, sessionModelRevision },
    );
    const client = createTestGatewayClient(request);
    const refreshes: ReturnType<typeof loadChatMetadataRefresh>[] = [];
    const release = subscribeChatMetadata(client, scope, (update) => {
      if (update.type === "invalidated") {
        refreshes.push(loadChatMetadataRefresh(client, scope));
      }
    });
    const publish = (revision: string) =>
      invalidateChatMetadataForSessionEvent(
        client,
        {
          ...scope,
          reason: "patch",
          session: { key: scope.sessionKey, sessionModelRevision: revision },
        },
        {},
      );
    try {
      await loadChatMetadataRefresh(client, scope).completed;
      request.mockClear();
      for (let index = 0; index < 50; index++) {
        publish(sessionModelRevision);
        await vi.advanceTimersByTimeAsync(3_000);
      }
      expect(request).not.toHaveBeenCalled();
      sessionModelRevision = "selection-2";
      publish(sessionModelRevision);
      await Promise.all(refreshes.map((refresh) => refresh.completed));
      expect(request.mock.calls.map(([method]) => method)).toEqual(["models.list"]);
      publish(sessionModelRevision);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(request).toHaveBeenCalledOnce();
      expect(peekChatMetadata(client, scope)).toEqual(commands);
      expect(peekModelCatalog(client, scope)?.sessionModelRevision).toBe(sessionModelRevision);
    } finally {
      release();
    }
  });

  it("hands a retiring automatic catalog to its foreground reader without replacing the read", async () => {
    const pending = createDeferred<{ models: typeof models }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValue(new Error("Unexpected replacement"));
    const client = createTestGatewayClient(request);
    const release = subscribeChatMetadata(client, scope, () => {});
    const automatic = loadChatMetadataRefresh(client, scope, { kind: "startup" });
    const automaticCatalog = automatic.catalog.catch((error: unknown) => error);
    retireChatMetadataRefresh(client, scope);
    const foreground = loadModelCatalog(client, scope);
    pending.resolve({ models });
    try {
      await expect(foreground).resolves.toEqual({ models });
      await automatic.completed;
      expect(await automaticCatalog).toEqual({ models });
      expect(request).toHaveBeenCalledOnce();
    } finally {
      release();
      await automatic.completed;
    }
  });

  it.each(["patch", "command-metadata"])(
    "coalesces unrevisioned %s bursts and admits explicit catalog changes",
    async (reason) => {
      vi.useFakeTimers();
      const request = vi.fn(async (method: string) =>
        method === "chat.metadata" ? commands : { models },
      );
      const client = createTestGatewayClient(request);
      const refreshes: ReturnType<typeof loadChatMetadataRefresh>[] = [];
      const release = subscribeChatMetadata(client, scope, (update) => {
        if (update.type === "invalidated") {
          refreshes.push(loadChatMetadataRefresh(client, scope));
        }
      });
      try {
        await loadChatMetadataRefresh(client, scope).completed;
        request.mockClear();
        for (let index = 0; index < 5; index++) {
          invalidateChatMetadataForSessionEvent(client, { ...scope, reason }, {});
          await vi.advanceTimersByTimeAsync(500);
        }
        expect(request).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_000);
        await Promise.all(refreshes.map((refresh) => refresh.completed));
        expect(request.mock.calls.map(([method]) => method)).toEqual(["models.list"]);
        request.mockClear();
        invalidateChatMetadataForSessionEvent(client, { ...scope, reason }, {});
        expect(request).not.toHaveBeenCalled();
        invalidateChatMetadataForSessionEvent(
          client,
          { ...scope, reason, catalogChanged: true },
          {},
        );
        await Promise.all(refreshes.map((refresh) => refresh.completed));
        expect(request.mock.calls.map(([method]) => method)).toEqual(["models.list"]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release();
      }
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
    const release = subscribeChatMetadata(client, scope, () => {});
    const automatic = loadChatMetadataRefresh(client, scope, { kind: "startup" });
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
      const metadata = createDeferred<ChatMetadataResult>();
      const catalog = createDeferred<{ models: typeof models }>();
      const updates: ChatMetadataUpdate[] = [];
      const request = vi.fn((method: string) =>
        method === "chat.metadata" ? metadata.promise : catalog.promise,
      );
      const client = createTestGatewayClient(request);
      const release = subscribeChatMetadata(client, scope, (update) => updates.push(update));
      invalidateChatMetadataForSessionEvent(
        client,
        { ...scope, reason: "patch", catalogChanged: true },
        {},
      );
      const refresh = loadChatMetadataRefresh(client, scope);
      const catalogResult = refresh.catalog.catch((error: unknown) => error);
      try {
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "models.list",
          "chat.metadata",
        ]);
        const commandsRead = loadChatMetadata(client, scope);
        metadata.resolve(commands);
        await expect(commandsRead).resolves.toEqual(commands);
        expect(peekChatMetadata(client, scope)).toEqual(commands);
        const failure = new Error("Catalog unavailable");
        if (outcome === "failed") {
          catalog.reject(failure);
        } else {
          catalog.resolve({ models });
        }
        await refresh.completed;
        expect(await catalogResult).toEqual(outcome === "failed" ? failure : { models });
        expect(updates.filter((update) => update.type === "result")).toEqual([
          { type: "result", result: commands },
        ]);
        expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
        expect(peekModelCatalog(client, scope)).toEqual(
          outcome === "failed" ? undefined : { models },
        );
      } finally {
        metadata.resolve(commands);
        catalog.resolve({ models });
        await refresh.completed;
        release();
      }
    },
  );

  it("reuses metadata across concurrent presentations and route remounts until invalidated", async () => {
    let metadataReads = 0;
    const client = createTestGatewayClient((method) => {
      if (method === "chat.metadata") {
        metadataReads += 1;
        return Promise.resolve(commands);
      }
      return Promise.resolve({ models });
    });
    let release = subscribeChatMetadata(client, scope, () => {});
    const first = loadChatMetadataRefresh(client, scope);
    const concurrent = loadChatMetadataRefresh(client, scope);
    await Promise.all([first.completed, concurrent.completed]);
    expect(metadataReads).toBe(1);
    release();

    release = subscribeChatMetadata(client, scope, () => {});
    await loadChatMetadataRefresh(client, scope).completed;
    expect(metadataReads).toBe(1);
    release();

    invalidateChatMetadataStore(client, scope);
    release = subscribeChatMetadata(client, scope, () => {});
    await loadChatMetadataRefresh(client, scope).completed;
    expect(metadataReads).toBe(2);
    release();
  });

  it.each([
    { reason: "delete", sessionKey: scope.sessionKey },
    { reason: "delete", sessionKey: undefined },
    { reason: "cleanup", sessionKey: undefined },
  ])("retains agent commands before remount after $reason ($sessionKey)", async (event) => {
    const retiredCommands: ChatMetadataResult = {
      commands: [
        {
          name: "retired",
          description: "Retired",
          source: "native",
          scope: "text",
          acceptsArgs: false,
        },
      ],
    };
    let metadataReads = 0;
    const client = createTestGatewayClient((method) => {
      if (method === "chat.metadata") {
        metadataReads += 1;
        return Promise.resolve(metadataReads === 1 ? retiredCommands : commands);
      }
      return Promise.resolve({ models });
    });
    const draft = { agentId: "main" };
    beginChatMetadataPublication(client, draft).publish(commands);
    let release = subscribeChatMetadata(client, scope, () => {});
    await loadChatMetadataRefresh(client, scope).completed;
    release();

    invalidateChatMetadataForSessionEvent(client, { ...event, agentId: "main" }, {});
    release = subscribeChatMetadata(client, scope, () => {});
    await loadChatMetadataRefresh(client, scope).completed;
    expect(metadataReads).toBe(1);
    expect(peekChatMetadata(client, scope)).toEqual(retiredCommands);
    expect(peekChatMetadata(client, draft)).toEqual(commands);
    release();
  });

  it.each(["visible", "remounted"] as const)(
    "preserves a hidden startup fallback until %s demand returns",
    async (returning) => {
      const oldModels = [{ id: "old", name: "Old", provider: "test" }];
      const pendingCatalog = createDeferred<{ models: typeof models }>();
      let metadataReads = 0;
      let catalogReads = 0;
      const client = createTestGatewayClient((method) => {
        if (method === "chat.metadata") {
          metadataReads += 1;
          return Promise.resolve(commands);
        }
        return ++catalogReads === 1 ? pendingCatalog.promise : Promise.resolve({ models });
      });
      let active = true;
      let release = subscribeChatMetadata(
        client,
        scope,
        () => {},
        () => active,
      );
      beginChatMetadataPublication(client, scope);
      const startup = loadChatMetadataRefresh(client, scope, { kind: "startup" });
      active = false;
      const fallback = loadChatMetadataRefresh(client, scope, { kind: "metadata" });
      if (returning !== "visible") {
        invalidateChatMetadataStore(client, scope);
      }
      if (returning === "remounted") {
        release();
        release = subscribeChatMetadata(
          client,
          scope,
          () => {},
          () => active,
        );
      }
      active = true;
      const visible = loadChatMetadataRefresh(client, scope);
      try {
        expect([metadataReads, catalogReads]).toEqual([returning === "visible" ? 1 : 0, 1]);
        pendingCatalog.resolve({ models: oldModels });
        await Promise.all([startup.completed, fallback.completed, visible.completed]);
        expect([metadataReads, catalogReads]).toEqual([1, returning === "visible" ? 1 : 2]);
        expect(await visible.catalog).toEqual({
          models: returning === "visible" ? oldModels : models,
        });
      } finally {
        pendingCatalog.resolve({ models: oldModels });
        await Promise.all([startup.completed, fallback.completed, visible.completed]);
        release();
      }
    },
  );

  it("replaces retired running commands when a follower startup omits metadata", async () => {
    const oldCommands = createDeferred<ChatMetadataResult>();
    const pendingCatalog = createDeferred<{ models: typeof models }>();
    let metadataReads = 0;
    let catalogReads = 0;
    const client = createTestGatewayClient((method) => {
      if (method === "chat.metadata") {
        return ++metadataReads === 1 ? oldCommands.promise : Promise.resolve(commands);
      }
      catalogReads += 1;
      return pendingCatalog.promise;
    });
    const release = subscribeChatMetadata(client, scope, () => {});
    const original = loadChatMetadataRefresh(client, scope);
    const publication = beginChatMetadataPublication(client, scope);
    const startup = loadChatMetadataRefresh(client, scope, { kind: "startup" });
    const fallback = loadChatMetadataRefresh(client, scope, {
      kind: "metadata",
      revalidateMetadata: () => publication.isCurrent(),
    });
    try {
      expect([metadataReads, catalogReads]).toEqual([1, 1]);
      oldCommands.resolve(commands);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect([metadataReads, catalogReads]).toEqual([2, 1]);
      expect(peekChatMetadata(client, scope)).toEqual(commands);
      pendingCatalog.resolve({ models });
      await fallback.completed;
      expect(await fallback.catalog).toEqual({ models });
    } finally {
      oldCommands.resolve(commands);
      pendingCatalog.resolve({ models });
      await Promise.all([original.completed, startup.completed, fallback.completed]);
      release();
    }
  });

  it("loads the catalog beside missing commands after startup retired without dispatching", async () => {
    const oldCommands = createDeferred<ChatMetadataResult>();
    const missingCommands = createDeferred<ChatMetadataResult>();
    let metadataReads = 0;
    let catalogReads = 0;
    const client = createTestGatewayClient((method) => {
      if (method === "chat.metadata") {
        return ++metadataReads === 1 ? oldCommands.promise : missingCommands.promise;
      }
      catalogReads += 1;
      return Promise.resolve({ models });
    });
    let active = true;
    const release = subscribeChatMetadata(
      client,
      scope,
      () => {},
      () => active,
    );
    const explicit = loadChatMetadata(client, scope);
    beginChatMetadataPublication(client, scope);
    const startup = loadChatMetadataRefresh(client, scope, { kind: "startup" });
    active = false;
    oldCommands.resolve(commands);
    await Promise.all([explicit, startup.completed]);
    active = true;
    const fallback = loadChatMetadataRefresh(client, scope, { kind: "metadata" });
    const visible = loadChatMetadataRefresh(client, scope);
    try {
      expect([metadataReads, catalogReads]).toEqual([2, 1]);
      expect(await visible.catalog).toEqual({ models });
    } finally {
      missingCommands.resolve(commands);
      await Promise.all([fallback.completed, visible.completed]);
      release();
    }
  });
});
