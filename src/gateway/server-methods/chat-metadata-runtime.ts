import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { getRuntimeAuthProfileStoreMetadataRevision } from "../../agents/auth-profiles/runtime-snapshots.js";
import { readSessionRuntimeOwnershipAsync } from "../../agents/harness/session-runtime-ownership.js";
import {
  getPendingPreparedModelRuntimeReplacement,
  getPublishedPreparedModelCatalogOwnerSnapshot,
} from "../../agents/prepared-model-catalog.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { resolveSwarmConfig } from "../../agents/subagents/swarm/swarm-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  withCurrentReadAuthority,
  type CurrentReadAuthority,
} from "../../shared/current-read-authority.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { listUserProfileAuthLinksAsync } from "../../state/user-model-accounts.js";
import { prepareChatAccountSelection } from "./chat-account-selection.js";
import type {
  ChatMetadataReadParams,
  ChatMetadataResult,
  ChatMetadataSessionEntry,
} from "./chat-metadata-contract.js";
import {
  assertPreparedAgentCurrent,
  authStoresCurrent,
  captureGenerationFacts,
  ChatMetadataSnapshotUnavailableError,
  generationFactsMatch,
  type ChatMetadataRuntimeDeps,
  type PreparedGenerationFacts,
} from "./chat-metadata-facts.js";
import { createChatMetadataModelList } from "./chat-metadata-model-list.js";
import {
  hasSessionCatalogContext,
  prepareChatMetadataModelProjection,
  prepareSessionAcpMeta,
  sessionProjectionKey,
  resolveSessionCatalogProfiles,
  resolveRequiredWorkerInferenceProfileId,
  readPreparedChatMetadata,
  type PreparedChatMetadataProjection,
} from "./chat-metadata-session-projection.js";
import type {
  ChatStartupProjectionReadParams,
  ChatStartupProjectionResult,
} from "./chat-startup-projection-contract.js";
import type {
  GatewayModelCatalogContext,
  PreparedModelsListRequest,
} from "./models-list-context.js";

type PreparedAgentMetadata = PreparedChatMetadataProjection["agent"];

type PreparedProjection<T> = { read: () => T; isCurrent: () => boolean };

type AgentProjectionEntry =
  | { state: "pending"; promise: Promise<PreparedChatMetadataProjection> }
  | { state: "ready"; projection: PreparedChatMetadataProjection };

type PreparedMetadataGeneration = {
  facts: PreparedGenerationFacts;
  modelLists: ReturnType<typeof createChatMetadataModelList>;
  agentsById: Map<string, Promise<PreparedAgentMetadata>>;
  neutralProjectionByAgentId: Map<string, AgentProjectionEntry>;
  sessionProjectionByKey: Map<string, AgentProjectionEntry>;
};

type ChatMetadataRefreshOptions = { notifyIfUnchanged?: boolean };

const CHAT_METADATA_CACHE_MAX_ENTRIES = 64;

export function createGatewayChatMetadataRuntime(params: {
  getConfig: () => OpenClawConfig;
  getContext: () => GatewayModelCatalogContext;
  onChanged?: (change: {
    modelCatalogChanged: boolean;
    authChanged: boolean;
    commandsChanged?: false;
  }) => void;
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
  readModelsList: (params: PreparedModelsListRequest) => Promise<ModelsListResult | undefined>;
  readStartup: (
    params: ChatStartupProjectionReadParams,
  ) => Promise<ChatStartupProjectionResult | undefined>;
} {
  const deps: ChatMetadataRuntimeDeps = {
    getConfig: params.getConfig,
    getPreparedOwner: getPublishedPreparedModelCatalogOwnerSnapshot,
    getAuthStoreRevision: getRuntimeAuthProfileStoreMetadataRevision,
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
  let failed = false;
  let lastNotifiedFacts: PreparedGenerationFacts | undefined;
  const notifyChanged = (facts?: PreparedGenerationFacts, catalogStatusChanged = false) => {
    const previous = lastNotifiedFacts;
    lastNotifiedFacts = facts;
    params.onChanged?.({
      modelCatalogChanged:
        catalogStatusChanged ||
        !previous ||
        !facts ||
        !generationFactsMatch(previous, facts, "catalog"),
      authChanged: !previous || !facts || !generationFactsMatch(previous, facts, "auth"),
      ...(previous && facts && generationFactsMatch(previous, facts, "commands")
        ? { commandsChanged: false as const }
        : {}),
    });
  };
  let stoppedError: ChatMetadataSnapshotUnavailableError | undefined;
  const activeWork = new Set<Promise<unknown>>();
  const trackWork = <T>(work: Promise<T>): Promise<T> => {
    if (activeWork.has(work)) {
      return work;
    }
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
  let pending: Promise<void> | undefined;
  let refreshRequested = false;
  let notifyRefreshIfUnchanged = false;

  const projectAgent = async (
    generation: PreparedMetadataGeneration,
    agent: PreparedAgentMetadata,
    sessionEntry?: ChatMetadataSessionEntry,
    requesterProfileId?: string,
    authority?: CurrentReadAuthority,
    useRequesterDefaults = false,
  ): Promise<PreparedChatMetadataProjection> => {
    assertOpen();
    authority?.assertCurrent?.();
    assertPreparedAgentCurrent(agent);
    const profiles = resolveSessionCatalogProfiles(sessionEntry, agent.owner.config, agent.agentId);
    const neutral = !hasSessionCatalogContext(profiles);
    // The profile owner invalidates cached links when an account connects or disconnects.
    // Viewers without personal defaults reuse the already-published neutral projection.
    const defaultProfileId =
      useRequesterDefaults &&
      !profiles.preferredProfileId &&
      requesterProfileId &&
      (await listUserProfileAuthLinksAsync(requesterProfileId)).length > 0
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
      if (await withCurrentReadAuthority(authority, () => prepared.isCurrent())) {
        return prepared;
      }
      projections.delete(key);
    }
    const projection = deps
      .buildProjection({
        context: params.getContext(),
        facts: agent,
        requesterProfileId: defaultProfileId,
        ...authority,
        ...profiles,
      })
      .then((prepared) =>
        withCurrentReadAuthority(authority, () => {
          // Shared catalogs retain agent facts, never the caller's entry or authority closure.
          const preparedProjection: PreparedChatMetadataProjection = {
            ...prepared,
            agent,
          };
          projections.set(key, { state: "ready", projection: preparedProjection });
          pruneMapToMaxSize(projections, CHAT_METADATA_CACHE_MAX_ENTRIES);
          return preparedProjection;
        }),
      )
      .catch((error: unknown) => {
        projections.delete(key);
        throw error;
      });
    void trackWork(projection);
    projections.set(key, { state: "pending", promise: projection });
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
        const swarmEnabled = resolveSwarmConfig(generation.facts.config, agentId).enabled;
        return {
          ...agent,
          ...(commands !== undefined ? { commands } : {}),
          swarmEnabled,
          revision: createHash("sha256")
            .update(JSON.stringify({ commands, swarmEnabled }))
            .digest("base64url"),
        };
      })().catch((error: unknown) => {
        generation.agentsById.delete(agentId);
        throw error;
      }),
    );
    generation.agentsById.set(agentId, preparing);
    pruneMapToMaxSize(generation.agentsById, CHAT_METADATA_CACHE_MAX_ENTRIES);
    return preparing;
  };

  const runRefresh = async (options: ChatMetadataRefreshOptions) => {
    // Superseded gates resolve so readers can join the successor's publication.
    for (
      let ownerReplacement = getPendingPreparedModelRuntimeReplacement();
      ownerReplacement;
      ownerReplacement = getPendingPreparedModelRuntimeReplacement()
    ) {
      await ownerReplacement;
      assertOpen();
    }
    assertOpen();
    const facts = captureGenerationFacts(deps);
    if (!current || !generationFactsMatch(current.facts, facts)) {
      // Commands and session-specific projections stay on demand within the published owner facts.
      const generation: PreparedMetadataGeneration = {
        facts,
        modelLists:
          current && generationFactsMatch(current.facts, facts, "catalog")
            ? current.modelLists
            : createChatMetadataModelList({
                facts,
                context: params.getContext(),
                maxEntries: CHAT_METADATA_CACHE_MAX_ENTRIES,
              }),
        agentsById: new Map(),
        neutralProjectionByAgentId: new Map(),
        sessionProjectionByKey: new Map(),
      };
      assertOpen();
      // Mid-refresh config changes are best effort; the next publication refreshes these facts.
      current = generation;
      notifyChanged(facts, options.notifyIfUnchanged);
    } else if (options.notifyIfUnchanged) {
      notifyChanged(facts, true);
    }
    failed = false;
    lastError = undefined;
    replacement?.resolve();
    replacement = undefined;
  };

  // Publication callbacks can carry a temporary startup admission borrow.
  const refresh = AsyncLocalStorage.bind((options: ChatMetadataRefreshOptions = {}) => {
    if (stoppedError) {
      return Promise.reject(stoppedError);
    }
    refreshRequested = true;
    notifyRefreshIfUnchanged ||= options.notifyIfUnchanged === true;
    if (pending) {
      return pending;
    }
    const promise = Promise.resolve().then(async () => {
      while (refreshRequested) {
        refreshRequested = false;
        const notifyIfUnchanged = notifyRefreshIfUnchanged;
        notifyRefreshIfUnchanged = false;
        await runRefresh({ notifyIfUnchanged });
      }
    });
    pending = promise;
    void promise.then(
      () => {
        pending = undefined;
      },
      (error: unknown) => {
        pending = undefined;
        refreshRequested = false;
        notifyRefreshIfUnchanged = false;
        fail(error);
      },
    );
    return promise;
  });

  const readCurrent = async <Result>(
    project: (generation: PreparedMetadataGeneration) => Promise<PreparedProjection<Result>>,
  ): Promise<Result> => {
    assertOpen();
    await pending;
    if (!current && replacement) {
      await replacement.promise;
    }
    // A missing owner may have published since the previous request.
    if (
      (!current && lastError instanceof ChatMetadataSnapshotUnavailableError) ||
      (current && !authStoresCurrent(current.facts, deps))
    ) {
      await refresh();
    }
    const generation = current;
    if (!generation) {
      throw lastError ?? new ChatMetadataSnapshotUnavailableError();
    }
    const readProjection = await project(generation);
    assertOpen();
    if (!readProjection.isCurrent()) {
      throw new ChatMetadataSnapshotUnavailableError();
    }
    return readProjection.read();
  };

  // Catalog changes during a rebuild are best effort; serve the last rendered list until publication.
  const publishedModelLists = new Map<string, ModelsListResult>();
  const retainedModelsList = async (key: string, request: PreparedModelsListRequest) => {
    const published = publishedModelLists.get(key);
    if (!published) {
      return undefined;
    }
    // A requester's personal accounts select a private projection; only a requester still
    // without account links may reuse the shared list.
    if (
      request.requesterProfileId &&
      request.params.view !== "provider-config" &&
      (await listUserProfileAuthLinksAsync(request.requesterProfileId)).length > 0
    ) {
      return undefined;
    }
    return published;
  };
  const readModelsList = async (
    request: PreparedModelsListRequest,
  ): Promise<ModelsListResult | undefined> => {
    assertAgentDatabaseAdmitted(request.agentId);
    const agentId = normalizeAgentId(request.agentId);
    const key = JSON.stringify([
      agentId,
      request.params,
      request.includeManualSelection,
      request.requesterProfileId,
      request.readScope?.sessionKey,
      request.readScope?.sessionEntry,
    ]);
    const rebuilding =
      pending !== undefined ||
      getPendingPreparedModelRuntimeReplacement() !== undefined ||
      !current ||
      !authStoresCurrent(current.facts, deps) ||
      current.facts.agents.some((agent) => !agent.owner.isCurrent());
    const retained = rebuilding ? await retainedModelsList(key, request) : undefined;
    if (retained) {
      return retained;
    }
    let result: ModelsListResult | undefined;
    try {
      result = await readCurrent(async (read) => {
        const prepared = await read.modelLists.read(request);
        return prepared ?? { isCurrent: () => true, read: () => undefined };
      });
    } catch (error) {
      // A publication that retires the read's owner mid-flight is not a user-visible failure.
      const fallback =
        (error instanceof PreparedModelRuntimePublicationSupersededError ||
          error instanceof ChatMetadataSnapshotUnavailableError) &&
        (await retainedModelsList(key, request));
      if (fallback) {
        return fallback;
      }
      throw error;
    }
    if (result) {
      publishedModelLists.set(key, result);
      pruneMapToMaxSize(publishedModelLists, CHAT_METADATA_CACHE_MAX_ENTRIES);
    }
    return result;
  };

  const read = async (readParams: ChatMetadataReadParams): Promise<ChatMetadataResult> => {
    assertAgentDatabaseAdmitted(readParams.agentId);
    const { draftAccountSelection: draft, isCurrent } = readParams;
    const assertCurrent = isCurrent
      ? () => {
          if (!isCurrent()) {
            throw new PreparedModelRuntimePublicationSupersededError(
              "Chat metadata access changed while preparing its metadata. Retry the request.",
            );
          }
          draft?.assertCurrent();
        }
      : draft?.assertCurrent;
    const authority = (readParams.withCurrent || readParams.assertCurrent || assertCurrent) && {
      withCurrent: readParams.withCurrent,
      assertCurrent: () => {
        readParams.assertCurrent?.();
        assertCurrent?.();
      },
    };
    const sessionEntry: ChatMetadataSessionEntry | undefined = draft
      ? { authProfileOverride: draft.authProfileId, authProfileOverrideSource: "user" }
      : readParams.sessionEntry;
    return await readCurrent<ChatMetadataResult>(async (generation) => {
      const agentId = normalizeAgentId(readParams.agentId);
      const agent = await prepareAgent(generation, agentId);
      if (!agent) {
        throw new ChatMetadataSnapshotUnavailableError(
          `prepared chat metadata is unavailable for agent "${agentId}"`,
        );
      }
      await withCurrentReadAuthority(authority, () => {});
      if (readParams.includeModels === false) {
        assertPreparedAgentCurrent(agent);
        return {
          isCurrent: agent.owner.isCurrent,
          read: () => {
            draft?.assertCurrent();
            return {
              ...(readParams.ifRevision === agent.revision
                ? { unchanged: true as const }
                : { commands: agent.commands }),
              swarmEnabled: agent.swarmEnabled,
              revision: agent.revision,
            };
          },
        };
      }
      const projection = await withCurrentReadAuthority(authority, () =>
        projectAgent(
          generation,
          agent,
          sessionEntry,
          draft?.owner ?? readParams.requesterProfileId,
          authority,
          // Existing sessions use their saved selection, never a viewer's newer default.
          !readParams.sessionKey && !readParams.sessionEntry,
        ),
      );
      const readAccountSelection = await withCurrentReadAuthority(authority, () =>
        prepareChatAccountSelection({
          authStore: agent.authStore,
          sessionEntry,
          requesterProfileId: draft?.owner ?? readParams.requesterProfileId,
        }),
      );
      const acpMeta = await withCurrentReadAuthority(authority, () =>
        prepareSessionAcpMeta({ ...readParams, sessionEntry }, deps.getConfig()),
      );
      const runtimeOwnership = await withCurrentReadAuthority(authority, () =>
        readSessionRuntimeOwnershipAsync({
          ...readParams,
          sessionEntry,
          config: deps.getConfig(),
        }),
      );
      await withCurrentReadAuthority(authority, () => {});
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
            acpMeta,
            runtimeOwnership,
            readAccountSelection,
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
    ): ChatStartupProjectionResult => {
      if (readParams.readPolicy !== "ready") {
        // Catalog preparation may yield; retain the requester's publication fence.
        readParams.readRequesterProfileId?.();
      }
      return {
        // The pane's model picker reads models.list; startup carries commands and worker policy.
        ...(readParams.readPolicy === "ready"
          ? {}
          : {
              // Command receipts must not give session worker policy a catalog lifetime.
              commandsRevision: session.agent.revision,
              metadata: {
                commands: session.agent.commands,
                swarmEnabled: session.agent.swarmEnabled,
                requiredWorkerInferenceProfileId: resolveRequiredWorkerInferenceProfileId(
                  readParams,
                  deps.getConfig(),
                ),
              },
            }),
        sessionModelCatalog: session.modelCatalog,
        defaultModelCatalog: neutral.modelCatalog,
      };
    };
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
    if (!generation || replacement || pending || !authStoresCurrent(generation.facts, deps)) {
      return undefined;
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
    // External owner replacement can change materializations without changing snapshot identity.
    lastNotifiedFacts = undefined;
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
    current = undefined;
    lastError = replacementError;
    const failedReplacement = replacement;
    replacement = undefined;
    failedReplacement?.reject(replacementError);
    // Failed reads retry capture without repeating the unavailable notification.
    if (!stoppedError && !failed) {
      failed = true;
      notifyChanged();
    }
  };

  const stop = async () => {
    if (!stoppedError) {
      stoppedError = new ChatMetadataSnapshotUnavailableError(
        "gateway chat metadata runtime is stopped",
      );
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
    readModelsList: (request) => trackWork(readModelsList(request)),
    readStartup: (startupParams) => trackWork(readStartup(startupParams)),
    refresh: (options) => trackWork(refresh(options)),
    stop,
  };
}
