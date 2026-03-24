import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { buildAllowedModelSet, modelKey, parseModelRef } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import { sendInvalidRequest, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { resolveAgentIdForRequest } from "./http-utils.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";

type OpenAiModelsHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiModelObject = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  permission: [];
  input?: ModelCatalogEntry["input"];
  context_window?: number;
  reasoning?: boolean;
};

function toOpenAiModel(entry: ModelCatalogEntry): OpenAiModelObject {
  return {
    id: modelKey(entry.provider, entry.id),
    object: "model",
    created: 0,
    owned_by: entry.provider,
    permission: [],
    ...(entry.input ? { input: entry.input } : {}),
    ...(typeof entry.contextWindow === "number" ? { context_window: entry.contextWindow } : {}),
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
  };
}

async function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiModelsHttpOptions,
): Promise<boolean> {
  return await authorizeGatewayBearerRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
}

async function loadAllowedCatalog(req: IncomingMessage): Promise<ModelCatalogEntry[]> {
  const cfg = loadConfig();
  const catalog = await loadGatewayModelCatalog();
  const agentId = resolveAgentIdForRequest({ req, model: undefined });
  const { allowedCatalog } = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    agentId,
  });
  return allowedCatalog.length > 0 ? allowedCatalog : catalog;
}

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`).pathname;
}

export async function handleOpenAiModelsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiModelsHttpOptions,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (requestPath !== "/v1/models" && !requestPath.startsWith("/v1/models/")) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  if (!(await authorizeRequest(req, res, opts))) {
    return true;
  }

  const catalog = await loadAllowedCatalog(req);
  if (requestPath === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: catalog.map(toOpenAiModel),
    });
    return true;
  }

  const encodedId = requestPath.slice("/v1/models/".length);
  if (!encodedId) {
    sendInvalidRequest(res, "Missing model id.");
    return true;
  }

  let decodedId: string;
  try {
    decodedId = decodeURIComponent(encodedId);
  } catch {
    sendInvalidRequest(res, "Invalid model id encoding.");
    return true;
  }

  const parsed = parseModelRef(decodedId, DEFAULT_PROVIDER);
  if (!parsed) {
    sendInvalidRequest(res, "Invalid model id.");
    return true;
  }

  const key = modelKey(parsed.provider, parsed.model);
  const entry = catalog.find((item) => modelKey(item.provider, item.id) === key);
  if (!entry) {
    sendJson(res, 404, {
      error: {
        message: `Model '${decodedId}' not found.`,
        type: "invalid_request_error",
      },
    });
    return true;
  }

  sendJson(res, 200, toOpenAiModel(entry));
  return true;
}
