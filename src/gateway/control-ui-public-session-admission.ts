import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import {
  createPublicSessionRepresentationCache,
  type PublicSessionRepresentation,
} from "./control-ui-public-session-cache.js";

const PUBLIC_SESSION_RATE_WINDOW_MS = 60_000;
const PUBLIC_SESSION_CLIENT_REQUEST_LIMIT = 120;
const PUBLIC_SESSION_PUBLICATION_REQUEST_LIMIT = 240;
const PUBLIC_SESSION_MAX_CLIENTS = 4_096;
const PUBLIC_SESSION_MAX_PUBLICATIONS = 2_048;
const PUBLIC_SESSION_MAX_CONCURRENT_READS = 8;
const PUBLIC_SESSION_MAX_CONCURRENT_READS_PER_PUBLICATION = 2;
const PUBLIC_SESSION_MAX_QUEUED_READS = 32;

type RateWindow = {
  timestamps: number[];
};

type PublicSessionAdmissionResult =
  | { kind: "ok"; value: PublicSessionRepresentation | null }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "unavailable" };

export type ControlUiPublicSessionRequestGate = {
  dispose(): void;
  admitClient(
    clientKey: string,
  ): { kind: "ok" } | { kind: "rate-limited"; retryAfterSeconds: number };
  run(params: {
    publicationKey: string;
    sessionKey: string;
    requestKey: string;
    config: OpenClawConfig;
    work: () => Promise<string | null>;
  }): Promise<PublicSessionAdmissionResult>;
};

function admitRateWindow(
  windows: Map<string, RateWindow>,
  key: string,
  limit: number,
  maxEntries: number,
  now: number,
): number | undefined {
  const cutoff = now - PUBLIC_SESSION_RATE_WINDOW_MS;
  let window = windows.get(key);
  if (!window) {
    if (windows.size >= maxEntries) {
      for (const [candidateKey, candidate] of windows) {
        candidate.timestamps = candidate.timestamps.filter((timestamp) => timestamp > cutoff);
        if (candidate.timestamps.length === 0) {
          windows.delete(candidateKey);
        }
      }
    }
    if (windows.size >= maxEntries) {
      // Anonymous identities are attacker-controlled. Evict the oldest bucket
      // instead of letting map saturation deny every previously unseen viewer.
      pruneMapToMaxSize(windows, maxEntries - 1);
    }
    window = { timestamps: [] };
    windows.set(key, window);
  }
  window.timestamps = window.timestamps.filter((timestamp) => timestamp > cutoff);
  const oldest = window.timestamps[0];
  if (window.timestamps.length >= limit && oldest !== undefined) {
    return Math.max(1, oldest + PUBLIC_SESSION_RATE_WINDOW_MS - now);
  }
  window.timestamps.push(now);
  return undefined;
}

/** Creates the fixed, process-local abuse boundary for anonymous transcript reads. */
export function createControlUiPublicSessionRequestGate(): ControlUiPublicSessionRequestGate {
  const clientWindows = new Map<string, RateWindow>();
  const publicationWindows = new Map<string, RateWindow>();
  const activeByPublication = new Map<string, number>();
  const inFlight = new Map<string, Promise<PublicSessionRepresentation | null | undefined>>();
  const cache = createPublicSessionRepresentationCache();
  let active = true;
  const configIds = new WeakMap<object, number>();
  let nextConfigId = 1;
  let activeReads = 0;

  const queued: Array<{
    publicationKey: string;
    resolve: (release: (() => void) | undefined) => void;
  }> = [];
  const hasCapacity = (publicationKey: string) =>
    activeReads < PUBLIC_SESSION_MAX_CONCURRENT_READS &&
    (activeByPublication.get(publicationKey) ?? 0) <
      PUBLIC_SESSION_MAX_CONCURRENT_READS_PER_PUBLICATION;
  const reserve = (publicationKey: string): (() => void) => {
    activeReads++;
    activeByPublication.set(publicationKey, (activeByPublication.get(publicationKey) ?? 0) + 1);
    return () => {
      activeReads--;
      const remaining = (activeByPublication.get(publicationKey) ?? 1) - 1;
      if (remaining) {
        activeByPublication.set(publicationKey, remaining);
      } else {
        activeByPublication.delete(publicationKey);
      }
      // Preserve arrival order within each publication without letting one hot
      // thread occupy slots that can serve unrelated readers.
      for (let index = 0; index < queued.length;) {
        if (!active || activeReads >= PUBLIC_SESSION_MAX_CONCURRENT_READS) {
          break;
        }
        const next = queued[index]!;
        if (!hasCapacity(next.publicationKey)) {
          index++;
          continue;
        }
        queued.splice(index, 1);
        next.resolve(reserve(next.publicationKey));
      }
    };
  };
  const acquire = (publicationKey: string): Promise<(() => void) | undefined> => {
    if (!active) {
      return Promise.resolve(undefined);
    }
    if (hasCapacity(publicationKey)) {
      return Promise.resolve(reserve(publicationKey));
    }
    if (queued.length >= PUBLIC_SESSION_MAX_QUEUED_READS) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      queued.push({ publicationKey, resolve });
    });
  };

  const configId = (config: OpenClawConfig): number => {
    const existing = configIds.get(config);
    if (existing !== undefined) {
      return existing;
    }
    const created = nextConfigId++;
    configIds.set(config, created);
    return created;
  };

  return {
    dispose() {
      active = false;
      cache.dispose();
      for (const next of queued.splice(0)) {
        next.resolve(undefined);
      }
      clientWindows.clear();
      publicationWindows.clear();
    },
    admitClient(clientKey) {
      const retryMs = admitRateWindow(
        clientWindows,
        clientKey,
        PUBLIC_SESSION_CLIENT_REQUEST_LIMIT,
        PUBLIC_SESSION_MAX_CLIENTS,
        Date.now(),
      );
      return retryMs === undefined
        ? { kind: "ok" }
        : { kind: "rate-limited", retryAfterSeconds: Math.ceil(retryMs / 1_000) };
    },
    async run(params) {
      if (!active) {
        return { kind: "unavailable" };
      }
      const now = Date.now();
      const publicationRetryMs = admitRateWindow(
        publicationWindows,
        params.publicationKey,
        PUBLIC_SESSION_PUBLICATION_REQUEST_LIMIT,
        PUBLIC_SESSION_MAX_PUBLICATIONS,
        now,
      );
      if (publicationRetryMs !== undefined) {
        return {
          kind: "rate-limited",
          retryAfterSeconds: Math.ceil(publicationRetryMs / 1_000),
        };
      }

      const inFlightKey = `${configId(params.config)}:${params.requestKey}`;
      const cached = cache.get(inFlightKey, params.config);
      if (cached) {
        return { kind: "ok", value: cached };
      }
      const existing = inFlight.get(inFlightKey);
      if (existing) {
        const value = await existing;
        return value === undefined ? { kind: "unavailable" } : { kind: "ok", value };
      }
      const build = cache.begin(inFlightKey, params.sessionKey, params.config);
      const pending = (async () => {
        const release = await acquire(params.publicationKey);
        if (!release) {
          build.cancel();
          return undefined;
        }
        try {
          if (!build.isCurrent()) {
            return undefined;
          }
          const body = await params.work();
          if (body === null) {
            build.cancel();
            return null;
          }
          return build.complete(body);
        } catch (error) {
          build.cancel();
          throw error;
        } finally {
          release();
        }
      })();
      inFlight.set(inFlightKey, pending);
      try {
        const value = await pending;
        return value === undefined ? { kind: "unavailable" } : { kind: "ok", value };
      } finally {
        inFlight.delete(inFlightKey);
      }
    },
  };
}
