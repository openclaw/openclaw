// OpenAI-compatible `/v1/models` HTTP route backed by configured OpenClaw agents.
import type { IncomingMessage, ServerResponse } from "node:http";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/io.js";
import { listSpeechProviders } from "../tts/provider-registry.js";
import { isTtsProviderConfigured, resolveTtsConfig } from "../tts/tts.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
} from "./http-common.js";
import {
  OPENCLAW_DEFAULT_MODEL_ID,
  OPENCLAW_MODEL_ID,
  authorizeGatewayHttpRequestOrReply,
  type AuthorizedGatewayHttpRequest,
  resolveAgentIdFromModel,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

type OpenAiModelsHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  /** When true, list configured TTS providers as `tts/<provider>` models. */
  audioSpeechEnabled?: boolean;
};

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

async function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiModelsHttpOptions,
): Promise<AuthorizedGatewayHttpRequest | null> {
  return await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
}

function loadAgentModelIds(): string[] {
  const cfg = getRuntimeConfig();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const ids = new Set<string>([OPENCLAW_MODEL_ID, OPENCLAW_DEFAULT_MODEL_ID]);
  ids.add(`openclaw/${defaultAgentId}`);
  for (const agentId of listAgentIds(cfg)) {
    ids.add(`openclaw/${agentId}`);
  }
  return Array.from(ids);
}

/** List configured-and-available TTS providers as `tts/<provider>` model ids. */
function loadTtsModelIds(): string[] {
  const cfg = getRuntimeConfig();
  const ttsConfig = resolveTtsConfig(cfg);
  return listSpeechProviders(cfg)
    .filter((provider) => isTtsProviderConfigured(ttsConfig, provider.id, cfg))
    .map((provider) => `tts/${provider.id}`);
}

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

/** Handle OpenAI-compatible model list/detail requests, returning false for unrelated paths. */
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

  const requestAuth = await authorizeRequest(req, res, opts);
  if (!requestAuth) {
    return true;
  }

  const requestedScopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod("models.list", requestedScopes);
  if (!scopeAuth.allowed) {
    sendMissingScopeForbidden(res, scopeAuth.missingScope);
    return true;
  }

  const ids = loadAgentModelIds();
  const ttsIds = opts.audioSpeechEnabled ? loadTtsModelIds() : [];
  if (requestPath === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: [...ids, ...ttsIds].map(toOpenAiModel),
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

  // TTS providers use their own `tts/<provider>` namespace and bypass the
  // agent-model validation used for `openclaw/<agentId>` ids.
  if (ttsIds.includes(decodedId)) {
    sendJson(res, 200, toOpenAiModel(decodedId));
    return true;
  }

  if (decodedId !== OPENCLAW_MODEL_ID && !resolveAgentIdFromModel(decodedId)) {
    sendInvalidRequest(res, "Invalid model id.");
    return true;
  }

  if (!ids.includes(decodedId)) {
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
