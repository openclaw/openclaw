import {
  ErrorCodes,
  errorShape,
  validateCatalogBrowseParams,
  validateCatalogSearchKeywordsParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  browseClawHubCatalog,
  CatalogDiscoveryRequestError,
  searchClawHubCatalogKeywords,
} from "../../plugins/catalog-discovery.js";
import { resolveSkillsAgentWorkspace } from "./skills-workspace-handler.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler, type Validator } from "./validation.js";

function catalogError(error: unknown) {
  return errorShape(
    error instanceof CatalogDiscoveryRequestError
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE,
    formatErrorMessage(error),
  );
}

function defineCatalogHandler<P extends { agentId?: string }>(
  method: string,
  validate: Validator<P>,
  run: (
    params: Omit<Parameters<typeof browseClawHubCatalog>[0], "request"> & { request: P },
  ) => Promise<unknown>,
  needsWorkspace: (params: P) => boolean,
  invalidRequest?: (params: P) => string | undefined,
) {
  return defineValidatedGatewayHandler(method, validate, async ({ params, respond, context }) => {
    const invalid = invalidRequest?.(params);
    if (invalid) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, invalid));
      return;
    }
    try {
      const workspace = needsWorkspace(params)
        ? resolveSkillsAgentWorkspace(params, context)
        : undefined;
      if (workspace && !workspace.ok) {
        respond(false, undefined, workspace.error);
        return;
      }
      const result = await run({
        request: params,
        config: context.getRuntimeConfig(),
        ...(workspace ? { agentId: workspace.agentId, workspaceDir: workspace.workspaceDir } : {}),
      });
      respond(true, result, undefined);
    } catch (error) {
      respond(false, undefined, catalogError(error));
    }
  });
}

export const catalogHandlers: GatewayRequestHandlers = {
  "catalog.browse": defineCatalogHandler(
    "catalog.browse",
    validateCatalogBrowseParams,
    browseClawHubCatalog,
    (params) => params.kind === "skill",
    (params) =>
      params.query?.trim() && (params.cursor || params.feed === "trending")
        ? "Catalog search does not accept a cursor or trending feed."
        : undefined,
  ),
  "catalog.searchKeywords": defineCatalogHandler(
    "catalog.searchKeywords",
    validateCatalogSearchKeywordsParams,
    searchClawHubCatalogKeywords,
    (params) => !params.kinds || params.kinds.includes("skill"),
  ),
};
