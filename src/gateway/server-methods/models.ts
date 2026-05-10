import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveVisibleModelCatalog } from "../../agents/model-catalog-visibility.js";
import { parseConfiguredModelVisibilityEntries } from "../../agents/model-selection-shared.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../protocol/index.js";
import type { GatewayRequestContext } from "./shared-types.js";
import type { GatewayRequestHandlers } from "./types.js";

type ModelsListView = "default" | "configured" | "all";
type GatewayModelCatalog = Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>;

const MODELS_LIST_CATALOG_TIMEOUT_MS = 750;
let loggedSlowModelsListCatalog = false;

function resolveModelsListView(params: Record<string, unknown>): ModelsListView {
  return typeof params.view === "string" ? (params.view as ModelsListView) : "default";
}

function resolveModelsListAgentId(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): string | undefined {
  const raw = params.agentId;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const known = list.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    return id === trimmed;
  });
  return known ? trimmed : undefined;
}

async function loadModelsListCatalog(
  context: GatewayRequestContext,
  view: ModelsListView,
  cfg: OpenClawConfig,
  agentId: string | undefined,
): Promise<GatewayModelCatalog> {
  if (view === "all") {
    return await context.loadGatewayModelCatalog({ readOnly: false });
  }
  if (parseConfiguredModelVisibilityEntries({ cfg, agentId }).providerWildcards.size > 0) {
    return await context.loadGatewayModelCatalog({ readOnly: false });
  }
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = Symbol("models-list-catalog-timeout");
  const catalogPromise = context.loadGatewayModelCatalog({ readOnly: true });
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timeout = setTimeout(() => resolve(timedOut), MODELS_LIST_CATALOG_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    const result = await Promise.race([catalogPromise, timeoutPromise]);
    if (result === timedOut) {
      catalogPromise.catch(() => undefined);
      if (!loggedSlowModelsListCatalog) {
        loggedSlowModelsListCatalog = true;
        context.logGateway.debug(
          `models.list continuing without model catalog after ${MODELS_LIST_CATALOG_TIMEOUT_MS}ms`,
        );
      }
      return [];
    }
    return result;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const requestedAgentId = resolveModelsListAgentId(params, cfg);
      const workspaceDir =
        resolveAgentWorkspaceDir(cfg, requestedAgentId ?? resolveDefaultAgentId(cfg)) ??
        resolveDefaultAgentWorkspaceDir();
      const view = resolveModelsListView(params);
      const catalog = await loadModelsListCatalog(context, view, cfg, requestedAgentId);
      if (view === "all") {
        respond(true, { models: catalog }, undefined);
        return;
      }
      const models = resolveVisibleModelCatalog({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
        workspaceDir,
        view,
        runtimeAuthDiscovery: false,
        ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
      });
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
