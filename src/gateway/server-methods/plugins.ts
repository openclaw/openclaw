import {
  ErrorCodes,
  errorShape,
  validatePluginsInspectParams,
  validatePluginsSkillsReadParams,
  validatePluginsCatalogBrowseParams,
  validatePluginsCatalogCategoriesParams,
  validatePluginsCatalogGetParams,
  validatePluginsListParams,
  validatePluginsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveClawHubBaseUrl } from "../../infra/clawhub-client.js";
import {
  fetchClawHubPluginCatalog,
  fetchClawHubPluginCategories,
  fetchClawHubPluginDetail,
  fetchClawHubPluginOverview,
  type ClawHubPluginCatalogEntry,
  type ClawHubPluginCategory,
} from "../../infra/clawhub-plugin-catalog.js";
import { fetchClawHubPluginSkill } from "../../infra/clawhub-plugin-skills.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  encodePluginDiscoveryId,
  encodeLocalPluginDiscoveryId,
  findLocalPluginByIdentity,
  joinClawHubPluginCatalog,
  joinClawHubPluginDetail,
  joinLocalPluginDetail,
  resolvePluginDiscoveryIdentity,
} from "../../plugins/catalog-discovery.js";
import { registerClawHubCatalogIconUrls } from "../../plugins/catalog-icon-registry.js";
import { searchInstallablePluginPackages } from "../../plugins/catalog-search.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import { inspectManagedPlugin, listManagedPlugins } from "../../plugins/management-service.js";
import { readManagedPluginSkill } from "../../plugins/management-skill-read.js";
import { getPluginRegistryVersion } from "../../plugins/runtime-state.js";
import { getPluginRegistryForContext } from "../../plugins/runtime/gateway-request-scope.js";
import { listPluginServiceHealthFailures } from "../../plugins/service-health.js";
import { validatePluginSkillPath } from "../../skills/loading/plugin-skill-bundle.js";
import { catalogHandlers } from "./catalog.js";
import { pluginCredentialHandlers } from "./plugins.credentials.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";

function pluginReadError(error: unknown) {
  return errorShape(
    error instanceof ManagedPluginLifecycleError && error.kind === "invalid-request"
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE,
    formatErrorMessage(error),
  );
}

export const pluginsHandlers: GatewayRequestHandlers = {
  ...catalogHandlers,
  ...pluginCredentialHandlers,
  "plugins.skills.read": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validatePluginsSkillsReadParams, "plugins.skills.read", respond)
    ) {
      return;
    }
    try {
      if (params.path !== undefined) {
        try {
          validatePluginSkillPath(params.path);
        } catch {
          throw new ManagedPluginLifecycleError("Invalid plugin skill bundle path.");
        }
      }
      if (params.source === "installed") {
        respond(
          true,
          await readManagedPluginSkill({
            config: context.getRuntimeConfig(),
            pluginId: params.pluginId,
            skillName: params.skillName,
            path: params.path,
            version: params.version,
          }),
          undefined,
        );
        return;
      }
      const identity = resolvePluginDiscoveryIdentity(params.catalogId);
      if (!identity || identity.origin !== "clawhub") {
        throw new ManagedPluginLifecycleError("Unknown ClawHub plugin identity.");
      }
      respond(
        true,
        await fetchClawHubPluginSkill({
          packageName: identity.identity,
          version: params.version,
          skillName: params.skillName,
          path: params.path,
        }),
        undefined,
      );
    } catch (error) {
      respond(false, undefined, pluginReadError(error));
    }
  },
  "plugins.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validatePluginsListParams, "plugins.list", respond)) {
      return;
    }
    try {
      const catalog = await listManagedPlugins({ config: context.getRuntimeConfig() });
      const registry = getPluginRegistryForContext();
      // The first loaded record owns shadowed IDs; read runtime facts after catalog I/O.
      const records = new Map(registry?.plugins.toReversed().map((record) => [record.id, record]));
      const failures = new Map(
        registry
          ? listPluginServiceHealthFailures(registry).map((failure) => [failure.pluginId, failure])
          : [],
      );
      respond(
        true,
        {
          ...catalog,
          generation: getPluginRegistryVersion(registry),
          plugins: catalog.plugins.map((plugin) => {
            const record = records.get(plugin.id);
            const failure = failures.get(plugin.id);
            const error = failure ? `${failure.serviceId}: ${failure.error}` : record?.error;
            return Object.assign({}, plugin, {
              catalogId: plugin.clawhubPackage
                ? encodePluginDiscoveryId(plugin.clawhubPackage)
                : encodeLocalPluginDiscoveryId(plugin.id),
              runtime: {
                state:
                  record?.status === "loaded"
                    ? failure
                      ? "service-failed"
                      : "active"
                    : record?.status === "disabled"
                      ? "disabled"
                      : "unloaded",
                ...(error ? { error: error.slice(0, 2000) } : {}),
              },
            });
          }),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "plugins.inspect": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validatePluginsInspectParams, "plugins.inspect", respond)) {
      return;
    }
    try {
      let target: { pluginId: string } | { clawhub: { packageName: string; version?: string } };
      if ("pluginId" in params) {
        target = { pluginId: params.pluginId };
      } else if ("source" in params) {
        target = { clawhub: { packageName: params.packageName, version: params.version } };
      } else {
        const identity = resolvePluginDiscoveryIdentity(params.catalogId);
        if (!identity) {
          throw new ManagedPluginLifecycleError("Unknown plugin catalog identity.", {
            kind: "invalid-request",
          });
        }
        if (identity.origin === "local" && params.version) {
          throw new ManagedPluginLifecycleError(
            "Local plugin inspection does not select releases.",
            {
              kind: "invalid-request",
            },
          );
        }
        target =
          identity.origin === "clawhub"
            ? { clawhub: { packageName: identity.identity, version: params.version } }
            : { pluginId: identity.identity };
      }
      const remote = "clawhub" in target;
      const inspected = await inspectManagedPlugin({
        config: context.getRuntimeConfig(),
        ...target,
      });
      const { inspectDecisionProviders } = await import("../../decisions/runtime.js");
      respond(
        true,
        {
          ...inspected,
          decisions: remote
            ? []
            : inspectDecisionProviders(context.getRuntimeConfig()).filter(
                (entry) => entry.pluginId === inspected.plugin.id,
              ),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, pluginReadError(error));
    }
  },
  "plugins.search": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsSearchParams, "plugins.search", respond)) {
      return;
    }
    try {
      const results = await searchInstallablePluginPackages({
        query: params.query,
        limit: params.limit,
      });
      respond(
        true,
        {
          results: results.flatMap((entry) => {
            if (
              entry.package.family !== "code-plugin" &&
              entry.package.family !== "bundle-plugin"
            ) {
              return [];
            }
            const downloads = entry.package.stats?.downloads;
            return [
              {
                score: entry.score,
                package: {
                  name: entry.package.name,
                  displayName: entry.package.displayName,
                  family: entry.package.family,
                  channel: entry.package.channel,
                  isOfficial: entry.package.isOfficial,
                  ...(entry.package.summary ? { summary: entry.package.summary } : {}),
                  ...(entry.package.latestVersion
                    ? { latestVersion: entry.package.latestVersion }
                    : {}),
                  ...(entry.package.runtimeId ? { runtimeId: entry.package.runtimeId } : {}),
                  ...(typeof downloads === "number" && Number.isFinite(downloads) && downloads >= 0
                    ? { downloads }
                    : {}),
                  ...(entry.package.verificationTier
                    ? { verificationTier: entry.package.verificationTier }
                    : {}),
                },
              },
            ];
          }),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "plugins.catalog.browse": defineValidatedGatewayHandler(
    "plugins.catalog.browse",
    validatePluginsCatalogBrowseParams,
    async ({ params, respond, context }) => {
      if (params.query?.trim() && params.cursor) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Plugin search does not accept a browse cursor."),
        );
        return;
      }
      try {
        const local = await listManagedPlugins({ config: context.getRuntimeConfig() });
        const query = params.query?.trim();
        const intent = params.intent ?? "all";
        const includeBundledOnly =
          intent === "bundled" || intent === "official" || intent === "all";
        const catalogOptions = {
          local,
          includeBundledOnly,
          intent,
          category: params.category,
          query: params.query,
          cursor: params.cursor,
        };
        try {
          const overviewRequest = intent === "all" && !query && !params.category && !params.cursor;
          const remote: {
            items: ClawHubPluginCatalogEntry[];
            categories?: ClawHubPluginCategory[];
            nextCursor?: string;
          } = overviewRequest
            ? await fetchClawHubPluginOverview()
            : intent === "bundled"
              ? { items: [] }
              : await fetchClawHubPluginCatalog({
                  query,
                  ...(params.searchSource ? { searchSource: params.searchSource } : {}),
                  intent,
                  category: params.category,
                  cursor: params.cursor,
                  limit: params.pageSize ?? 20,
                });
          const items = joinClawHubPluginCatalog({
            ...catalogOptions,
            remote: remote.items,
            categories: remote.categories,
          });
          registerClawHubCatalogIconUrls(items.map((item) => item.catalog.imageUrl));
          respond(
            true,
            {
              items,
              ...(overviewRequest ? { categories: remote.categories } : {}),
              ...(remote.nextCursor ? { nextCursor: remote.nextCursor } : {}),
            },
            undefined,
          );
        } catch (error) {
          respond(
            true,
            {
              items: joinClawHubPluginCatalog({ ...catalogOptions, remote: [] }),
              ...(params.cursor ? { nextCursor: params.cursor } : {}),
              remoteError: `ClawHub is unavailable: ${formatErrorMessage(error)}.${
                intent === "all"
                  ? " Installed plugins remain available."
                  : includeBundledOnly
                    ? " Bundled plugins remain available."
                    : ""
              }`,
            },
            undefined,
          );
        }
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Plugin discovery is unavailable: ${formatErrorMessage(error)}. Retry to reconnect to ClawHub.`,
          ),
        );
      }
    },
  ),
  "plugins.catalog.categories": defineValidatedGatewayHandler(
    "plugins.catalog.categories",
    validatePluginsCatalogCategoriesParams,
    async ({ respond }) => {
      try {
        respond(true, { categories: await fetchClawHubPluginCategories() }, undefined);
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Plugin categories are unavailable: ${formatErrorMessage(error)}. Retry to reconnect to ClawHub.`,
          ),
        );
      }
    },
  ),
  "plugins.catalog.get": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validatePluginsCatalogGetParams, "plugins.catalog.get", respond)
    ) {
      return;
    }
    const identity = resolvePluginDiscoveryIdentity(params.id);
    if (!identity) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Unknown plugin discovery identity."),
      );
      return;
    }
    if (identity.origin === "local" && params.version) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Local plugin details do not select releases."),
      );
      return;
    }
    try {
      const local = await listManagedPlugins({ config: context.getRuntimeConfig() });
      const localPlugin = findLocalPluginByIdentity(local, identity.identity, identity.origin);
      let remoteError: string | undefined;
      if (identity.origin !== "local") {
        try {
          const remote = await fetchClawHubPluginDetail({
            packageName: identity.identity,
            ...(params.version ? { version: params.version } : {}),
          });
          registerClawHubCatalogIconUrls([remote.iconUrl, remote.owner?.imageUrl]);
          respond(true, joinClawHubPluginDetail({ remote, local }), undefined);
          return;
        } catch (error) {
          if (!localPlugin) {
            throw error;
          }
          remoteError = `ClawHub details are unavailable: ${formatErrorMessage(error)}. Showing installed plugin metadata.`;
        }
      } else if (!localPlugin) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Unknown local plugin discovery identity."),
        );
        return;
      }
      const inspectionPluginId = localPlugin.installed
        ? localPlugin.id
        : identity.origin === "local" && localPlugin.install?.source === "official"
          ? localPlugin.install.pluginId
          : undefined;
      const inspection = inspectionPluginId
        ? await inspectManagedPlugin({
            config: context.getRuntimeConfig(),
            pluginId: inspectionPluginId,
          })
        : undefined;
      const result = joinLocalPluginDetail({ plugin: localPlugin, local, inspection });
      if (remoteError) {
        result.plugin.id = params.id;
        result.plugin.catalog.packageName = identity.identity;
        result.detail = {
          ...result.detail,
          packageName: identity.identity,
          registry: resolveClawHubBaseUrl(),
          remoteError,
          ...(params.version ? { requestedVersion: params.version } : {}),
          selectedRelease: null,
          downloadability: {
            status: "unknown",
            reason: "ClawHub release metadata is unavailable.",
          },
        };
      }
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Plugin details are unavailable: ${formatErrorMessage(error)}. Retry to reconnect to ClawHub.`,
        ),
      );
    }
  },
};
