import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import { readImageReserveProject } from "./image-reserve.js";
import {
  readWorkerProjectPreparation,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import { readRepositoryWorkerProjectSnapshot } from "./repository-project-source.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

const HUMAN_PRESENCE_RETIRE_AFTER_MS = 15 * 60 * 1_000;
const REPOSITORY_REF_REFRESH_INTERVAL_MS = 60_000;
const PRESENCE_RESERVE_EXPIRY_MS = Number.MAX_SAFE_INTEGER;

export function matchingPreparedPoolPresenceDemand<
  T extends Pick<PreparedPoolPresenceDemand, "profileId" | "preparationKey" | "project">,
>(record: WorkerEnvironmentRecord, demand: T | undefined): T | undefined {
  return demand?.profileId === record.profileId &&
    demand.preparationKey === record.preparation?.key &&
    demand.project.key ===
      (
        readImageReserveProject(record.profileSnapshot.project) ??
        readWorkerProjectSnapshot(record.profileSnapshot.project)
      )?.key
    ? demand
    : undefined;
}

export function isSupersededPresenceReserve(
  record: WorkerEnvironmentRecord,
  demand: Pick<PreparedPoolPresenceDemand, "profileId" | "preparationKey" | "project"> | undefined,
): boolean {
  // Only the presence owner grants an unbounded reserve deadline.
  if (
    record.preparation?.purpose !== "reserve" ||
    record.preparation.consumedAtMs !== null ||
    record.preparation.expiresAtMs !== PRESENCE_RESERVE_EXPIRY_MS
  ) {
    return false;
  }
  return !matchingPreparedPoolPresenceDemand(record, demand);
}

export type StandingImageDemandSource = {
  profileId: string;
  executionMode: "worker-turn" | "remote-exec";
};

export type EffectivePreparedDemand = Pick<
  PreparedPoolPresenceDemand,
  "profileId" | "project" | "preparationKey" | "retireAtMs"
> & { demandAtMs: number; requestedRef?: string | null };

export type PreparedPoolPresenceOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  prepareIntent: (
    profileId: string,
    options: {
      projectRepository?: RepositoryWorkerProjectSnapshot;
      repository?: { agentId: string; url: string; ref?: string };
      imageReserve?: boolean;
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
  resolveStandingImageDemand?: () => StandingImageDemandSource | undefined;
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
  let standing:
    | {
        source: StandingImageDemandSource;
        policy: { providerId: string; target: number; maxTotal: number };
        intent: WorkerProviderPreparedIntent;
        demand: EffectivePreparedDemand;
      }
    | undefined;
  let refResolvedAtMs: number | undefined;
  const current = () => signal.throwIfAborted();
  const standingSource = () =>
    process.env.FACTORY_AUTH_MODE === "github" ? options.resolveStandingImageDemand?.() : undefined;
  const workerPolicy = (profileId: string) => {
    const config = options.getConfig().cloudWorkers;
    const profile = config?.profiles?.[profileId];
    const providerId = profile && normalizeCapabilityProviderId(profile.provider);
    return profile && providerId
      ? {
          providerId,
          target: profile.readyWorkers ?? 1,
          maxTotal: config?.preparedPool?.maxTotal ?? 4,
        }
      : undefined;
  };
  const readStanding = () => {
    if (
      !standing ||
      signal.aborted ||
      !isDeepStrictEqual(standing.source, standingSource()) ||
      !isDeepStrictEqual(standing.policy, workerPolicy(standing.source.profileId))
    ) {
      return undefined;
    }
    try {
      options.assertIntentCurrent(standing.source.profileId, standing.intent);
      return standing.demand;
    } catch {
      // A changed preparation cannot authorize image selection between maintenance passes.
      return undefined;
    }
  };
  const admitReserves = async (
    intent: WorkerProviderPreparedIntent,
    state: EffectivePreparedDemand,
    assertSourceCurrent: () => void,
  ) => {
    const limits = workerPolicy(state.profileId);
    if (!limits || limits.providerId !== intent.providerId) {
      throw new Error("Prepared-pool worker profile changed during preparation");
    }
    const assertCurrent = () => {
      current();
      assertSourceCurrent();
      if (!isDeepStrictEqual(limits, workerPolicy(state.profileId))) {
        throw new Error("Prepared-pool admission limits changed");
      }
      options.assertIntentCurrent(state.profileId, intent);
    };
    assertCurrent();
    const slots = store.preparedCapacity({
      profileId: state.profileId,
      projectKey: state.project.key,
      ...limits,
    });
    for (let index = 0; index < slots; index += 1) {
      const admitted = await store.ensurePreparedIntent({
        intent: {
          ...deriveEnvironmentIntent(`prepared:${randomUUID()}`),
          providerId: limits.providerId,
          profileId: state.profileId,
          profileSnapshot: intent.profileSnapshot,
          preparation: {
            purpose: "reserve",
            key: state.preparationKey,
            demandAtMs: state.demandAtMs,
            expiresAtMs: PRESENCE_RESERVE_EXPIRY_MS,
          },
        },
        projectKey: state.project.key,
        ...limits,
        assertCurrent,
      });
      assertCurrent();
      if (!admitted) {
        break;
      }
    }
  };
  const maintainStanding = async (source: StandingImageDemandSource) => {
    const limits = workerPolicy(source.profileId);
    if (!limits || limits.target <= 0 || limits.maxTotal <= 0) {
      standing = undefined;
      return undefined;
    }
    const assertCurrent = () => {
      current();
      if (
        !isDeepStrictEqual(source, standingSource()) ||
        !isDeepStrictEqual(limits, workerPolicy(source.profileId))
      ) {
        throw new Error("Standing image demand changed during preparation");
      }
    };
    assertCurrent();
    const preparedAtMs = now();
    const intent = await options.prepareIntent(source.profileId, {
      imageReserve: true,
      executionMode: source.executionMode,
      signal,
    });
    assertCurrent();
    options.assertIntentCurrent(source.profileId, intent);
    const project = readImageReserveProject(intent.profileSnapshot.project);
    const preparation = readWorkerProjectPreparation(intent.profileSnapshot.project);
    if (!project || !preparation) {
      throw new Error("Standing demand requires an admitted image preparation");
    }
    const state: EffectivePreparedDemand = {
      profileId: source.profileId,
      project,
      preparationKey: preparation.key,
      demandAtMs: preparedAtMs,
      retireAtMs: null,
    };
    standing = { source, policy: limits, intent, demand: state };
    await admitReserves(intent, state, assertCurrent);
    return state;
  };
  const policy = () => {
    const source = options.resolveHumanPresenceDemand?.();
    if (!source || !options.presenceDemandStore) {
      return undefined;
    }
    return {
      ...source,
      imageOnly: process.env.FACTORY_AUTH_MODE === "github",
      retireAfterMs: HUMAN_PRESENCE_RETIRE_AFTER_MS,
    };
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
    state: Pick<PreparedPoolPresenceDemand, "profileId" | "project"> & {
      requestedRef?: string | null;
    },
    source: NonNullable<ReturnType<typeof policy>>,
  ) =>
    state.profileId === source.profileId &&
    (readImageReserveProject(state.project)
      ? source.imageOnly
      : !source.imageOnly &&
        "source" in state.project &&
        state.project.source.url === source.repository.url &&
        state.project.source.owner.agent.agentId === source.repository.agentId &&
        state.requestedRef === (source.repository.ref ?? null));

  const maintain = async () => {
    const configuredStanding = standingSource();
    if (configuredStanding) {
      return maintainStanding({ ...configuredStanding });
    }
    standing = undefined;
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
          retireAtMs: absentAtMs + HUMAN_PRESENCE_RETIRE_AFTER_MS,
        };
        await write(state, expectedVersion, assertPolicyCurrent);
      }
      return state && { ...state, demandAtMs: state.lastPresentAtMs };
    }
    const previous = state;
    const imageOnly = source.imageOnly;
    const retained =
      previous &&
      matches(previous, source) &&
      refResolvedAtMs !== undefined &&
      now() - refResolvedAtMs < REPOSITORY_REF_REFRESH_INTERVAL_MS;
    // Refill reuses admitted content between bounded ref resolutions. Live
    // reserves must not pin a mutable ref indefinitely, including after restart.
    const resolutionStartedAtMs = now();
    const intent = await options.prepareIntent(source.profileId, {
      ...(imageOnly
        ? { imageReserve: true }
        : retained && previous && "source" in previous.project
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
    const project = imageOnly
      ? readImageReserveProject(intent.profileSnapshot.project)
      : readRepositoryWorkerProjectSnapshot(intent.profileSnapshot.project);
    const preparation = readWorkerProjectPreparation(intent.profileSnapshot.project);
    if (!project || !preparation) {
      throw new Error("Human-presence demand requires an admitted repository preparation");
    }
    state = {
      revision: (state?.revision ?? 0) + 1,
      profileId: source.profileId,
      requestedRef: imageOnly ? null : (source.repository.ref ?? null),
      preparationKey: preparation.key,
      project,
      lastPresentAtMs: now(),
      retireAtMs: null,
    };
    await write(state, expectedVersion, assertPolicyCurrent);
    if (!retained) {
      refResolvedAtMs = resolutionStartedAtMs;
    }
    const effective = { ...state, demandAtMs: state.lastPresentAtMs };
    await admitReserves(intent, effective, () => {
      assertPolicyCurrent();
      if (expectedVersion !== version || !humanPresent) {
        throw new Error("Authenticated human presence changed before reserve admission");
      }
    });
    return effective;
  };

  return {
    maintain,
    ready: read,
    current: (): EffectivePreparedDemand | undefined => {
      if (standing || standingSource()) {
        return readStanding();
      }
      // A held repository admission must not extend the last browser's grace.
      // Persistence catches up through maintain; reads use the same observed departure.
      if (demand?.retireAtMs === null && !humanPresent) {
        const absentAtMs = humanPresenceObserved
          ? humanPresenceChangedAtMs
          : demand.lastPresentAtMs;
        return {
          ...demand,
          demandAtMs: demand.lastPresentAtMs,
          retireAtMs: absentAtMs + HUMAN_PRESENCE_RETIRE_AFTER_MS,
        };
      }
      return demand && { ...demand, demandAtMs: demand.lastPresentAtMs };
    },
    matchesCurrentPolicy: (state: EffectivePreparedDemand) => {
      if (standing || standingSource()) {
        const admitted = readStanding();
        return Boolean(
          admitted &&
          state.profileId === admitted.profileId &&
          state.preparationKey === admitted.preparationKey &&
          state.project.key === admitted.project.key,
        );
      }
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
    isActive: () => readStanding() !== undefined || humanPresent,
  };
}
