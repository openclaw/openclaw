import type { MarketplacesConfig } from "../config/types.marketplaces.js";
import type {
  FollowedPublisherFeed,
  PublisherFeedFollowStore,
} from "./publisher-feed-follow-store.js";
import {
  refreshPublisherFeedState,
  type PublisherFeedRefreshResult,
  type PublisherFeedRefreshTarget,
} from "./publisher-feed-refresh.js";
import type { PublisherFeedStateStore } from "./publisher-feed-state-store.js";

export type PublisherFeedFollowServiceDependencies = {
  follows: PublisherFeedFollowStore;
  states: PublisherFeedStateStore;
  marketplaces: MarketplacesConfig | undefined;
  refresh?: typeof refreshPublisherFeedState;
};

export type FollowedPublisherFeedStatus = FollowedPublisherFeed & {
  acceptedSequence: number | null;
  displayName: string | null;
  verifiedAt: string | null;
};

function resolveProfile(params: {
  marketplaces: MarketplacesConfig | undefined;
  profileName: string;
}): Omit<PublisherFeedRefreshTarget, "publisherId"> {
  const profileName = params.profileName.trim();
  const profile = params.marketplaces?.feeds?.[profileName];
  if (!profile) {
    throw new Error(`publisher feed profile ${JSON.stringify(profileName)} is not configured`);
  }
  if (profile.verification?.mode !== "signed") {
    throw new Error(
      `publisher feed profile ${JSON.stringify(profileName)} must require signatures`,
    );
  }
  let url: URL;
  try {
    url = new URL(profile.url);
  } catch {
    throw new Error(`publisher feed profile ${JSON.stringify(profileName)} has an invalid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `publisher feed profile ${JSON.stringify(profileName)} must use an HTTPS URL without credentials, query, or fragment`,
    );
  }
  return {
    baseUrl: url.origin,
    verification: {
      trustedKeys: profile.verification.keys,
      ...(profile.verification.threshold === undefined
        ? {}
        : { threshold: profile.verification.threshold }),
    },
  };
}

export function resolveFollowedPublisherFeedTarget(params: {
  follow: FollowedPublisherFeed;
  marketplaces: MarketplacesConfig | undefined;
}): PublisherFeedRefreshTarget {
  const profile = resolveProfile({
    marketplaces: params.marketplaces,
    profileName: params.follow.feedProfile,
  });
  if (new URL(profile.baseUrl).origin !== params.follow.sourceOrigin) {
    throw new Error(
      `publisher feed profile ${JSON.stringify(params.follow.feedProfile)} no longer matches the followed source origin`,
    );
  }
  return { ...profile, publisherId: params.follow.publisherId };
}

export async function listFollowedPublisherFeeds(
  deps: PublisherFeedFollowServiceDependencies,
): Promise<FollowedPublisherFeedStatus[]> {
  const follows = await deps.follows.list();
  return await Promise.all(
    follows.map(async (follow) => {
      const state = await deps.states.read(follow.sourceOrigin, follow.publisherId);
      return {
        sourceOrigin: follow.sourceOrigin,
        publisherId: follow.publisherId,
        feedProfile: follow.feedProfile,
        createdAtMs: follow.createdAtMs,
        updatedAtMs: follow.updatedAtMs,
        acceptedSequence: state?.state.sequence ?? null,
        displayName: state?.state.displayName ?? null,
        verifiedAt: state?.verifiedAt ?? null,
      };
    }),
  );
}

export async function followPublisherFeed(params: {
  publisherId: string;
  feedProfile: string;
  deps: PublisherFeedFollowServiceDependencies;
}): Promise<{ follow: FollowedPublisherFeed; refresh: PublisherFeedRefreshResult }> {
  const target = resolveProfile({
    marketplaces: params.deps.marketplaces,
    profileName: params.feedProfile,
  });
  const refresh = params.deps.refresh ?? refreshPublisherFeedState;
  const refreshed = await refresh({
    ...target,
    publisherId: params.publisherId,
    store: params.deps.states,
    forceSnapshot: true,
  });
  const follow = await params.deps.follows.follow({
    sourceOrigin: new URL(target.baseUrl).origin,
    publisherId: refreshed.record.state.publisherId,
    feedProfile: params.feedProfile,
  });
  return { follow, refresh: refreshed };
}

export async function unfollowPublisherFeed(params: {
  publisherId: string;
  feedProfile: string;
  deps: PublisherFeedFollowServiceDependencies;
}): Promise<boolean> {
  const publisherId = params.publisherId.trim();
  const feedProfile = params.feedProfile.trim();
  const matches = (await params.deps.follows.list()).filter(
    (follow) => follow.publisherId === publisherId && follow.feedProfile === feedProfile,
  );
  let removed = false;
  for (const follow of matches) {
    removed = (await params.deps.follows.unfollow(follow.sourceOrigin, publisherId)) || removed;
  }
  return removed;
}

export async function refreshFollowedPublisherFeeds(params: {
  deps: PublisherFeedFollowServiceDependencies;
  publisherId?: string;
  feedProfile?: string;
}): Promise<
  Array<
    | { follow: FollowedPublisherFeed; ok: true; result: PublisherFeedRefreshResult }
    | { follow: FollowedPublisherFeed; ok: false; error: string }
  >
> {
  const follows = (await params.deps.follows.list()).filter(
    (follow) =>
      (!params.publisherId || follow.publisherId === params.publisherId.trim()) &&
      (!params.feedProfile || follow.feedProfile === params.feedProfile.trim()),
  );
  const refresh = params.deps.refresh ?? refreshPublisherFeedState;
  const results = [];
  for (const follow of follows) {
    try {
      const target = resolveFollowedPublisherFeedTarget({
        follow,
        marketplaces: params.deps.marketplaces,
      });
      results.push({
        follow,
        ok: true as const,
        result: await refresh({ ...target, store: params.deps.states }),
      });
    } catch (error) {
      results.push({
        follow,
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
