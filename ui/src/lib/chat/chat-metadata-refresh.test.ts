import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  invalidateChatMetadataForSessionEvent,
  invalidateChatMetadataStore,
  type ChatMetadataResult,
} from "./chat-metadata-cache.ts";
import {
  beginChatMetadataPublication,
  loadChatMetadata,
  loadChatMetadataRefresh,
  peekChatMetadata,
  revalidateChatMetadata,
  subscribeChatMetadata,
} from "./chat-metadata-store.ts";

const scope = { agentId: "main", sessionKey: "agent:main:retained" };
const commands: ChatMetadataResult = { commands: [] };
const models = [{ id: "fresh", name: "Fresh", provider: "test" }];

afterEach(() => vi.useRealTimers());

describe("automatic metadata admission", () => {
  it.each(["visible", "hidden", "released", "global invalidation"])(
    "coalesces session patches and rechecks admission when %s",
    async (transition) => {
      vi.useFakeTimers();
      const request = vi.fn(async (method: string) =>
        method === "chat.metadata" ? commands : { models },
      );
      const client = createTestGatewayClient(request);
      let active = true;
      const refreshes: ReturnType<typeof loadChatMetadataRefresh>[] = [];
      const release = subscribeChatMetadata(
        client,
        scope,
        (update) => {
          if (update.type === "invalidated") {
            refreshes.push(loadChatMetadataRefresh(client, scope));
          }
        },
        () => active,
      );
      await loadChatMetadataRefresh(client, scope).completed;
      request.mockClear();
      for (let index = 0; index < 5; index++) {
        invalidateChatMetadataForSessionEvent(client, { ...scope, reason: "patch" }, {});
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(request).not.toHaveBeenCalled();
      if (transition === "hidden") {
        active = false;
      } else if (transition === "released") {
        release();
      } else if (transition === "global invalidation") {
        invalidateChatMetadataStore(client);
        expect(request).toHaveBeenCalledWith("chat.metadata", scope);
      }
      await vi.advanceTimersByTimeAsync(2_500);
      await Promise.all(refreshes.map((refresh) => refresh.completed));
      const admitted = transition === "visible" || transition === "global invalidation";
      expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(
        admitted ? 1 : 0,
      );
      if (transition === "hidden") {
        active = true;
        await loadChatMetadataRefresh(client, scope).completed;
        expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(1);
      }
      release();
      expect(vi.getTimerCount()).toBe(0);
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
    { reason: "create", sessionKey: scope.sessionKey },
    { reason: "new", sessionKey: scope.sessionKey },
    { reason: "recovery", sessionKey: scope.sessionKey },
    { reason: "delete", sessionKey: undefined },
    { reason: "cleanup", sessionKey: undefined },
  ])("retires cached sessions before remount after $reason ($sessionKey)", async (event) => {
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
    expect(metadataReads).toBe(2);
    expect(peekChatMetadata(client, scope)).toEqual(commands);
    expect(peekChatMetadata(client, draft)).toEqual(commands);
    release();
  });

  it.each(["metadata", "catalog"] as const)(
    "rechecks hidden demand after both producers settle with %s first",
    async (first) => {
      const oldCommands = createDeferred<ChatMetadataResult>();
      const oldCatalog = createDeferred<{ models: typeof models }>();
      let metadataReads = 0;
      let catalogReads = 0;
      const client = createTestGatewayClient((method) => {
        if (method === "chat.metadata") {
          return ++metadataReads === 1 ? oldCommands.promise : Promise.resolve(commands);
        }
        return ++catalogReads === 1 ? oldCatalog.promise : Promise.resolve({ models });
      });
      let active = true;
      const release = subscribeChatMetadata(
        client,
        scope,
        () => {},
        () => active,
      );
      const original = loadChatMetadataRefresh(client, scope);
      invalidateChatMetadataStore(client, scope);
      const successor = loadChatMetadataRefresh(client, scope);
      active = false;
      try {
        if (first === "metadata") {
          oldCommands.resolve(commands);
        } else {
          oldCatalog.resolve({ models });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        expect([metadataReads, catalogReads]).toEqual([1, 1]);
        oldCommands.resolve(commands);
        oldCatalog.resolve({ models });
        await Promise.all([original.completed, successor.completed]);
        expect([metadataReads, catalogReads]).toEqual([1, 1]);
        active = true;
        const visible = loadChatMetadataRefresh(client, scope);
        await visible.completed;
        expect(await visible.catalog).toEqual({ models });
        expect([metadataReads, catalogReads]).toEqual([2, 2]);
      } finally {
        oldCommands.resolve(commands);
        oldCatalog.resolve({ models });
        await Promise.all([original.completed, successor.completed]);
        release();
      }
    },
  );

  it.each(["visible", "invalidated", "remounted"] as const)(
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

  it.each(["visible metadata", "hidden metadata", "catalog only"] as const)(
    "adopts an existing queued command only for current %s demand",
    async (demand) => {
      const oldCommands = createDeferred<ChatMetadataResult>();
      const queuedCommands = createDeferred<ChatMetadataResult>();
      const oldCatalog = createDeferred<{ models: typeof models }>();
      const currentCommands: ChatMetadataResult = {
        commands: [
          {
            name: "current",
            description: "Current",
            source: "native",
            scope: "text",
            acceptsArgs: false,
          },
        ],
      };
      let metadataReads = 0;
      let catalogReads = 0;
      const client = createTestGatewayClient((method) => {
        if (method === "chat.metadata") {
          metadataReads += 1;
          return metadataReads === 1
            ? oldCommands.promise
            : metadataReads === 2
              ? queuedCommands.promise
              : Promise.resolve(currentCommands);
        }
        return ++catalogReads === 1 ? oldCatalog.promise : Promise.resolve({ models });
      });
      let active = true;
      const published: ChatMetadataResult[] = [];
      const release = subscribeChatMetadata(
        client,
        scope,
        (update) => {
          if (update.type === "result") {
            published.push(update.result);
          }
        },
        () => active,
      );
      const options = demand === "catalog only" ? { kind: "startup" as const } : undefined;
      const original = loadChatMetadataRefresh(client, scope, options);
      const explicit = demand === "catalog only" ? loadChatMetadata(client, scope) : undefined;
      const queued = revalidateChatMetadata(client, scope);
      const replacements = [];
      active = demand !== "hidden metadata";
      for (let index = 0; index < 5; index++) {
        invalidateChatMetadataStore(client, scope);
        replacements.push(loadChatMetadataRefresh(client, scope, options));
      }
      try {
        expect([metadataReads, catalogReads]).toEqual([1, 1]);
        oldCommands.resolve(commands);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        expect([metadataReads, catalogReads]).toEqual([2, 1]);
        queuedCommands.resolve(currentCommands);
        await queued;
        const accepted = demand === "visible metadata";
        expect(peekChatMetadata(client, scope)).toEqual(accepted ? currentCommands : undefined);
        expect(published).toEqual(accepted ? [currentCommands] : []);
        expect([metadataReads, catalogReads]).toEqual([2, 1]);
        oldCatalog.resolve({ models });
        await Promise.all(replacements.map((refresh) => refresh.completed));
        expect([metadataReads, catalogReads]).toEqual([2, active ? 2 : 1]);
      } finally {
        oldCommands.resolve(commands);
        queuedCommands.resolve(currentCommands);
        oldCatalog.resolve({ models });
        await Promise.all([
          original.completed,
          explicit,
          queued,
          ...replacements.map((refresh) => refresh.completed),
        ]);
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
