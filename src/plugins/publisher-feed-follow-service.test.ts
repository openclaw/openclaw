import { describe, expect, it, vi } from "vitest";
import {
  followPublisherFeedByHandle,
  listFollowedPublisherFeeds,
  refreshFollowedPublisherFeeds,
  unfollowPublisherFeed,
} from "./publisher-feed-follow-service.js";
import type {
  FollowedPublisherFeed,
  PublisherFeedFollowStore,
} from "./publisher-feed-follow-store.js";
import type {
  PublisherFeedStateStore,
  StoredPublisherFeedState,
} from "./publisher-feed-state-store.js";

const marketplaces = {
  feeds: {
    "clawhub-signed": {
      url: "https://clawhub.ai/v1/feeds/plugins",
      verification: {
        mode: "signed" as const,
        keys: [{ keyId: "clawhub-2026-q3", publicKey: "public-key" }],
      },
    },
    unsigned: { url: "https://clawhub.ai/v1/feeds/plugins" },
  },
};

function acceptedState(sequence = 7): StoredPublisherFeedState {
  return {
    sourceOrigin: "https://clawhub.ai",
    state: {
      feedId: "clawhub.publisher.publishers:alice",
      publisherId: "publishers:alice",
      sequence,
      generatedAt: "2026-07-16T00:00:00.000Z",
      handle: "alice",
      displayName: "Alice",
      entries: [],
    },
    verification: {
      signedBy: "clawhub-2026-q3",
      signedByKeyIds: ["clawhub-2026-q3"],
      signatureCount: 1,
      threshold: 1,
    },
    verifiedAt: "2026-07-16T00:01:00.000Z",
  };
}

function followRecord(): FollowedPublisherFeed {
  return {
    sourceOrigin: "https://clawhub.ai",
    publisherId: "publishers:alice",
    feedProfile: "clawhub-signed",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function dependencies(
  params: {
    follows?: FollowedPublisherFeed[];
    state?: StoredPublisherFeedState | null;
  } = {},
) {
  let follows = [...(params.follows ?? [])];
  const followStore: PublisherFeedFollowStore = {
    list: vi.fn(async () => follows),
    follow: vi.fn(async (input) => {
      const follow = {
        sourceOrigin: input.sourceOrigin,
        publisherId: input.publisherId,
        feedProfile: input.feedProfile,
        createdAtMs: 1,
        updatedAtMs: 1,
      };
      follows = [follow];
      return follow;
    }),
    unfollow: vi.fn(async (origin, publisherId) => {
      const before = follows.length;
      follows = follows.filter(
        (follow) => follow.sourceOrigin !== origin || follow.publisherId !== publisherId,
      );
      return follows.length !== before;
    }),
  };
  const stateStore: PublisherFeedStateStore = {
    read: vi.fn(async () => params.state ?? null),
    write: vi.fn(async () => undefined),
  };
  return { follows: followStore, states: stateStore, marketplaces };
}

describe("publisher feed follow service", () => {
  it("refreshes before persisting a new follow", async () => {
    const deps = dependencies();
    const refresh = vi.fn(async () => ({
      status: "initialized" as const,
      record: acceptedState(),
    }));
    const result = await followPublisherFeedByHandle({
      publisherHandle: "alice",
      feedProfile: "clawhub-signed",
      deps: {
        ...deps,
        refresh,
        resolveHandle: vi.fn(async () => ({
          publisherId: "publishers:alice",
          handle: "alice",
        })),
      },
    });
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://clawhub.ai",
        forceSnapshot: true,
        publisherId: "publishers:alice",
        store: deps.states,
      }),
    );
    expect(deps.follows.follow).toHaveBeenCalledAfter(refresh);
    expect(result.follow.publisherId).toBe("publishers:alice");
  });

  it("resolves a handle before persisting the stable publisher id", async () => {
    const deps = dependencies();
    const resolveHandle = vi.fn(async () => ({
      publisherId: "publishers:alice",
      handle: "alice",
    }));
    const refresh = vi.fn(async () => ({
      status: "initialized" as const,
      record: acceptedState(),
    }));

    const result = await followPublisherFeedByHandle({
      publisherHandle: "@Alice",
      feedProfile: "clawhub-signed",
      deps: { ...deps, refresh, resolveHandle },
    });

    expect(resolveHandle).toHaveBeenCalledWith({
      baseUrl: "https://clawhub.ai",
      publisherHandle: "@Alice",
    });
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ publisherId: "publishers:alice" }),
    );
    expect(result.follow.publisherId).toBe("publishers:alice");
  });

  it("lists accepted state, refreshes independently, and unfollows", async () => {
    const deps = dependencies({ follows: [followRecord()], state: acceptedState() });
    expect(await listFollowedPublisherFeeds(deps)).toMatchObject([
      { publisherId: "publishers:alice", acceptedSequence: 7, displayName: "Alice" },
    ]);

    const refresh = vi.fn(async () => ({ status: "unchanged" as const, record: acceptedState() }));
    const refreshed = await refreshFollowedPublisherFeeds({ deps: { ...deps, refresh } });
    expect(refreshed).toMatchObject([{ ok: true, result: { status: "unchanged" } }]);
    await expect(
      unfollowPublisherFeed({
        publisherId: "publishers:alice",
        feedProfile: "clawhub-signed",
        deps: { ...deps, marketplaces: undefined },
      }),
    ).resolves.toBe(true);
  });

  it("keeps per-follow failures visible without blocking other targets", async () => {
    const second = { ...followRecord(), publisherId: "publishers:bob" };
    const deps = dependencies({ follows: [followRecord(), second] });
    const refresh = vi.fn(async ({ publisherId }: { publisherId: string }) => {
      if (publisherId === "publishers:alice") {
        throw new Error("offline");
      }
      return { status: "initialized" as const, record: acceptedState() };
    });
    const results = await refreshFollowedPublisherFeeds({ deps: { ...deps, refresh } });
    expect(results).toMatchObject([
      { ok: false, error: "offline" },
      { ok: true, result: { status: "initialized" } },
    ]);
  });

  it("resolves the built-in ClawHub profile before enforcing signed trust", async () => {
    const deps = dependencies();
    await expect(
      followPublisherFeedByHandle({
        publisherHandle: "alice",
        feedProfile: "clawhub-public",
        deps: {
          ...deps,
          marketplaces: undefined,
          resolveHandle: vi.fn(async () => ({
            publisherId: "publishers:alice",
            handle: "alice",
          })),
        },
      }),
    ).rejects.toThrow('publisher feed profile "clawhub-public" must require signatures');
  });
});
