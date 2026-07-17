import { describe, expect, it, vi } from "vitest";
import {
  followPublisherFeed,
  followPublisherFeedByHandle,
  listEligiblePublisherFeedProfiles,
  listFollowedPublisherFeeds,
  refreshFollowedPublisherFeeds,
  resolveFollowedPublisherFeedTarget,
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
  it("lists only eligible signed profiles without exposing trust keys", () => {
    const profiles = listEligiblePublisherFeedProfiles({
      feeds: {
        unsigned: { url: "https://unsigned.example/feed" },
        malformed: {
          url: "https://user:secret@example.com/feed",
          verification: {
            mode: "signed",
            keys: [{ keyId: "secret-key-id", publicKey: "secret-public-key" }],
          },
        },
        "z-signed": {
          url: "https://z.example/feed/path",
          verification: {
            mode: "signed",
            keys: [{ keyId: "z-key", publicKey: "z-public-key" }],
          },
        },
        "a-signed": {
          url: "https://a.example/feed/path",
          verification: {
            mode: "signed",
            keys: [{ keyId: "a-key", publicKey: "a-public-key" }],
          },
        },
      },
    });

    expect(profiles).toEqual([
      { name: "a-signed", sourceOrigin: "https://a.example" },
      { name: "z-signed", sourceOrigin: "https://z.example" },
    ]);
    expect(JSON.stringify(profiles)).not.toContain("public-key");
  });

  it("requires a configured signed profile and binds its origin", () => {
    expect(() =>
      resolveFollowedPublisherFeedTarget({
        follow: { ...followRecord(), feedProfile: "unsigned" },
        marketplaces,
      }),
    ).toThrow("must require signatures");
    expect(() =>
      resolveFollowedPublisherFeedTarget({
        follow: { ...followRecord(), sourceOrigin: "https://mirror.example" },
        marketplaces,
      }),
    ).toThrow("no longer matches");
    expect(
      resolveFollowedPublisherFeedTarget({ follow: followRecord(), marketplaces }),
    ).toMatchObject({
      baseUrl: "https://clawhub.ai",
      publisherId: "publishers:alice",
      verification: { trustedKeys: [{ keyId: "clawhub-2026-q3" }] },
    });
  });
  it("refreshes before persisting a new follow", async () => {
    const deps = dependencies();
    const refresh = vi.fn(async () => ({
      status: "initialized" as const,
      record: acceptedState(),
    }));
    const result = await followPublisherFeed({
      publisherId: " publishers:alice ",
      feedProfile: " clawhub-signed ",
      deps: { ...deps, refresh },
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
    expect(result.follow.feedProfile).toBe("clawhub-signed");
    await expect(
      unfollowPublisherFeed({
        publisherId: " publishers:alice ",
        feedProfile: " clawhub-signed ",
        deps,
      }),
    ).resolves.toBe(true);
  });

  it("rejects identifiers beyond the UTF-8 byte contract before refresh", async () => {
    const deps = dependencies();
    const refresh = vi.fn();
    await expect(
      followPublisherFeed({
        publisherId: "é".repeat(101),
        feedProfile: "clawhub-signed",
        deps: { ...deps, refresh },
      }),
    ).rejects.toThrow("publisher id is invalid");
    expect(refresh).not.toHaveBeenCalled();
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
      followPublisherFeed({
        publisherId: "publishers:alice",
        feedProfile: "clawhub-public",
        deps: { ...deps, marketplaces: undefined },
      }),
    ).rejects.toThrow('publisher feed profile "clawhub-public" must require signatures');
  });
});
