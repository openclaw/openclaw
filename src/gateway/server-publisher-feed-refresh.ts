import { getRuntimeConfig } from "../config/config.js";
import { computeBackoff } from "../infra/backoff.js";
import { refreshFollowedPublisherFeeds } from "../plugins/publisher-feed-follow-service.js";
import { createSqlitePublisherFeedFollowStore } from "../plugins/publisher-feed-follow-store.js";
import { createSqlitePublisherFeedStateStore } from "../plugins/publisher-feed-state-store.js";

type GatewayPublisherFeedRefreshStatus = {
  running: boolean;
  stopped: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastFollowCount: number;
  lastRefreshedCount: number;
  lastFailedCount: number;
};

export type GatewayPublisherFeedRefresh = {
  runNow: () => Promise<GatewayPublisherFeedRefreshStatus>;
  status: () => GatewayPublisherFeedRefreshStatus;
  stop: () => void;
};

type PublisherFeedRefreshLogger = {
  error: (message: string) => void;
};

type PublisherFeedRefreshDependencies = {
  run?: () => Promise<readonly { ok: boolean; error?: string }[]>;
  now?: () => Date;
};

const MAX_REFRESH_DELAY_MS = 24 * 60 * 60_000;
const REFRESH_JITTER = 0.1;

export function createNoopGatewayPublisherFeedRefresh(): GatewayPublisherFeedRefresh {
  const status = {
    running: false,
    stopped: true,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastFollowCount: 0,
    lastRefreshedCount: 0,
    lastFailedCount: 0,
  } satisfies GatewayPublisherFeedRefreshStatus;
  return {
    runNow: async () => status,
    status: () => status,
    stop: () => {},
  };
}

export function startGatewayPublisherFeedRefresh(params: {
  log: PublisherFeedRefreshLogger;
  intervalMs?: number;
  initialDelayMs?: number;
  dependencies?: PublisherFeedRefreshDependencies;
}): GatewayPublisherFeedRefresh {
  const intervalMs = params.intervalMs ?? 15 * 60_000;
  const initialDelayMs = params.initialDelayMs ?? 30_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 24 * 60 * 60_000) {
    throw new Error(
      "gateway publisher feed refresh interval must be between 1 minute and 24 hours",
    );
  }
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > intervalMs) {
    throw new Error("gateway publisher feed initial delay is invalid");
  }

  const now = params.dependencies?.now ?? (() => new Date());
  const runRefresh =
    params.dependencies?.run ??
    (() => {
      const config = getRuntimeConfig();
      return refreshFollowedPublisherFeeds({
        deps: {
          follows: createSqlitePublisherFeedFollowStore(),
          states: createSqlitePublisherFeedStateStore(),
          marketplaces: config.marketplaces,
        },
      });
    });
  let currentStatus: GatewayPublisherFeedRefreshStatus = {
    running: false,
    stopped: false,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastFollowCount: 0,
    lastRefreshedCount: 0,
    lastFailedCount: 0,
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<GatewayPublisherFeedRefreshStatus> | null = null;
  let consecutiveFailureCount = 0;

  const nextDelayMs = (baseMs: number, attempt: number) =>
    computeBackoff(
      {
        initialMs: baseMs,
        maxMs: MAX_REFRESH_DELAY_MS,
        factor: 2,
        jitter: REFRESH_JITTER,
      },
      attempt,
    );

  const schedule = (delayMs: number) => {
    if (currentStatus.stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
    timer.unref?.();
  };

  const run = (): Promise<GatewayPublisherFeedRefreshStatus> => {
    if (currentStatus.stopped) {
      return Promise.resolve({ ...currentStatus });
    }
    if (running) {
      return running;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    currentStatus = { ...currentStatus, running: true, lastStartedAt: now().toISOString() };
    running = runRefresh()
      .then((results) => {
        let failureCount = 0;
        for (const result of results) {
          if (!result.ok) {
            failureCount += 1;
            params.log.error(`publisher feed refresh failed: ${result.error}`);
          }
        }
        consecutiveFailureCount = failureCount > 0 ? consecutiveFailureCount + 1 : 0;
        currentStatus = {
          ...currentStatus,
          running: false,
          lastCompletedAt: now().toISOString(),
          lastFollowCount: results.length,
          lastRefreshedCount: results.length - failureCount,
          lastFailedCount: failureCount,
        };
        return { ...currentStatus };
      })
      .catch((error: unknown) => {
        consecutiveFailureCount += 1;
        params.log.error(`publisher feed refresh cycle failed: ${String(error)}`);
        currentStatus = {
          ...currentStatus,
          running: false,
          lastCompletedAt: now().toISOString(),
          lastFollowCount: 0,
          lastRefreshedCount: 0,
          lastFailedCount: 1,
        };
        return { ...currentStatus };
      })
      .finally(() => {
        running = null;
        schedule(nextDelayMs(intervalMs, consecutiveFailureCount + 1));
      });
    return running;
  };

  schedule(nextDelayMs(initialDelayMs, 1));
  return {
    runNow: run,
    status: () => ({ ...currentStatus }),
    stop: () => {
      currentStatus = { ...currentStatus, stopped: true };
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
