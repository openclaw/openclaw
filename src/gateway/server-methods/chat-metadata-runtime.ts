import { withAgentRosterFactsBatch } from "../../agents/agent-scope-config.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { getPreparedRuntimeAuthProfileStoreSnapshot } from "../../agents/auth-profiles.js";
import { getRuntimeAuthProfileStoreMetadataRevision } from "../../agents/auth-profiles/runtime-snapshots.js";
import {
  getPublishedPreparedModelCatalogOwnerSnapshot,
  withPreparedModelRuntimeReadBatch,
} from "../../agents/prepared-model-catalog.js";
import { getPreparedModelFullCatalogAuth } from "../../agents/prepared-model-runtime-auth.js";
import { getPreparedModelRuntimeStartupStatus } from "../../agents/prepared-model-runtime.startup-status.js";
import { resolveSwarmConfig } from "../../agents/subagents/swarm/swarm-config.js";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { getSkillsSnapshotVersion } from "../../skills/runtime/refresh-state.js";
import {
  assertAgentDatabaseAdmitted,
  readAgentDatabaseAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { listUserProfileAuthLinks } from "../../state/user-model-accounts.js";
import { resolveChatAccountSelection } from "./chat-account-selection.js";
import type {
  ChatMetadataReadParams,
  ChatMetadataResult,
  ChatMetadataSessionEntry,
} from "./chat-metadata-contract.js";
import {
  generationFactsMatch,
  type ChatMetadataRuntimeDeps,
  type PreparedAgentFacts,
  type PreparedGenerationFacts,
} from "./chat-metadata-facts.js";
import {
  hasSessionCatalogContext,
  prepareChatMetadataModelProjection,
  sessionProjectionKey,
  resolveSessionCatalogProfiles,
  projectChatSessionMetadata,
} from "./chat-metadata-session-projection.js";
import type {
  ChatStartupProjectionReadParams,
  ChatStartupProjectionResult,
} from "./chat-startup-projection-contract.js";
import type { GatewayModelCatalogContext } from "./models-list-context.js";

type PreparedAgentMetadata = PreparedAgentFacts & {
  commands?: unknown[];
  swarmEnabled: boolean;
};

type PreparedProjection<T> = { read: () => T; isCurrent: () => boolean };

type PreparedChatMetadataProjection = Awaited<
  ReturnType<ChatMetadataRuntimeDeps["buildProjection"]>
> & {
  agent: PreparedAgentMetadata;
};

type AgentProjectionEntry =
  | { state: "pending"; promise: Promise<PreparedChatMetadataProjection> }
  | { state: "ready"; projection: PreparedChatMetadataProjection };

type PreparedMetadataGeneration = {
  epoch: number;
  facts: PreparedGenerationFacts;
  agentsById: Map<string, Promise<PreparedAgentMetadata>>;
  neutralProjectionByAgentId: Map<string, AgentProjectionEntry>;
  sessionProjectionByKey: Map<string, AgentProjectionEntry>;
};

type ChatMetadataRefreshOptions = { notifyIfUnchanged?: boolean };

const CHAT_METADATA_CACHE_MAX_ENTRIES = 64;

function readPreparedChatMetadata(
  projection: PreparedChatMetadataProjection,
  readParams: ChatMetadataReadParams,
  config: OpenClawConfig,
): ChatMetadataResult {
  readParams.draftAccountSelection?.assertCurrent();
  const { agent } = projection;
  return projectChatSessionMetadata(
    readParams,
    {
      ...projection.read(),
      ...(agent.commands !== undefined ? { commands: agent.commands } : {}),
      swarmEnabled: agent.swarmEnabled,
      accountSelection: resolveChatAccountSelection({
        authStore: agent.authStore,
        sessionEntry: readParams.sessionEntry,
        requesterProfileId: readParams.requesterProfileId,
      }),
    },
    config,
  );
}

export class ChatMetadataSnapshotUnavailableError extends Error {
  constructor(message = "prepared chat metadata snapshot is unavailable") {
    super(message);
    this.name = "ChatMetadataSnapshotUnavailableError";
  }
}

function captureGenerationFacts(deps: ChatMetadataRuntimeDeps): PreparedGenerationFacts {
  const config = deps.getConfig();
  const agents = withPreparedModelRuntimeReadBatch(() =>
    withAgentRosterFactsBatch(config, () =>
      listAgentIds(config)
        .filter((agentId) => !readAgentDatabaseAdmissionRefusal(agentId))
        .flatMap((rawAgentId): PreparedAgentFacts[] => {
          const agentId = normalizeAgentId(rawAgentId);
          // Metadata follows the published lifecycle owner while its replacement gate owns turnover;
          // display-only config publications must not make that still-current owner disappear.
          const owner = deps.getPreparedOwner({ agentId, config });
          if (!owner) {
            if (getPreparedModelRuntimeStartupStatus()?.degraded) {
              return [];
            }
            throw new ChatMetadataSnapshotUnavailableError(
              `prepared chat metadata owner is unavailable for agent "${agentId}"`,
            );
          }
          const workspaceDir = owner.workspaceDir ?? resolveAgentWorkspaceDir(config, agentId);
          const fullModelCatalog = owner.readFullModelCatalog?.();
          const fullCatalogAuth = fullModelCatalog
            ? getPreparedModelFullCatalogAuth(fullModelCatalog)
            : undefined;
          if (fullModelCatalog && !fullCatalogAuth) {
            throw new Error("prepared full model catalog omitted its auth generation");
          }
          const catalog = fullModelCatalog ?? owner.modelCatalog;
          return [
            {
              agentId,
              owner,
              authStore: fullCatalogAuth?.authStore ??
                deps.getPreparedAuthStore(owner.agentDir, owner.inheritedAuthDir) ?? {
                  version: 1,
                  profiles: {},
                },
              authModes: fullCatalogAuth?.authModes ?? owner.authModes,
              authStoreRevision: `${deps.getAuthStoreRevision(owner.agentDir)}:${deps.getAuthStoreRevision(owner.inheritedAuthDir)}`,
              modelCatalog: catalog,
              // Failure is visible metadata; in-flight discovery does not invalidate usable rows.
              catalogRefreshFailed: catalog.refreshFailed === true,
              skillsVersion: deps.getSkillsVersion(workspaceDir),
            },
          ];
        }),
    ),
  );
  return {
    config,
    configKey: resolveRuntimeConfigCacheKey(config),
    pluginRegistryVersion: deps.getPluginRegistryVersion(),
    agents,
  };
}

export function createGatewayChatMetadataRuntime(params: {
  getConfig: () => OpenClawConfig;
  getContext: () => GatewayModelCatalogContext;
  beforeRefresh?: () => Promise<void>;
  onChanged?: () => void;
  refreshOnRead?: boolean;
  log: {
    warn: (message: string) => void;
  };
  deps?: Partial<ChatMetadataRuntimeDeps>;
}): {
  invalidate: () => void;
  fail: (error: unknown) => void;
  refresh: (options?: ChatMetadataRefreshOptions) => Promise<void>;
  stop: () => Promise<void>;
  read: (params: ChatMetadataReadParams) => Promise<ChatMetadataResult>;
  readStartup: (
    params: ChatStartupProjectionReadParams,
  ) => Promise<ChatStartupProjectionResult | undefined>;
} {
  const deps: ChatMetadataRuntimeDeps = {
    getConfig: params.getConfig,
    getContext: params.getContext,
    getPreparedOwner: getPublishedPreparedModelCatalogOwnerSnapshot,
    getPreparedAuthStore: getPreparedRuntimeAuthProfileStoreSnapshot,
    getAuthStoreRevision: getRuntimeAuthProfileStoreMetadataRevision,
    getSkillsVersion: getSkillsSnapshotVersion,
    getPluginRegistryVersion: getActivePluginRegistryVersion,
    buildCommands: async ({ cfg, agentId }) => {
      const { buildCommandsListResult } = await import("./commands-list-result.js");
      return buildCommandsListResult({ cfg, agentId, includeArgs: true, scope: "text" });
    },
    buildProjection: prepareChatMetadataModelProjection,
    ...params.deps,
  };
  let current: PreparedMetadataGeneration | undefined;
  let lastError: Error | undefined;
  let replacement: Deferred | undefined;
  let invalidationEpoch = 0;
  let refreshVersion = 0;
  let lastSettlement: PreparedMetadataGeneration | number | undefined;
  let refreshTail: Promise<void> = Promise.resolve();
  let stoppedError: ChatMetadataSnapshotUnavailableError | undefined;
  const activeWork = new Set<Promise<unknown>>();
  const trackWork = <T>(work: Promise<T>): Promise<T> => {
    activeWork.add(work);
    const settled = () => activeWork.delete(work);
    void work.then(settled, settled);
    return work;
  };
  const assertOpen = () => {
    if (stoppedError) {
      throw stoppedError;
    }
  };
  let pending:
    | {
        facts?: PreparedGenerationFacts;
        promise: Promise<void>;
        generationReady: Deferred;
        notifyIfUnchanged: boolean;
      }
    | undefined;

  const projectAgent = async (
    generation: PreparedMetadataGeneration,
    agent: PreparedAgentMetadata,
    sessionEntry?: ChatMetadataSessionEntry,
    requesterProfileId?: string,
    assertCurrent?: () => void,
    useRequesterDefaults = false,
  ): Promise<PreparedChatMetadataProjection> => {
    assertOpen();
    assertCurrent?.();
    // Retired owners cannot produce a fresh projection; only publication can replace their facts.
    if (!agent.owner.isCurrent()) {
      throw new ChatMetadataSnapshotUnavailableError(
        `prepared chat metadata owner retired for agent "${agent.agentId}"`,
      );
    }
    const profiles = resolveSessionCatalogProfiles(sessionEntry, agent.owner.config, agent.agentId);
    const neutral = !hasSessionCatalogContext(profiles);
    // Read links on every draft request so connecting an account takes effect immediately;
    // viewers without personal defaults can reuse the already-published neutral projection.
    const defaultProfileId =
      useRequesterDefaults &&
      !profiles.preferredProfileId &&
      requesterProfileId &&
      listUserProfileAuthLinks(requesterProfileId).length > 0
        ? requesterProfileId
        : undefined;
    // Personal selections and credentials can change without publishing a shared auth
    // generation. Keep those projections request-local, including linked session pins.
    const requestScoped =
      (!profiles.preferredProfileId && defaultProfileId) ||
      isUserModelAuthProfileId(profiles.preferredProfileId ?? "");
    const projections = requestScoped
      ? new Map<string, AgentProjectionEntry>()
      : neutral
        ? generation.neutralProjectionByAgentId
        : generation.sessionProjectionByKey;
    const key = neutral ? agent.agentId : sessionProjectionKey(agent.agentId, profiles);
    const existing = projections.get(key);
    if (existing) {
      const prepared = existing.state === "ready" ? existing.projection : await existing.promise;
      if (prepared.isCurrent()) {
        return prepared;
      }
      if (projections.get(key) === existing) {
        projections.delete(key);
      }
      return projectAgent(
        generation,
        agent,
        sessionEntry,
        requesterProfileId,
        assertCurrent,
        useRequesterDefaults,
      );
    }
    const projection = deps
      .buildProjection({
        context: deps.getContext(),
        facts: agent,
        requesterProfileId: defaultProfileId,
        ...(assertCurrent ? { assertCurrent } : {}),
        ...profiles,
      })
      .then((prepared) => {
        assertCurrent?.();
        // Shared catalogs retain agent facts, never the caller's entry or authority closure.
        const preparedProjection: PreparedChatMetadataProjection = {
          ...prepared,
          agent,
        };
        // Only this pending entry may publish its settlement; eviction or invalidation
        // must not let an obsolete completion replace a newer profile projection.
        if (generation.epoch === invalidationEpoch && projections.get(key) === entry) {
          projections.set(key, { state: "ready", projection: preparedProjection });
        }
        return preparedProjection;
      })
      .catch((error: unknown) => {
        if (projections.get(key) === entry) {
          projections.delete(key);
        }
        throw error;
      });
    void trackWork(projection);
    const entry: AgentProjectionEntry = { state: "pending", promise: projection };
    projections.set(key, entry);
    // Cold history reads omit evicted projections; canonical reads prepare them on demand.
    pruneMapToMaxSize(projections, CHAT_METADATA_CACHE_MAX_ENTRIES);
    return projection;
  };

  const prepareAgent = (generation: PreparedMetadataGeneration, agentId: string) => {
    const existing = generation.agentsById.get(agentId);
    if (existing) {
      return existing;
    }
    const agent = generation.facts.agents.find((candidate) => candidate.agentId === agentId);
    if (!agent) {
      return undefined;
    }
    const preparing: Promise<PreparedAgentMetadata> = trackWork(
      (async (): Promise<PreparedAgentMetadata> => {
        let commands: unknown[] | undefined;
        try {
          commands = (await deps.buildCommands({ cfg: generation.facts.config, agentId })).commands;
        } catch (error) {
          params.log.warn(
            `chat metadata continuing without text commands for ${agentId}: ${formatErrorMessage(error)}`,
          );
        }
        return {
          ...agent,
          ...(commands !== undefined ? { commands } : {}),
          swarmEnabled: resolveSwarmConfig(generation.facts.config, agentId).enabled,
        };
      })().catch((error: unknown) => {
        if (generation.agentsById.get(agentId) === preparing) {
          generation.agentsById.delete(agentId);
        }
        throw error;
      }),
    );
    generation.agentsById.set(agentId, preparing);
    pruneMapToMaxSize(generation.agentsById, CHAT_METADATA_CACHE_MAX_ENTRIES);
    return preparing;
  };

  const runRefresh = async (version: number) => {
    if (version !== refreshVersion) {
      return;
    }
    assertOpen();
    try {
      await params.beforeRefresh?.();
      if (version !== refreshVersion) {
        return;
      }
      const facts = captureGenerationFacts(deps);
      if (current && generationFactsMatch(current.facts, facts)) {
        return;
      }
      // Publication carries owner facts only. Commands and model projections belong to reads.
      current = {
        epoch: invalidationEpoch,
        facts,
        agentsById: new Map(),
        neutralProjectionByAgentId: new Map(),
        sessionProjectionByKey: new Map(),
      };
    } catch (error) {
      // Invalidation and stop revoke old preparation, including its failures.
      // Only the current refresh may settle the replacement's readers.
      if (version !== refreshVersion) {
        return;
      }
      throw error;
    }
  };

  const refresh = (options: ChatMetadataRefreshOptions = {}): Promise<void> => {
    if (stoppedError) {
      return Promise.reject(stoppedError);
    }
    let facts: PreparedGenerationFacts | undefined;
    if (params.beforeRefresh) {
      if (pending) {
        pending.notifyIfUnchanged ||= options.notifyIfUnchanged === true;
        return pending.promise;
      }
    } else {
      try {
        facts = captureGenerationFacts(deps);
      } catch (error) {
        const refreshError = error instanceof Error ? error : new Error(formatErrorMessage(error));
        fail(refreshError);
        return Promise.reject(refreshError);
      }
      if (current && generationFactsMatch(current.facts, facts)) {
        // A settled attempt can clear progress cached by models.list or models.snapshot readers
        // without changing any prepared model/command facts. Wake them without retiring the cache.
        if (options.notifyIfUnchanged) {
          params.onChanged?.();
        }
        return Promise.resolve();
      }
      if (pending?.facts && generationFactsMatch(pending.facts, facts)) {
        pending.notifyIfUnchanged ||= options.notifyIfUnchanged === true;
        return pending.promise;
      }
      if (current || pending) {
        // Fence reads synchronously only after proving the published facts changed. A suspended
        // session projection must not return its old success or failure while replacement builds.
        invalidate();
      }
    }
    const version = ++refreshVersion;
    const promise = refreshTail.catch(() => {}).then(() => runRefresh(version));
    refreshTail = promise;
    const generationReady = createDeferredCore();
    pending = {
      ...(facts ? { facts } : {}),
      promise,
      generationReady,
      notifyIfUnchanged: options.notifyIfUnchanged === true,
    };
    void promise.then(
      () => {
        generationReady.resolve();
        if (pending?.promise !== promise) {
          return;
        }
        const notifyIfUnchanged = pending.notifyIfUnchanged;
        pending = undefined;
        // Only the current generation may settle its replacement wait.
        if (current?.epoch !== invalidationEpoch) {
          return;
        }
        lastError = undefined;
        const committedReplacement = replacement;
        replacement = undefined;
        committedReplacement?.resolve();
        if (lastSettlement !== current || notifyIfUnchanged) {
          lastSettlement = current;
          params.onChanged?.();
        }
      },
      (error: unknown) => {
        generationReady.resolve();
        if (pending?.promise !== promise) {
          return;
        }
        pending = undefined;
        fail(error);
      },
    );
    return promise;
  };

  const authStoresCurrent = (generation: PreparedMetadataGeneration) =>
    generation.facts.agents.every(
      ({ owner, authStoreRevision }) =>
        authStoreRevision ===
        `${deps.getAuthStoreRevision(owner.agentDir)}:${deps.getAuthStoreRevision(owner.inheritedAuthDir)}`,
    );
  const isCurrentGeneration = (generation: PreparedMetadataGeneration) =>
    current === generation &&
    generation.epoch === invalidationEpoch &&
    authStoresCurrent(generation);

  const readCurrent = async <Result>(
    project: (generation: PreparedMetadataGeneration) => Promise<PreparedProjection<Result>>,
  ): Promise<Result> => {
    for (;;) {
      assertOpen();
      const preparation = pending;
      if (preparation) {
        await preparation.generationReady.promise;
        continue;
      }
      let generation = current;
      const replacementPromise = replacement?.promise;
      if (!generation && replacementPromise) {
        await replacementPromise;
        continue;
      }
      // Unavailable means the prepared owner was missing, not that publication failed.
      // Retry capture so a later published owner is not hidden behind lastError.
      const retryUnavailableOwner = lastError instanceof ChatMetadataSnapshotUnavailableError;
      if (!generation && (params.refreshOnRead || retryUnavailableOwner)) {
        await refresh();
        generation = current;
      }
      if (!generation) {
        if (lastError) {
          throw lastError;
        }
        throw new ChatMetadataSnapshotUnavailableError();
      }
      if (!params.refreshOnRead && !authStoresCurrent(generation)) {
        await refresh();
        continue;
      }
      if (params.refreshOnRead) {
        let latest: PreparedGenerationFacts | undefined;
        try {
          latest = captureGenerationFacts(deps);
        } catch {
          await refresh();
          generation = current;
        }
        if (latest && generation && !generationFactsMatch(generation.facts, latest)) {
          await refresh();
          generation = current;
        }
      }
      if (!generation) {
        throw new ChatMetadataSnapshotUnavailableError();
      }
      if (params.refreshOnRead) {
        const latest = captureGenerationFacts(deps);
        if (!generationFactsMatch(generation.facts, latest)) {
          throw new ChatMetadataSnapshotUnavailableError(
            "prepared chat metadata snapshot is stale while its replacement is publishing",
          );
        }
      }
      try {
        const readProjection = await project(generation);
        // Lazy projections may outlive their generation. Never return an obsolete success after
        // invalidation; retry through the replacement gate so the caller sees one coherent epoch.
        if (isCurrentGeneration(generation) && readProjection.isCurrent()) {
          return readProjection.read();
        }
      } catch (error) {
        if (isCurrentGeneration(generation)) {
          throw error;
        }
      }
    }
  };

  const read = async (readParams: ChatMetadataReadParams): Promise<ChatMetadataResult> => {
    assertAgentDatabaseAdmitted(readParams.agentId);
    const draft = readParams.draftAccountSelection;
    const sessionEntry: ChatMetadataSessionEntry | undefined = draft
      ? { authProfileOverride: draft.authProfileId, authProfileOverrideSource: "user" }
      : readParams.sessionEntry;
    return await readCurrent(async (generation) => {
      const agentId = normalizeAgentId(readParams.agentId);
      const agent = await prepareAgent(generation, agentId);
      if (!agent) {
        throw new ChatMetadataSnapshotUnavailableError(
          `prepared chat metadata is unavailable for agent "${agentId}"`,
        );
      }
      const projection = await projectAgent(
        generation,
        agent,
        sessionEntry,
        draft?.owner ?? readParams.requesterProfileId,
        draft?.assertCurrent,
        // Existing sessions use their saved selection, never a viewer's newer default.
        !readParams.sessionKey && !readParams.sessionEntry,
      );
      return {
        isCurrent: projection.isCurrent,
        read: () =>
          readPreparedChatMetadata(
            projection,
            {
              ...readParams,
              sessionEntry,
              requesterProfileId: draft?.owner ?? readParams.requesterProfileId,
            },
            deps.getConfig(),
          ),
      };
    });
  };

  const readStartup = async (
    readParams: ChatStartupProjectionReadParams,
  ): Promise<ChatStartupProjectionResult | undefined> => {
    assertAgentDatabaseAdmitted(readParams.agentId);
    const profiles = resolveSessionCatalogProfiles(
      readParams.sessionEntry,
      deps.getConfig(),
      readParams.agentId,
    );
    const hasSessionContext = hasSessionCatalogContext(profiles);
    const assemble = (
      neutral: PreparedChatMetadataProjection,
      session: PreparedChatMetadataProjection,
    ): ChatStartupProjectionResult => ({
      // History consumes stable catalogs only; live readiness stays inside the current-read fence.
      ...(readParams.readPolicy === "ready"
        ? {}
        : {
            metadata: readPreparedChatMetadata(
              session,
              {
                ...readParams,
                requesterProfileId: readParams.readRequesterProfileId?.(),
              },
              deps.getConfig(),
            ),
          }),
      sessionModelCatalog: session.modelCatalog,
      defaultModelCatalog: neutral.modelCatalog,
    });
    const projectStartup = async (
      generation: PreparedMetadataGeneration,
    ): Promise<PreparedProjection<ChatStartupProjectionResult>> => {
      const agentId = normalizeAgentId(readParams.agentId);
      const agent = await prepareAgent(generation, agentId);
      if (!agent) {
        throw new ChatMetadataSnapshotUnavailableError(
          `prepared chat startup projection is unavailable for agent "${agentId}"`,
        );
      }
      const readNeutral = await projectAgent(generation, agent);
      const readSession = hasSessionContext
        ? await projectAgent(
            generation,
            agent,
            readParams.sessionEntry,
            readParams.readRequesterProfileId?.(),
          )
        : readNeutral;
      return {
        isCurrent: () => readNeutral.isCurrent() && readSession.isCurrent(),
        read: () => assemble(readNeutral, readSession),
      };
    };
    if (readParams.readPolicy !== "ready" && hasSessionContext) {
      return readCurrent(projectStartup);
    }
    if (isUserModelAuthProfileId(profiles.preferredProfileId ?? "")) {
      return undefined;
    }
    const generation = current;
    // Optional reads consume only settled exact-profile facts. Never start preparation
    // or wait for a lifecycle replacement just to decorate an available transcript.
    if (!generation || replacement || pending || !isCurrentGeneration(generation)) {
      return undefined;
    }
    if (params.refreshOnRead) {
      try {
        if (!generationFactsMatch(generation.facts, captureGenerationFacts(deps))) {
          return undefined;
        }
      } catch {
        return undefined;
      }
    }
    const agentId = normalizeAgentId(readParams.agentId);
    const neutral = generation.neutralProjectionByAgentId.get(agentId);
    const session = hasSessionContext
      ? generation.sessionProjectionByKey.get(sessionProjectionKey(agentId, profiles))
      : neutral;
    if (
      neutral?.state !== "ready" ||
      session?.state !== "ready" ||
      !neutral.projection.isCurrent() ||
      !session.projection.isCurrent()
    ) {
      return undefined;
    }
    return assemble(neutral.projection, session.projection);
  };

  const invalidate = () => {
    if (stoppedError) {
      return;
    }
    invalidationEpoch += 1;
    refreshVersion += 1;
    pending?.generationReady.resolve();
    pending = undefined;
    current = undefined;
    lastError = undefined;
    if (!replacement) {
      replacement = createDeferredCore();
      // Failure can precede the first reader; readers still observe the original promise.
      void replacement.promise.catch(() => {});
    }
  };

  const fail = (error: unknown) => {
    const replacementError = error instanceof Error ? error : new Error(formatErrorMessage(error));
    refreshVersion += 1;
    pending?.generationReady.resolve();
    pending = undefined;
    current = undefined;
    lastError = replacementError;
    const failedReplacement = replacement;
    replacement = undefined;
    failedReplacement?.reject(replacementError);
    // Unavailable reads may retry capture. Notify once for the failed epoch, not once per reader.
    // A later ready generation is a different settlement even without another invalidation.
    if (!stoppedError && lastSettlement !== invalidationEpoch) {
      lastSettlement = invalidationEpoch;
      params.onChanged?.();
    }
  };

  const stop = async () => {
    if (!stoppedError) {
      stoppedError = new ChatMetadataSnapshotUnavailableError(
        "gateway chat metadata runtime is stopped",
      );
      invalidationEpoch += 1;
      fail(stoppedError);
    }
    // Retain preparation and readers through shutdown, including evicted projections
    // and superseded refreshes no longer reachable from the current generation.
    while (activeWork.size > 0) {
      await Promise.allSettled(activeWork);
    }
  };

  return {
    fail,
    invalidate,
    read: (readParams) => trackWork(read(readParams)),
    readStartup: (startupParams) => trackWork(readStartup(startupParams)),
    refresh: (options) => trackWork(refresh(options)),
    stop,
  };
}
