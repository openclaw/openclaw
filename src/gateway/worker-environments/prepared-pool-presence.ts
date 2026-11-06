import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.js";
import { getRepositoryIntegration } from "../../plugins/repository-integration-runtime.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import {
  readWorkerPreparation,
  workerPreparationSourceKey,
} from "./preparation-identity.schema.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

const HUMAN_PRESENCE_RETIRE_AFTER_MS = 15 * 60 * 1_000;
const REPOSITORY_REF_REFRESH_INTERVAL_MS = 60_000;
const PRESENCE_RESERVE_EXPIRY_MS = Number.MAX_SAFE_INTEGER;

type StandingImageDemand = {
  sourceKey: "image";
  profileId: string;
  preparationKey: string;
  lastPresentAtMs: number;
  retireAtMs: null;
};
type EffectivePreparedDemand = PreparedPoolPresenceDemand | StandingImageDemand;

export function preparedDemandSourceKey(demand: EffectivePreparedDemand): string {
  return "sourceKey" in demand ? demand.sourceKey : demand.project.key;
}

export function matchingPreparedPoolPresenceDemand(
  record: WorkerEnvironmentRecord,
  demand: EffectivePreparedDemand | undefined,
): EffectivePreparedDemand | undefined {
  return demand?.profileId === record.profileId &&
    demand.preparationKey === record.preparation?.key &&
    preparedDemandSourceKey(demand) === workerPreparationSourceKey(record.profileSnapshot)
    ? demand
    : undefined;
}

export function isSupersededPresenceReserve(
  record: WorkerEnvironmentRecord,
  demand: EffectivePreparedDemand | undefined,
): boolean {
  // Only managed demand admission grants an unbounded reserve deadline.
  if (
    record.preparation?.purpose !== "reserve" ||
    record.preparation.expiresAtMs !== PRESENCE_RESERVE_EXPIRY_MS
  ) {
    return false;
  }
  return !matchingPreparedPoolPresenceDemand(record, demand);
}

export type PreparedPoolPresenceOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  prepareIntent: (
    profileId: string,
    options: {
      imageReserve?: true;
      projectRepository?: RepositoryWorkerProjectSnapshot;
      repository?: { agentId: string; url: string; ref?: string };
      executionMode?: "worker-turn" | "remote-exec";
      assertCurrent?: () => void;
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
  let loaded = false;
  let loading: Promise<void> | undefined;
  let demand: PreparedPoolPresenceDemand | undefined;
  let refResolvedAtMs: number | undefined;
  let standing:
    | {
        intent: WorkerProviderPreparedIntent;
        demand: StandingImageDemand;
      }
    | undefined;
  let reconstructing: ((record: WorkerEnvironmentRecord) => boolean) | undefined;
  const current = () => signal.throwIfAborted();
  const policy = () => {
    const source = options.resolveHumanPresenceDemand?.();
    return source &&
      options.presenceDemandStore &&
      options.getConfig().cloudWorkers?.profiles?.[source.profileId]?.workspaceDurability?.mode !==
        "retained-disk"
      ? { ...source }
      : undefined;
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
  const write = async (value: PreparedPoolPresenceDemand | null) => {
    demand = await options.presenceDemandStore!.write(value, current);
    loaded = true;
  };
  const matches = (
    state: PreparedPoolPresenceDemand,
    source: NonNullable<ReturnType<typeof policy>>,
  ) =>
    state.profileId === source.profileId &&
    state.project.source.url === source.repository.url &&
    state.project.source.owner.agent.agentId === source.repository.agentId &&
    state.requestedRef === (source.repository.ref ?? null);

  const captureImagePolicy = () => {
    const integration = getRepositoryIntegration();
    if (integration?.preparedCapacity !== "image") {
      throw new Error("Runtime image capacity policy is unavailable");
    }
    return () => {
      current();
      if (getRepositoryIntegration() !== integration) {
        throw new Error("Runtime image capacity policy changed during preparation");
      }
    };
  };
  const standingSource = () => {
    if (getRepositoryIntegration()?.preparedCapacity !== "image") {
      return undefined;
    }
    const source = options.resolveHumanPresenceDemand?.();
    return source &&
      options.getConfig().cloudWorkers?.profiles?.[source.profileId]?.workspaceDurability?.mode !==
        "retained-disk"
      ? { profileId: source.profileId, executionMode: source.executionMode }
      : undefined;
  };
  const standingLimits = (profileId: string) => {
    const config = options.getConfig().cloudWorkers;
    const profile = config?.profiles?.[profileId];
    return (
      profile && {
        target:
          profile.workspaceDurability?.mode === "retained-disk" ? 0 : (profile.readyWorkers ?? 1),
        maxTotal: config?.preparedPool?.maxTotal ?? 4,
      }
    );
  };
  const readStanding = () => {
    if (!standing || signal.aborted) {
      return undefined;
    }
    options.assertIntentCurrent(standing.demand.profileId, standing.intent);
    return standing.demand;
  };
  const admitReserves = async (
    intent: WorkerProviderPreparedIntent,
    active: EffectivePreparedDemand,
    limits: { target: number; maxTotal: number },
    assertDemandCurrent: () => void,
  ) => {
    const sourceKey = preparedDemandSourceKey(active);
    const slots = store.preparedCapacity({
      profileId: active.profileId,
      projectKey: sourceKey,
      ...limits,
    });
    for (let index = 0; index < slots; index += 1) {
      const admitted = await store.ensurePreparedIntent({
        intent: {
          ...deriveEnvironmentIntent(`prepared:${randomUUID()}`),
          providerId: intent.providerId,
          profileId: active.profileId,
          profileSnapshot: intent.profileSnapshot,
          preparation: {
            purpose: "reserve",
            key: active.preparationKey,
            demandAtMs: active.lastPresentAtMs,
            expiresAtMs: PRESENCE_RESERVE_EXPIRY_MS,
          },
        },
        projectKey: sourceKey,
        ...limits,
        assertCurrent: () => {
          current();
          assertDemandCurrent();
          options.assertIntentCurrent(active.profileId, intent);
        },
      });
      if (!admitted) {
        break;
      }
    }
  };
  const maintainStanding = async () => {
    const source = standingSource();
    const limits = source && standingLimits(source.profileId);
    if (!source || !limits || limits.target <= 0 || limits.maxTotal <= 0) {
      standing = undefined;
      return undefined;
    }
    const assertPolicyCurrent = captureImagePolicy();
    const assertSourceCurrent = () => {
      assertPolicyCurrent();
      if (
        !isDeepStrictEqual(source, standingSource()) ||
        !isDeepStrictEqual(limits, standingLimits(source.profileId))
      ) {
        throw new Error("Standing runtime capacity policy changed during preparation");
      }
    };
    assertSourceCurrent();
    if (!standing) {
      reconstructing = (record) => {
        try {
          assertSourceCurrent();
          return (
            record.profileId === source.profileId &&
            record.profileSnapshot.executionMode === source.executionMode &&
            workerPreparationSourceKey(record.profileSnapshot) === "image" &&
            record.preparation?.purpose === "reserve"
          );
        } catch {
          return false;
        }
      };
    }
    try {
      const preparedAtMs = now();
      const intent = await options.prepareIntent(source.profileId, {
        imageReserve: true,
        executionMode: source.executionMode,
        assertCurrent: assertSourceCurrent,
        signal,
      });
      assertSourceCurrent();
      options.assertIntentCurrent(source.profileId, intent);
      const preparation = readWorkerPreparation(intent.profileSnapshot);
      if (workerPreparationSourceKey(intent.profileSnapshot) !== "image" || !preparation) {
        throw new Error("Standing demand requires an admitted runtime preparation");
      }
      const active: StandingImageDemand = {
        sourceKey: "image",
        profileId: source.profileId,
        preparationKey: preparation.key,
        lastPresentAtMs: preparedAtMs,
        retireAtMs: null,
      };
      standing = { intent, demand: active };
      await admitReserves(intent, active, limits, assertSourceCurrent);
      return active;
    } finally {
      reconstructing = undefined;
    }
  };
  const maintain = async () => {
    let state = await read();
    current();
    if (getRepositoryIntegration()?.preparedCapacity === "image") {
      // Standing capacity carries runtime facts only; repository authority belongs to session claim.
      if (state) {
        await write(null);
      }
      return maintainStanding();
    }
    standing = undefined;
    const source = policy();
    if (!source) {
      if (state) {
        await write(null);
      }
      return undefined;
    }
    if (state && !matches(state, source)) {
      await write(null);
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
        await write(state);
      }
      return state;
    }
    const config = options.getConfig().cloudWorkers;
    const profile = config?.profiles?.[source.profileId];
    if (!profile) {
      throw new Error("Human-presence worker profile changed during preparation");
    }
    const limits = {
      target:
        profile.workspaceDurability?.mode === "retained-disk" ? 0 : (profile.readyWorkers ?? 1),
      maxTotal: config?.preparedPool?.maxTotal ?? 4,
    };
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
    const admittedProject = intent.profileSnapshot.project;
    const preparation = admittedProject?.preparation;
    if (!admittedProject || !("source" in admittedProject) || !preparation) {
      throw new Error("Human-presence demand requires an admitted repository preparation");
    }
    const { preparation: _preparation, ...project } = admittedProject;
    state = {
      revision: (state?.revision ?? 0) + 1,
      profileId: source.profileId,
      requestedRef: source.repository.ref ?? null,
      preparationKey: preparation.key,
      project,
      lastPresentAtMs: now(),
      retireAtMs: null,
    };
    await write(state);
    if (!retained) {
      refResolvedAtMs = resolutionStartedAtMs;
    }
    await admitReserves(intent, state, limits, () => {
      if (!humanPresent) {
        throw new Error("Authenticated human presence changed before reserve admission");
      }
    });
    return state;
  };

  const currentDemand = (): EffectivePreparedDemand | undefined => {
    try {
      if (getRepositoryIntegration()?.preparedCapacity === "image") {
        return readStanding();
      }
      // A held repository admission must not extend the last browser's grace.
      // Persistence catches up through maintain; reads use the same observed departure.
      if (demand?.retireAtMs === null && !humanPresent) {
        const absentAtMs = humanPresenceObserved
          ? humanPresenceChangedAtMs
          : demand.lastPresentAtMs;
        return { ...demand, retireAtMs: absentAtMs + HUMAN_PRESENCE_RETIRE_AFTER_MS };
      }
      return demand;
    } catch {
      // Unavailable policy refuses demand, never inventory expiry or physical cleanup.
      // maintain still reports the admission failure and owns its retry/settlement.
      return undefined;
    }
  };

  return {
    maintain,
    ready: read,
    current: currentDemand,
    captureImagePolicy,
    // A pass keeps its reconstruction observation until it finishes, even if admission
    // settles meanwhile. This preserves inventory only, never authorizes provider I/O.
    captureReconstruction: () => reconstructing,
    set: (present: boolean) => {
      humanPresenceObserved = true;
      if (humanPresent !== present) {
        humanPresent = present;
        humanPresenceChangedAtMs = now();
        refResolvedAtMs = undefined;
      }
      return options.schedule();
    },
    isDemandActive: () => {
      const active = currentDemand();
      return active?.retireAtMs === null && (humanPresent || "sourceKey" in active);
    },
  };
}
