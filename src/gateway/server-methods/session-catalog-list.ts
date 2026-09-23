import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  errorShape,
  type SessionCatalog,
  validateSessionsCatalogListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
} from "../../plugins/registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import {
  createSessionCatalogRequestEntrySnapshot,
  type SessionCatalogInstances,
} from "./session-catalog-entry-snapshot.js";
import { startSessionCatalogRequestDiagnostics } from "./session-catalog-list-diagnostics.js";
import {
  SessionCatalogListLifetime,
  type CatalogListProgressSubscriber,
} from "./session-catalog-list-lifetime.js";
import {
  getSessionCatalogListOperations,
  resolvePublishedSessionCatalogs,
  sessionCatalogListKey,
  type CatalogListEnumeration,
} from "./session-catalog-list-operations.js";
import {
  allowProcessHomeFallback,
  catalogRegistrationSnapshot,
  createSessionCatalogRequestNodeSnapshot,
  listSessionCatalogProvider,
  resolveProviderCreateTarget,
} from "./session-catalog-provider-access.js";
import { catalogError, catalogResult } from "./session-catalog-result.js";
import {
  filterSessionCatalogHost,
  resolveSessionCatalogVisibility,
} from "./session-catalog-visibility.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const SESSION_CATALOG_SEARCH_MAX_UTF16_UNITS = 500;

function normalizeSessionCatalogSearch(search: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(search);
  return normalized
    ? truncateUtf16Safe(normalized, SESSION_CATALOG_SEARCH_MAX_UTF16_UNITS)
    : undefined;
}

type CatalogListResult = { catalogs: SessionCatalog[] };

export const listSessionCatalogHandler: GatewayRequestHandlers["sessions.catalog.list"] = async ({
  params,
  respond,
  context,
  client,
  signal,
}) => {
  if (
    !assertValidParams(params, validateSessionsCatalogListParams, "sessions.catalog.list", respond)
  ) {
    return;
  }
  const request = params;
  if (request.cursors !== undefined && request.catalogId === undefined) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "catalogId is required when cursors are provided"),
    );
    return;
  }
  const catalogRegistrations = catalogRegistrationSnapshot();
  let selected: SessionCatalogProvider[];
  if (request.catalogId) {
    const provider = catalogRegistrations.providers.find(
      (candidate) => candidate.id === request.catalogId,
    );
    if (!provider) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${request.catalogId}`),
      );
      return;
    }
    selected = [provider];
  } else {
    selected = catalogRegistrations.providers;
  }
  if (request.metadataOnly) {
    const metadataConfig = context.getRuntimeConfig();
    const metadataAgent = resolveAgentIdOrRespondError({
      rawAgentId: request.agentId,
      respond,
      cfg: metadataConfig,
      normalize: normalizeOptionalString,
    });
    if (!metadataAgent) {
      return;
    }
    respond(true, {
      catalogs: selected.map((provider) => {
        const createTarget = resolveProviderCreateTarget(
          provider,
          metadataAgent.agentId,
          metadataConfig,
        );
        return catalogResult(
          provider,
          catalogRegistrations.shareRoutes.get(provider),
          [],
          undefined,
          createTarget.ok ? createTarget.target : undefined,
        );
      }),
    });
    return;
  }
  const providerAudiences = new Map(selected.map((provider) => [provider.id, provider.audience]));
  const projection = getSessionRowProjection(context);
  if (!projection) {
    throw new Error("Session projection is unavailable before Gateway startup completes");
  }
  const diagnostics = startSessionCatalogRequestDiagnostics();
  let finishInitialProjection: (() => void) | undefined;
  try {
    while (projection.needsMaterialization) {
      finishInitialProjection ??= diagnostics?.startWait("projection_initial");
      await projection.ensureMaterialized();
    }
  } finally {
    finishInitialProjection?.();
  }
  const config = context.getRuntimeConfig();
  const resolvedAgent = resolveAgentIdOrRespondError({
    rawAgentId: request.agentId,
    respond,
    cfg: config,
    normalize: normalizeOptionalString,
  });
  if (!resolvedAgent) {
    return;
  }
  const search = normalizeSessionCatalogSearch(request.search);
  const allowHomeFallback = allowProcessHomeFallback(context.logGateway);
  // Shared provider enumeration is not permission. Each synchronous delivery gets current
  // caller facts and one canonical index, never the provider's pre-await planning snapshot.
  const projectResult = (result: CatalogListEnumeration): CatalogListResult => {
    const catalogs = resolvePublishedSessionCatalogs(result);
    const currentConfig = context.getRuntimeConfig();
    const visibility = resolveSessionCatalogVisibility(client, currentConfig);
    const requestEntries = createSessionCatalogRequestEntrySnapshot({
      cfg: currentConfig,
      fallbackAgentId: resolvedAgent.agentId,
      projection,
      sessionKeys: catalogs
        .flatMap((catalog) => catalog.hosts)
        .flatMap((host) => host.sessions)
        .flatMap(({ sessionKey }) => (sessionKey ? [sessionKey] : [])),
    });
    return {
      catalogs: catalogs.map((catalog) =>
        Object.assign({}, catalog, {
          hosts: catalog.hosts.map((host) =>
            filterSessionCatalogHost(
              requestEntries.projectHostSessions(
                host,
                result.instances,
                providerAudiences.get(catalog.id),
              ),
              visibility,
              {
                audience: providerAudiences.get(catalog.id),
                requestEntries,
              },
            ),
          ),
        }),
      ),
    };
  };
  const respondWithCatalog = (result: CatalogListEnumeration) => {
    const finish = diagnostics?.startSync("delivery");
    try {
      respond(true, projectResult(result));
    } finally {
      finish?.();
    }
  };
  const progressId = request.progressId;
  const progressConnId = progressId && client?.connId ? client.connId : undefined;
  const isProgressCurrent = () =>
    progressConnId !== undefined &&
    client?.invalidated !== true &&
    context.isConnectionActive?.(progressConnId) !== false &&
    (!client?.internal?.agentRuntimeIdentity ||
      context.validateAgentRuntimeApprovalAuthority?.(client.internal.agentRuntimeIdentity) ===
        true);
  const subscriber: CatalogListProgressSubscriber | undefined =
    progressConnId && progressId
      ? (catalog, instances) =>
          context.broadcastToConnIds(
            "sessions.catalog.host",
            {
              progressId,
              agentId: resolvedAgent.agentId,
              catalog: projectResult({ catalogs: [catalog], instances }).catalogs[0],
            },
            new Set([progressConnId]),
            { dropIfSlow: true },
          )
      : undefined;
  const allowPartialResults = Boolean(
    request.allowPartialResults === true &&
    subscriber &&
    isProgressCurrent() &&
    !client?.connectionSignal?.aborted &&
    !signal?.aborted &&
    request.hostIds === undefined &&
    request.cursors === undefined,
  );
  const subscribe = (progress: SessionCatalogListLifetime) => {
    if (subscriber && progressConnId) {
      progress.subscribe(
        `${progressConnId}\0${progressId}`,
        subscriber,
        isProgressCurrent,
        client?.connectionSignal ?? signal,
        () => (projection.needsMaterialization ? projection.ensureMaterialized() : undefined),
      );
    }
  };
  const listKey = sessionCatalogListKey({
    agentId: resolvedAgent.agentId,
    client,
    request,
    allowPartialResults,
    search,
    allowProcessHomeFallback: allowHomeFallback,
    visibilityKey: resolveSessionCatalogVisibility(client, config).cacheKey,
  });
  const operations = getSessionCatalogListOperations(config, catalogRegistrations);
  const pending = operations.pending.get(listKey);
  if (pending) {
    // progressId is connection-owned and excluded from the work key.
    subscribe(pending.progress);
    const finishCoalesced = diagnostics?.startWait("coalesced");
    let result: CatalogListEnumeration;
    try {
      result = await pending.result;
    } finally {
      finishCoalesced?.();
    }
    let finishFinalProjection: (() => void) | undefined;
    try {
      while (projection.needsMaterialization) {
        finishFinalProjection ??= diagnostics?.startWait("projection_final");
        await projection.ensureMaterialized();
      }
    } finally {
      finishFinalProjection?.();
    }
    respondWithCatalog(result);
    return;
  }
  const registry = catalogRegistrations.registry;
  const scopedRuntime = getPluginRuntimeGatewayRequestScope()?.pluginRegistry === registry;
  const epoch = registry ? capturePluginRegistryLifecycleEpoch(registry) : undefined;
  const registryAuthority = registry
    ? capturePluginLifecycleAuthority(registry, undefined, { scopedRuntime })
    : undefined;
  const registrySignal = registry
    ? capturePluginRegistryLifecycleSignal(registry, epoch, { scopedRuntime })
    : undefined;
  const resolveGatewayContext = context.resolveGatewayContext;
  const progress = new SessionCatalogListLifetime(
    () =>
      (!resolveGatewayContext || resolveGatewayContext() === context) &&
      (!registry ||
        (registryAuthority?.() === true &&
          registry.sessionCatalogs === catalogRegistrations.source)),
    [
      getGatewayRestartDrainSignal(),
      context.requestEntryLifetime?.signal,
      registrySignal,
      operations.retirement.signal,
      signal,
    ].filter((candidate): candidate is AbortSignal => candidate !== undefined),
    selected.map((provider) => provider.id),
  );
  subscribe(progress);
  const operation = (async () => {
    let requestEntries: ReturnType<typeof createSessionCatalogRequestEntrySnapshot> | undefined;
    const finishPlanning = diagnostics?.startSync("planning");
    try {
      requestEntries = selected.some((provider) => provider.audience !== "session-viewers")
        ? createSessionCatalogRequestEntrySnapshot({
            cfg: config,
            fallbackAgentId: resolvedAgent.agentId,
            projection,
          })
        : undefined;
      requestEntries?.freeze();
    } finally {
      finishPlanning?.();
    }
    const instances: SessionCatalogInstances = new Map();
    // Partial lists can publish a newer host while another provider or projection still waits.
    const publishedHosts: CatalogListEnumeration["publishedHosts"] = allowPartialResults
      ? new Map()
      : undefined;
    const listNodes = createSessionCatalogRequestNodeSnapshot();
    const finishProvider = diagnostics?.startWait("provider");
    let catalogList: SessionCatalog[];
    try {
      catalogList = await Promise.all(
        selected.map(async (provider): Promise<SessionCatalog> => {
          const shareRoute = catalogRegistrations.shareRoutes.get(provider);
          const resolution = resolveProviderCreateTarget(provider, resolvedAgent.agentId, config);
          const createTarget = resolution.ok ? resolution.target : undefined;
          const onHost = (host: SessionCatalog["hosts"][number]) => {
            if (publishedHosts) {
              const hosts = publishedHosts.get(provider.id) ?? new Map();
              hosts.set(host.hostId, host);
              publishedHosts.set(provider.id, hosts);
            }
            requestEntries?.captureHostInstances(host, instances);
            const catalog = catalogResult(provider, shareRoute, [host], undefined, createTarget);
            // The final response also reconciles these snapshots if a slow client drops a frame.
            progress.publish(catalog, instances);
          };
          try {
            const hosts = await progress.runProvider(onHost, (lifetime) => {
              const providerParams = {
                agentId: resolvedAgent.agentId,
                allowPartialResults,
                allowProcessHomeFallback: allowHomeFallback,
                search,
                limitPerHost: request.limitPerHost,
                hostIds: request.hostIds,
                ...(request.cursors !== undefined ? { cursors: request.cursors } : {}),
                sessionEntries: requestEntries?.sessionEntries,
                listNodes,
                ...lifetime,
              };
              return listSessionCatalogProvider(provider, providerParams, progress.assertCurrent);
            });
            for (const host of hosts) {
              requestEntries?.captureHostInstances(host, instances);
            }
            return catalogResult(provider, shareRoute, hosts, undefined, createTarget);
          } catch (error) {
            return catalogResult(provider, shareRoute, [], catalogError(error), createTarget);
          }
        }),
      );
    } finally {
      finishProvider?.();
    }
    return { catalogs: catalogList, instances, publishedHosts };
  })();
  const entry = { progress, result: operation };
  // Coalesce only concurrent requests; each subsequent list sees current provider rows.
  operations.pending.set(listKey, entry);
  try {
    const result = await operation;
    let finishFinalProjection: (() => void) | undefined;
    try {
      while (projection.needsMaterialization) {
        finishFinalProjection ??= diagnostics?.startWait("projection_final");
        await projection.ensureMaterialized();
      }
    } finally {
      finishFinalProjection?.();
    }
    respondWithCatalog(result);
  } catch (error) {
    progress.retire(error);
    throw error;
  } finally {
    if (operations.pending.get(listKey) === entry) {
      operations.pending.delete(listKey);
    }
    progress.finishListing();
  }
};
