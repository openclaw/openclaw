import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import {
  readWorkerProjectPreparation,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

const HUMAN_PRESENCE_RETIRE_AFTER_MS = 15 * 60 * 1_000;
const REPOSITORY_REF_REFRESH_INTERVAL_MS = 60_000;
const PRESENCE_RESERVE_EXPIRY_MS = Number.MAX_SAFE_INTEGER;

export function isSupersededPresenceReserve(
  record: WorkerEnvironmentRecord,
  demand: PreparedPoolPresenceDemand | undefined,
): boolean {
  // Only presence admission grants an unbounded reserve deadline.
  if (
    record.preparation?.purpose !== "reserve" ||
    record.preparation.expiresAtMs !== PRESENCE_RESERVE_EXPIRY_MS
  ) {
    return false;
  }
  return (
    !demand ||
    record.profileId !== demand.profileId ||
    record.preparation.key !== demand.preparationKey ||
    readWorkerProjectSnapshot(record.profileSnapshot.project)?.key !== demand.project.key
  );
}

export type PreparedPoolPresenceOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  prepareIntent: (
    profileId: string,
    options: {
      projectRepository?: RepositoryWorkerProjectSnapshot;
      repository?: { agentId: string; url: string; ref?: string };
      executionMode?: "worker-turn" | "remote-exec";
      signal?: AbortSignal;
    },
  ) => Promise<WorkerProviderPreparedIntent>;
  assertIntentCurrent: (profileId: string, intent: WorkerProviderPreparedIntent) => void;
  resolveHumanPresenceDemand?: () =>
    | {
        profileId: string;
        executionMode: "worker-turn" | "remote-exec";
        repository: { agentId: string; url: string; ref?: string };
      }
    | undefined;
  presenceDemandStore?: {
    read: () => Promise<PreparedPoolPresenceDemand | undefined>;
    write: (
      value: PreparedPoolPresenceDemand | null,
      assertCurrent: () => void,
    ) => Promise<PreparedPoolPresenceDemand | undefined>;
  };
  now: () => number;
  signal: AbortSignal;
  schedule: () => Promise<void>;
};

export function createPreparedPoolPresence(options: PreparedPoolPresenceOptions) {
  const { store, signal, now } = options;
  let humanPresent = false;
  let humanPresenceObserved = false;
  let humanPresenceChangedAtMs = now();
  let version = 0;
  let loaded = false;
  let loading: Promise<void> | undefined;
  let demand: PreparedPoolPresenceDemand | undefined;
  let refResolvedAtMs: number | undefined;
  const current = () => signal.throwIfAborted();
  const policy = () => {
    const source = options.resolveHumanPresenceDemand?.();
    if (!source || !options.presenceDemandStore) {
      return undefined;
    }
    return { ...source, retireAfterMs: HUMAN_PRESENCE_RETIRE_AFTER_MS };
  };
  const read = async () => {
    if (!loaded) {
      await (loading ??= (async () => {
        try {
          demand = await options.presenceDemandStore?.read();
          loaded = true;
        } finally {
          loading = undefined;
        }
      })());
    }
    return demand;
  };
  const write = async (
    value: PreparedPoolPresenceDemand | null,
    expectedVersion: number,
    assertPolicyCurrent?: () => void,
  ) => {
    const assertCurrent = () => {
      current();
      assertPolicyCurrent?.();
      if (version !== expectedVersion) {
        throw new Error("Authenticated human presence changed during prepared-pool maintenance");
      }
    };
    assertCurrent();
    demand = await options.presenceDemandStore!.write(value, assertCurrent);
    loaded = true;
    assertCurrent();
  };
  const matches = (
    state: PreparedPoolPresenceDemand,
    source: NonNullable<ReturnType<typeof policy>>,
  ) =>
    state.profileId === source.profileId &&
    state.project.source.url === source.repository.url &&
    state.project.source.owner.agent.agentId === source.repository.agentId &&
    state.requestedRef === (source.repository.ref ?? null);

  const maintain = async () => {
    const expectedVersion = version;
    let state = await read();
    current();
    if (expectedVersion !== version) {
      throw new Error("Authenticated human presence changed during prepared-pool maintenance");
    }
    const source = policy();
    if (!source) {
      if (state) {
        await write(null, expectedVersion);
      }
      return undefined;
    }
    const assertPolicyCurrent = () => {
      current();
      if (!isDeepStrictEqual(policy(), source)) {
        throw new Error("Human-presence repository policy changed during preparation");
      }
    };
    if (state && !matches(state, source)) {
      await write(null, expectedVersion);
      state = undefined;
      refResolvedAtMs = undefined;
    }
    if (!humanPresent) {
      if (state?.retireAtMs === null) {
        const absentAtMs = humanPresenceObserved ? humanPresenceChangedAtMs : state.lastPresentAtMs;
        state = {
          ...state,
          revision: state.revision + 1,
          retireAtMs: absentAtMs + source.retireAfterMs,
        };
        await write(state, expectedVersion, assertPolicyCurrent);
      }
      return state;
    }
    const previous = state;
    const retained =
      previous &&
      matches(previous, source) &&
      refResolvedAtMs !== undefined &&
      now() - refResolvedAtMs < REPOSITORY_REF_REFRESH_INTERVAL_MS;
    // Refill reuses admitted content between bounded ref resolutions. Live
    // reserves must not pin a mutable ref indefinitely, including after restart.
    const resolutionStartedAtMs = now();
    const intent = await options.prepareIntent(source.profileId, {
      ...(retained && previous
        ? { projectRepository: previous.project }
        : { repository: source.repository }),
      executionMode: source.executionMode,
      signal,
    });
    current();
    if (expectedVersion !== version) {
      throw new Error("Authenticated human presence changed during repository preparation");
    }
    assertPolicyCurrent();
    const project = readWorkerProjectSnapshot(intent.profileSnapshot.project);
    const preparation = readWorkerProjectPreparation(intent.profileSnapshot.project);
    if (!project || !("source" in project) || !preparation) {
      throw new Error("Human-presence demand requires an admitted repository preparation");
    }
    state = {
      revision: (state?.revision ?? 0) + 1,
      profileId: source.profileId,
      requestedRef: source.repository.ref ?? null,
      preparationKey: preparation.key,
      project,
      lastPresentAtMs: now(),
      retireAtMs: null,
    };
    await write(state, expectedVersion, assertPolicyCurrent);
    if (!retained) {
      refResolvedAtMs = resolutionStartedAtMs;
    }
    const config = options.getConfig().cloudWorkers;
    const profile = config?.profiles?.[source.profileId];
    const providerId = profile && normalizeCapabilityProviderId(profile.provider);
    if (!profile || !providerId || providerId !== intent.providerId) {
      throw new Error("Human-presence worker profile changed during preparation");
    }
    const limits = {
      target: profile.readyWorkers ?? 1,
      maxTotal: config?.preparedPool?.maxTotal ?? 4,
    };
    const slots = store.preparedCapacity({
      profileId: source.profileId,
      projectKey: project.key,
      ...limits,
    });
    for (let index = 0; index < slots; index += 1) {
      const admitted = await store.ensurePreparedIntent({
        intent: {
          ...deriveEnvironmentIntent(`prepared:${randomUUID()}`),
          providerId,
          profileId: source.profileId,
          profileSnapshot: intent.profileSnapshot,
          preparation: {
            purpose: "reserve",
            key: preparation.key,
            demandAtMs: state.lastPresentAtMs,
            expiresAtMs: PRESENCE_RESERVE_EXPIRY_MS,
          },
        },
        projectKey: project.key,
        ...limits,
        assertCurrent: () => {
          current();
          assertPolicyCurrent();
          if (expectedVersion !== version || !humanPresent) {
            throw new Error("Authenticated human presence changed before reserve admission");
          }
          options.assertIntentCurrent(source.profileId, intent);
        },
      });
      if (!admitted) {
        break;
      }
    }
    return state;
  };

  return {
    maintain,
    ready: read,
    current: () => {
      // A held repository admission must not extend the last browser's grace.
      // Persistence catches up through maintain; reads use the same observed departure.
      if (demand?.retireAtMs === null && !humanPresent) {
        const absentAtMs = humanPresenceObserved
          ? humanPresenceChangedAtMs
          : demand.lastPresentAtMs;
        return { ...demand, retireAtMs: absentAtMs + HUMAN_PRESENCE_RETIRE_AFTER_MS };
      }
      return demand;
    },
    matchesCurrentPolicy: (state: PreparedPoolPresenceDemand) => {
      const source = policy();
      return Boolean(source && matches(state, source));
    },
    set: (present: boolean) => {
      humanPresenceObserved = true;
      if (humanPresent !== present) {
        humanPresent = present;
        humanPresenceChangedAtMs = now();
        refResolvedAtMs = undefined;
        version += 1;
      }
      return options.schedule();
    },
    isPresent: () => humanPresent,
  };
}
