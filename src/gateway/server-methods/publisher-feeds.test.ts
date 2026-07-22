import { describe, expect, it, vi } from "vitest";
import { PublisherFeedFollowInputError } from "../../plugins/publisher-feed-follow-service.js";
import type { GatewayPublisherFeedRefresh } from "../server-publisher-feed-refresh.js";
import { createPublisherFeedsHandlers } from "./publisher-feeds.js";
import type { RespondFn } from "./types.js";

const follow = {
  sourceOrigin: "https://clawhub.ai",
  publisherId: "nvidia",
  feedProfile: "clawhub-public",
  createdAtMs: 1,
  updatedAtMs: 2,
};

const followStatus = {
  ...follow,
  acceptedSequence: 42,
  displayName: "NVIDIA",
  verifiedAt: "2026-07-16T00:00:00.000Z",
};

const refreshStatus = {
  running: false,
  stopped: false,
  lastStartedAt: "2026-07-16T00:00:00.000Z",
  lastCompletedAt: "2026-07-16T00:00:01.000Z",
  lastFollowCount: 1,
  lastRefreshedCount: 1,
  lastFailedCount: 0,
};

function createHarness(
  overrides: {
    list?: () => Promise<(typeof followStatus)[]>;
    follow?: () => Promise<{ follow: typeof follow; refresh: never }>;
    unfollow?: () => Promise<boolean>;
    scheduler?: GatewayPublisherFeedRefresh;
  } = {},
) {
  const serviceDependencies = {} as never;
  const scheduler =
    overrides.scheduler ??
    ({
      status: vi.fn(() => refreshStatus),
      runNow: vi.fn(async () => refreshStatus),
      stop: vi.fn(),
    } satisfies GatewayPublisherFeedRefresh);
  const dependencies = {
    createServiceDependencies: vi.fn(() => serviceDependencies),
    list: vi.fn(overrides.list ?? (async () => [followStatus])),
    follow: vi.fn(
      overrides.follow ??
        (async () => ({
          follow,
          refresh: {} as never,
        })),
    ),
    unfollow: vi.fn(overrides.unfollow ?? (async () => true)),
  };
  const handlers = createPublisherFeedsHandlers(dependencies);

  async function call(method: keyof typeof handlers, params: Record<string, unknown>) {
    const responses: Parameters<RespondFn>[] = [];
    await handlers[method]?.({
      params,
      context: {
        getPublisherFeedRefresh: () => scheduler,
        getRuntimeConfig: () => ({}),
      },
      respond: (...args: Parameters<RespondFn>) => responses.push(args),
    } as never);
    return responses[0];
  }

  return { call, dependencies, scheduler };
}

describe("publisher feed gateway methods", () => {
  it("lists persisted follows with scheduler status", async () => {
    const { call } = createHarness();
    expect(await call("publisherFeeds.list", {})).toEqual([
      true,
      { follows: [followStatus], refresh: refreshStatus },
      undefined,
    ]);
  });

  it("delegates follow verification and returns the persisted status", async () => {
    const { call, dependencies } = createHarness();
    expect(
      await call("publisherFeeds.follow", {
        publisherId: "nvidia",
        feedProfile: "clawhub-public",
      }),
    ).toEqual([true, { follow: followStatus }, undefined]);
    expect(dependencies.follow).toHaveBeenCalledWith({
      publisherId: "nvidia",
      feedProfile: "clawhub-public",
      deps: expect.anything(),
    });
  });

  it("unfollows and reuses the serialized scheduler for refresh", async () => {
    const { call, dependencies, scheduler } = createHarness();
    expect(
      await call("publisherFeeds.unfollow", {
        publisherId: "nvidia",
        feedProfile: "clawhub-public",
      }),
    ).toEqual([true, { removed: true }, undefined]);
    expect(dependencies.unfollow).toHaveBeenCalledOnce();
    expect(await call("publisherFeeds.refresh", {})).toEqual([
      true,
      { status: refreshStatus },
      undefined,
    ]);
    expect(scheduler.runNow).toHaveBeenCalledOnce();
    expect(await call("publisherFeeds.status", {})).toEqual([
      true,
      { status: refreshStatus },
      undefined,
    ]);
  });

  it("rejects malformed input and maps service failures", async () => {
    const invalid = createHarness();
    expect(await invalid.call("publisherFeeds.follow", { publisherId: "" })).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST" },
    ]);
    expect(invalid.dependencies.follow).not.toHaveBeenCalled();
    expect(
      await invalid.call("publisherFeeds.follow", {
        publisherId: "   ",
        feedProfile: "clawhub-public",
      }),
    ).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);

    const failed = createHarness({
      follow: async () => {
        throw new Error("signature verification failed");
      },
    });
    expect(
      await failed.call("publisherFeeds.follow", {
        publisherId: "nvidia",
        feedProfile: "clawhub-public",
      }),
    ).toEqual([
      false,
      undefined,
      { code: "UNAVAILABLE", message: "signature verification failed" },
    ]);

    const missingProfile = createHarness({
      follow: async () => {
        throw new PublisherFeedFollowInputError("publisher feed profile is not configured");
      },
    });
    expect(
      await missingProfile.call("publisherFeeds.follow", {
        publisherId: "nvidia",
        feedProfile: "missing",
      }),
    ).toEqual([
      false,
      undefined,
      { code: "INVALID_REQUEST", message: "publisher feed profile is not configured" },
    ]);
  });

  it("reports scheduler methods unavailable outside the full gateway", async () => {
    const handlers = createPublisherFeedsHandlers({
      createServiceDependencies: () => ({}) as never,
      list: async () => [followStatus],
      follow: async () => ({ follow, refresh: {} as never }),
      unfollow: async () => true,
    });
    const responses: Parameters<RespondFn>[] = [];
    await handlers["publisherFeeds.status"]?.({
      params: {},
      context: {},
      respond: (...args: Parameters<RespondFn>) => responses.push(args),
    } as never);
    expect(responses[0]).toEqual([
      false,
      undefined,
      {
        code: "UNAVAILABLE",
        message: "publisher feed refresh is unavailable in this gateway context",
      },
    ]);
  });
});
