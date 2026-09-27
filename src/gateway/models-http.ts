// OpenAI-compatible `/v1/models` HTTP route backed by configured OpenClaw agents.
import type { IncomingMessage, ServerResponse } from "node:http";
import { listAgentIds, tryResolveLegacyCompatibilityAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/io.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
  sendUnauthorized,
} from "./http-common.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import {
  OPENCLAW_DEFAULT_MODEL_ID,
  OPENCLAW_MODEL_ID,
  authorizeGatewayHttpRequestOrReply,
  isOpenClawAgentModelId,
  resolveAgentIdFromModel,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-utils.js";
import { READ_SCOPE } from "./operator-scopes.js";

type OpenAiModelObject = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  permission: [];
};

function toOpenAiModel(id: string): OpenAiModelObject {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "openclaw",
    permission: [],
  };
}

function loadAgentModelIds(): string[] {
  const cfg = getRuntimeConfig();
  const ids = new Set<string>([OPENCLAW_MODEL_ID, OPENCLAW_DEFAULT_MODEL_ID]);
  const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
  if (compatibilityAgentId) {
    ids.add(`openclaw/${compatibilityAgentId}`);
  }
  for (const agentId of listAgentIds(cfg)) {
    ids.add(`openclaw/${agentId}`);
  }
  return Array.from(ids);
}

/** Handle OpenAI-compatible model list/detail requests, returning false for unrelated paths. */
export async function handleOpenAiModelsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayHttpRequestAuthOptions,
): Promise<boolean> {
  const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
  if (requestPath !== "/v1/models" && !requestPath.startsWith("/v1/models/")) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const requestAuth = await authorizeGatewayHttpRequestOrReply({ ...opts, req, res });
  if (!requestAuth) {
    return true;
  }
  if (!requestAuth.hasCurrentClientAuthority()) {
    sendUnauthorized(res);
    return true;
  }

  const requestedScopes = resolveSharedSecretHttpOperatorScopes(req, requestAuth);
  // The compatibility catalog exposes global agent targets and keeps its general read floor.
  if (!operatorScopeSatisfied(READ_SCOPE, requestedScopes)) {
    sendMissingScopeForbidden(res, READ_SCOPE);
    return true;
  }

  const ids = loadAgentModelIds();
  if (requestPath === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: ids.map(toOpenAiModel),
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

  if (!isOpenClawAgentModelId(decodedId)) {
    sendInvalidRequest(res, "Invalid model id.");
    return true;
  }

  const normalizedModelId = decodedId.trim().toLowerCase();
  let configured = true;
  if (normalizedModelId !== OPENCLAW_MODEL_ID && normalizedModelId !== OPENCLAW_DEFAULT_MODEL_ID) {
    const cfg = getRuntimeConfig();
    const agentId = resolveAgentIdFromModel(decodedId, cfg);
    configured = Boolean(agentId && listAgentIds(cfg).includes(agentId));
  }

  if (!configured || !ids.includes(decodedId)) {
    sendJson(res, 404, {
      error: {
        message: `Model '${decodedId}' not found.`,
        type: "invalid_request_error",
      },
    });
    return true;
  }

  sendJson(res, 200, toOpenAiModel(decodedId));
  return true;
}
