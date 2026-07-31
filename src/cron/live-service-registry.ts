import path from "node:path";
import type { LegacyDefaultCronOwnerMigrationResult } from "./legacy-default-agent-owner-migration.js";
import type { PreparedCronOwnerRollback } from "./store/owner-migration.js";

export type LegacyDefaultCronOwnerHandoffOptions = {
  beforeMigration?: () => Promise<void>;
  expectedStoreEpoch?: () => number | undefined;
  recordCommittedStoreEpoch?: (storeEpoch: number) => void;
  recordPreparedRollback?: (rollback: PreparedCronOwnerRollback) => void;
};

export type LiveCronOwnerMigration = {
  beginLegacyDefaultAgentOwnerHandoff: (
    legacyDefaultAgentId: string,
    options?: LegacyDefaultCronOwnerHandoffOptions,
  ) => Promise<{
    migration: LegacyDefaultCronOwnerMigrationResult;
    release: () => void;
  }>;
  refreshLegacyDefaultAgentOwnerHandoff: (options?: {
    persistSchedulingState?: boolean;
  }) => Promise<void>;
};

type ActiveHandoff = {
  completion: Promise<void>;
  resolveCompletion: () => void;
  releaseStoreLock?: () => void;
};

type LiveStoreState = {
  services: Set<LiveCronOwnerMigration>;
  handoff?: ActiveHandoff;
};

const liveStores = new Map<string, LiveStoreState>();

function getLiveStore(storePath: string): LiveStoreState {
  const key = path.resolve(storePath);
  const existing = liveStores.get(key);
  if (existing) {
    return existing;
  }
  const created = { services: new Set<LiveCronOwnerMigration>() };
  liveStores.set(key, created);
  return created;
}

/** Registers a starting CronService; handoff-time starters wait before loading. */
export function registerLiveCronService(
  storePath: string,
  service: LiveCronOwnerMigration,
): { ready: Promise<void>; unregister: () => void } {
  const key = path.resolve(storePath);
  const state = getLiveStore(key);
  state.services.add(service);
  return {
    ready: state.handoff?.completion ?? Promise.resolve(),
    unregister: () => {
      const current = liveStores.get(key);
      current?.services.delete(service);
      if (current && current.services.size === 0 && !current.handoff) {
        liveStores.delete(key);
      }
    },
  };
}

type LiveCronOwnerHandoff = {
  drainAndSeal: () => Promise<LegacyDefaultCronOwnerMigrationResult>;
  refreshSealedServices: () => Promise<void>;
  release: () => void;
};

/** Locks every already-live service until the config commit settles. */
export function beginLegacyDefaultOwnerHandoff(
  params: {
    storePath: string;
    legacyDefaultAgentId: string;
  } & LegacyDefaultCronOwnerHandoffOptions,
): LiveCronOwnerHandoff {
  const key = path.resolve(params.storePath);
  const state = getLiveStore(key);
  if (state.handoff) {
    throw new Error(`Cron ownership handoff already active for ${key}`);
  }
  let resolveCompletion = () => {};
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const handoff: ActiveHandoff = { completion, resolveCompletion };
  state.handoff = handoff;
  // Registration is synchronous and every later starter waits on completion,
  // so this snapshot is the closed set of services already able to mutate jobs.
  const participants = [...state.services];
  let released = false;
  return {
    drainAndSeal: async () => {
      const [leader, ...followers] = participants;
      if (!leader) {
        await params.beforeMigration?.();
        return { changes: [], warnings: [] };
      }
      // One participant holds the store-wide operation lock and performs the
      // migration. That lock already drains every service sharing this store;
      // followers only reload the durable rows while it remains held.
      const result = await leader.beginLegacyDefaultAgentOwnerHandoff(params.legacyDefaultAgentId, {
        beforeMigration: params.beforeMigration,
        expectedStoreEpoch: params.expectedStoreEpoch,
        recordCommittedStoreEpoch: params.recordCommittedStoreEpoch,
        recordPreparedRollback: params.recordPreparedRollback,
      });
      handoff.releaseStoreLock = result.release;
      await Promise.all(
        followers.map((service) =>
          service.refreshLegacyDefaultAgentOwnerHandoff({ persistSchedulingState: false }),
        ),
      );
      return result.migration;
    },
    refreshSealedServices: async () => {
      const [leader, ...followers] = participants;
      await leader?.refreshLegacyDefaultAgentOwnerHandoff({ persistSchedulingState: true });
      await Promise.all(
        followers.map((service) =>
          service.refreshLegacyDefaultAgentOwnerHandoff({ persistSchedulingState: false }),
        ),
      );
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;
      handoff.releaseStoreLock?.();
      delete handoff.releaseStoreLock;
      if (state.handoff === handoff) {
        delete state.handoff;
      }
      handoff.resolveCompletion();
      if (state.services.size === 0) {
        liveStores.delete(key);
      }
    },
  };
}
