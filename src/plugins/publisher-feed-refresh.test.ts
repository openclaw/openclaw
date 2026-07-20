import { describe, expect, it, vi } from "vitest";
import { refreshPublisherFeedState } from "./publisher-feed-refresh.js";
import type {
  PublisherFeedStateStore,
  StoredPublisherFeedState,
} from "./publisher-feed-state-store.js";
import { PublisherFeedChangeTraversalLimitError } from "./publisher-feed-transport.js";

const verification = {
  signedBy: "clawhub-feed-2026-q3",
  signedByKeyIds: ["clawhub-feed-2026-q3"],
  signatureCount: 1,
  threshold: 1,
};

function state(sequence: number) {
  return {
    feedId: "clawhub.publisher.publishers:alice",
    sequence,
    generatedAt: "2026-07-16T00:00:00.000Z",
    publisherId: "publishers:alice",
    handle: "alice",
    displayName: "Alice",
    entries: [],
  };
}

function memoryStore(initial: StoredPublisherFeedState | null = null) {
  let current = initial;
  const store: PublisherFeedStateStore = {
    read: vi.fn(async () => current),
    write: vi.fn(async (record) => {
      current = record;
    }),
  };
  return { store, current: () => current };
}

const target = {
  baseUrl: "https://clawhub.ai",
  publisherId: "publishers:alice",
  verification: { trustedKeys: [] },
};

describe("publisher feed durable refresh", () => {
  it("initializes from a complete signed snapshot", async () => {
    const memory = memoryStore();
    const result = await refreshPublisherFeedState({
      ...target,
      publisherId: "  publishers:alice  ",
      store: memory.store,
      now: () => new Date("2026-07-16T00:01:00.000Z"),
      dependencies: {
        fetchSnapshot: vi.fn(async () => ({
          state: state(7),
          expiresAt: "2026-07-16T00:05:00.000Z",
          verification,
        })),
      },
    });

    expect(result).toMatchObject({ status: "initialized", record: { state: { sequence: 7 } } });
    expect(memory.current()).toEqual(result.record);
    expect(memory.store.read).toHaveBeenCalledWith("https://clawhub.ai", "publishers:alice");
  });

  it("revalidates complete state when a caller changes trust policy", async () => {
    const initial = {
      sourceOrigin: "https://clawhub.ai",
      state: state(7),
      verification,
      verifiedAt: "2026-07-16T00:00:00.000Z",
    };
    const memory = memoryStore(initial);
    const fetchSnapshot = vi.fn(async () => ({
      state: state(8),
      expiresAt: "2026-07-16T00:06:00.000Z",
      verification: {
        ...verification,
        signedBy: "clawhub-feed-2026-q4",
        signedByKeyIds: ["clawhub-feed-2026-q4"],
      },
    }));
    const fetchChanges = vi.fn();
    const result = await refreshPublisherFeedState({
      ...target,
      store: memory.store,
      forceSnapshot: true,
      dependencies: { fetchSnapshot, fetchChanges },
    });

    expect(result).toMatchObject({
      status: "updated",
      record: { state: { sequence: 8 }, verification: { signedBy: "clawhub-feed-2026-q4" } },
    });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchChanges).not.toHaveBeenCalled();
  });

  it("rejects rollback and equivocation during forced revalidation", async () => {
    const initial = {
      sourceOrigin: "https://clawhub.ai",
      state: state(7),
      verification,
      verifiedAt: "2026-07-16T00:00:00.000Z",
    };
    const stale = memoryStore(initial);
    await expect(
      refreshPublisherFeedState({
        ...target,
        store: stale.store,
        forceSnapshot: true,
        dependencies: {
          fetchSnapshot: vi.fn(async () => ({
            state: state(6),
            expiresAt: "2026-07-16T00:06:00.000Z",
            verification,
          })),
        },
      }),
    ).rejects.toThrow("older than accepted");
    expect(stale.current()).toBe(initial);

    const changed = memoryStore(initial);
    await expect(
      refreshPublisherFeedState({
        ...target,
        store: changed.store,
        forceSnapshot: true,
        dependencies: {
          fetchSnapshot: vi.fn(async () => ({
            state: { ...state(7), displayName: "Changed" },
            expiresAt: "2026-07-16T00:06:00.000Z",
            verification,
          })),
        },
      }),
    ).rejects.toThrow("without a sequence increment");
    expect(changed.current()).toBe(initial);
  });

  it("applies complete deltas and preserves state on transport failure", async () => {
    const initial = {
      sourceOrigin: "https://clawhub.ai",
      state: state(7),
      verification,
      verifiedAt: "2026-07-16T00:00:00.000Z",
    };
    const memory = memoryStore(initial);
    const result = await refreshPublisherFeedState({
      ...target,
      store: memory.store,
      dependencies: {
        fetchChanges: vi.fn(async () => ({
          status: "complete" as const,
          feedId: initial.state.feedId,
          fromSequence: 7,
          toSequence: 8,
          generatedAt: "2026-07-16T00:01:00.000Z",
          expiresAt: "2026-07-16T00:06:00.000Z",
          changes: [
            {
              sequence: 8,
              operation: "metadata" as const,
              metadata: {
                publisherId: "publishers:alice",
                handle: "alice-ai",
                displayName: "Alice AI",
              },
            },
          ],
          verification,
        })),
      },
    });
    expect(result).toMatchObject({
      status: "updated",
      record: { state: { sequence: 8, handle: "alice-ai" } },
    });

    const accepted = memory.current();
    await expect(
      refreshPublisherFeedState({
        ...target,
        store: memory.store,
        dependencies: {
          fetchChanges: vi.fn(async () => {
            throw new Error("offline");
          }),
        },
      }),
    ).rejects.toThrow("offline");
    expect(memory.current()).toBe(accepted);
  });

  it("accepts reset snapshots only at the signed target sequence", async () => {
    const initial = {
      sourceOrigin: "https://clawhub.ai",
      state: state(2),
      verification,
      verifiedAt: "2026-07-16T00:00:00.000Z",
    };
    const memory = memoryStore(initial);
    const fetchChanges = vi.fn(async () => ({
      status: "reset-required" as const,
      reset: {
        schemaVersion: 1 as const,
        feedId: initial.state.feedId,
        fromSequence: 2,
        currentSequence: 7,
        generatedAt: "2026-07-16T00:01:00.000Z",
        expiresAt: "2026-07-16T00:06:00.000Z",
        resetRequired: true as const,
        snapshotUrl: "https://clawhub.ai/api/v1/publishers/publishers%3Aalice/feed/snapshot",
      },
      verification,
    }));
    const fetchSnapshot = vi.fn(async () => ({
      state: state(7),
      expiresAt: "2026-07-16T00:06:00.000Z",
      verification,
    }));
    const result = await refreshPublisherFeedState({
      ...target,
      store: memory.store,
      dependencies: { fetchChanges, fetchSnapshot },
    });
    expect(result.status).toBe("reset");
    expect(result.record.state.sequence).toBe(7);

    const mismatch = memoryStore(initial);
    await expect(
      refreshPublisherFeedState({
        ...target,
        store: mismatch.store,
        dependencies: {
          fetchChanges,
          fetchSnapshot: vi.fn(async () => ({
            state: state(6),
            expiresAt: "2026-07-16T00:06:00.000Z",
            verification,
          })),
        },
      }),
    ).rejects.toThrow("does not match");
    expect(mismatch.current()).toBe(initial);
  });

  it("recovers from bounded change traversal with a verified snapshot", async () => {
    const initial = {
      sourceOrigin: "https://clawhub.ai",
      state: state(2),
      verification,
      verifiedAt: "2026-07-16T00:00:00.000Z",
    };
    const memory = memoryStore(initial);
    const fetchChanges = vi.fn(async () => {
      throw new PublisherFeedChangeTraversalLimitError(50);
    });
    const fetchSnapshot = vi.fn(async () => ({
      state: state(7),
      expiresAt: "2026-07-16T00:06:00.000Z",
      verification,
    }));

    await expect(
      refreshPublisherFeedState({
        ...target,
        store: memory.store,
        dependencies: { fetchChanges, fetchSnapshot },
      }),
    ).resolves.toMatchObject({ status: "reset", record: { state: { sequence: 7 } } });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(memory.current()?.state.sequence).toBe(7);
  });
});
