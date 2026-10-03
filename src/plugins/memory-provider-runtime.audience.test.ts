// Native memory providers and delegated audiences against real session lineage:
// SQLite rows, worker reads, and generation leases through the registered slot owner.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { assertMemoryAudienceCurrent, delegateMemoryAudience } from "./memory-audience.js";
import {
  AUDIENCE_CHILD_KEY,
  AUDIENCE_ROOT_KEY,
  NATIVE_PROVIDER_ID,
  childMemoryContext,
  withChildAudience,
  withNativeMemoryProvider,
} from "./memory-provider-runtime.audience.test-support.js";
import type {
  MemoryAudience,
  MemoryCallerContext,
  MemoryProviderHandle,
} from "./memory-provider-types.js";
import { getActiveMemoryProviderCore } from "./memory-runtime.js";

// Partitions records by the supplied audience and, as documented, calls
// `context.assertCurrent()` immediately before each read.
function partitionedProvider(
  context: MemoryCallerContext,
  reads: string[],
  beforeRead: () => Promise<void> = async () => {},
): MemoryProviderHandle {
  const audience = context.authority.kind === "session" ? context.authority.audience : undefined;
  return {
    capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: false },
    search: async () => {
      await beforeRead();
      context.assertCurrent();
      reads.push(audience?.kind ?? "none");
      return {
        hits: audience
          ? [{ reference: { providerId: NATIVE_PROVIDER_ID, id: audience.kind }, excerpt: "fact" }]
          : [],
      };
    },
    get: async () => ({ status: "not_found" }),
    health: async () => ({ status: "ready" }),
    close: async () => {},
  };
}

it.each(["child reset", "parent lifecycle change"] as const)(
  "refuses a native provider's own pre-I/O guard after a %s mid-call",
  async (change) => {
    await withChildAudience(true, async ({ audience, root, child, write }) => {
      const reachedRead = createDeferredCore();
      const releaseRead = createDeferredCore();
      const reads: string[] = [];
      const openProvider = (context: MemoryCallerContext) =>
        partitionedProvider(context, reads, async () => {
          reachedRead.resolve();
          await releaseRead.promise;
        });
      await withNativeMemoryProvider(openProvider, async () => {
        const { provider } = await getActiveMemoryProviderCore({
          cfg: {},
          agentId: "main",
          context: childMemoryContext(audience),
        });
        const search = provider!.search({ query: "orders" });
        await reachedRead.promise;
        if (change === "child reset") {
          write(AUDIENCE_CHILD_KEY, { ...child, sessionId: randomUUID(), updatedAt: 2 });
        } else {
          write(AUDIENCE_ROOT_KEY, { ...root, lifecycleRevision: randomUUID(), updatedAt: 2 });
        }
        releaseRead.resolve();
        await expect(search).rejects.toThrow("memory audience is no longer current");
        expect(reads).toEqual([]);
        await provider!.close();
      });
    });
  },
);

it("gives a conversation caller its host-minted conversation audience at open", async () => {
  await withChildAudience(false, async ({ audience, root }) => {
    expect(audience).toEqual({
      kind: "conversation",
      agentId: "main",
      sessionKey: AUDIENCE_ROOT_KEY,
      sessionId: root.sessionId,
    });
    const reads: string[] = [];
    const opened: Array<MemoryAudience | undefined> = [];
    const openProvider = (context: MemoryCallerContext) => {
      opened.push(context.authority.kind === "session" ? context.authority.audience : undefined);
      return partitionedProvider(context, reads);
    };
    await withNativeMemoryProvider(openProvider, async () => {
      const { provider } = await getActiveMemoryProviderCore({
        cfg: {},
        agentId: "main",
        context: childMemoryContext(audience),
      });
      const page = await provider!.search({ query: "orders" });
      expect(page.hits.map((entry) => entry.reference.id)).toEqual(["conversation"]);
      expect(opened).toEqual([audience]);
      await provider!.close();
    });
  });
});

it("binds delegated child incarnations to committed session rows", async () => {
  await withChildAudience(true, async ({ audience, root, write, storePath }) => {
    const recallKey = "agent:main:root:active-memory:recall";
    const recall = { sessionId: "recall-session", updatedAt: 1 };
    write(recallKey, recall);
    const delegated = await delegateMemoryAudience(audience, { sessionKey: recallKey, storePath });
    const detachedKey = "agent:main:root:memory-flush:detached";
    const detached = await delegateMemoryAudience(audience, {
      sessionKey: detachedKey,
      storePath,
      detached: true,
    });
    try {
      // Same-incarnation writes keep every grant current.
      write(AUDIENCE_ROOT_KEY, { ...root, updatedAt: 2 });
      write(recallKey, { ...recall, updatedAt: 2 });
      assertMemoryAudienceCurrent(delegated.audience);
      assertMemoryAudienceCurrent(detached.audience);

      // Resetting the delegated child revokes only the delegate.
      write(recallKey, { ...recall, sessionId: "recall-replacement", updatedAt: 3 });
      expect(() => assertMemoryAudienceCurrent(delegated.audience)).toThrow("no longer current");
      assertMemoryAudienceCurrent(audience);

      // A detached child binds its row's absence; a claimed key revokes the delegate.
      write(detachedKey, { sessionId: "claimed", updatedAt: 1 });
      expect(() => assertMemoryAudienceCurrent(detached.audience)).toThrow("no longer current");
    } finally {
      detached.release();
      delegated.release();
    }
  });
});
