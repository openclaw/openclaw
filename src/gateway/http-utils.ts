import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { modelKey, parseModelRef, resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { getHeader } from "./http-auth-utils.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";

export {
  authorizeGatewayHttpRequestOrReply,
  authorizeScopedGatewayHttpRequestOrReply,
  checkGatewayHttpRequestAuth,
  getBearerToken,
  getHeader,
  isGatewayBearerHttpRequest,
  resolveHttpBrowserOriginPolicy,
  resolveHttpSenderIsOwner,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
  resolveSharedSecretHttpOperatorScopes,
  resolveTrustedHttpOperatorScopes,
  type AuthorizedGatewayHttpRequest,
  type GatewayHttpRequestAuthCheckResult,
} from "./http-auth-utils.js";

export const OPENCLAW_MODEL_ID = "openclaw";
export const OPENCLAW_DEFAULT_MODEL_ID = "openclaw/default";

function resolveAgentIdFromHeader(req: IncomingMessage): string | undefined {
  const raw =
    normalizeOptionalString(getHeader(req, "x-openclaw-agent-id")) ||
    normalizeOptionalString(getHeader(req, "x-openclaw-agent")) ||
    "";
  if (!raw) {
    return undefined;
  }
  return normalizeAgentId(raw);
}

/** Resolves OpenAI-compatible model ids like `openclaw/<agentId>` into Gateway agent ids. */
export function resolveAgentIdFromModel(
  model: string | undefined,
  cfg = getRuntimeConfig(),
): string | undefined {
  const raw = model?.trim();
  if (!raw) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(raw);
  if (lowered === OPENCLAW_MODEL_ID || lowered === OPENCLAW_DEFAULT_MODEL_ID) {
    return resolveDefaultAgentId(cfg);
  }

  const m =
    raw.match(/^openclaw[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ??
    raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i);
  const agentId = m?.groups?.agentId;
  if (!agentId) {
    return undefined;
  }
  return normalizeAgentId(agentId);
}

/** Validates the optional `x-openclaw-model` override against the agent's visible model catalog. */
export async function resolveOpenAiCompatModelOverride(params: {
  /** Incoming HTTP request carrying the optional x-openclaw-model header. */
  req: IncomingMessage;
  /** Target agent whose default provider and visibility policy scope the override. */
  agentId: string;
  /** OpenAI-compatible request model, used to reject malformed agent selectors early. */
  model: string | undefined;
}): Promise<{ modelOverride?: string; errorMessage?: string }> {
  const requestModel = params.model?.trim();
  if (requestModel && !resolveAgentIdFromModel(requestModel)) {
    return {
      errorMessage: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
    };
  }

  const raw = getHeader(params.req, "x-openclaw-model")?.trim();
  if (!raw) {
    return {};
  }

  // Header model overrides use the target agent's default provider as context,
  // then pass through visibility policy so hidden/catalog-blocked models fail.
  const cfg = getRuntimeConfig();
  const defaultModelRef = resolveDefaultModelForAgent({ cfg, agentId: params.agentId });
  const defaultProvider = defaultModelRef.provider;
  const manifestMetadataSnapshot = loadManifestMetadataSnapshot({
    config: cfg,
    env: process.env,
  });
  const modelManifestContext = {
    manifestPlugins: manifestMetadataSnapshot.plugins,
  };
  const parsed = parseModelRef(raw, defaultProvider, {
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });
  if (!parsed) {
    return { errorMessage: "Invalid `x-openclaw-model`." };
  }

  const catalog = await loadGatewayModelCatalog();
  const policy = createModelVisibilityPolicy({
    cfg,
    catalog,
    defaultProvider,
    agentId: params.agentId,
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });
  const normalized = modelKey(parsed.provider, parsed.model);
  if (!policy.allowsKey(normalized)) {
    return {
      errorMessage: `Model '${normalized}' is not allowed for agent '${params.agentId}'.`,
    };
  }

  return { modelOverride: raw };
}

/** Resolves the target agent from explicit headers, OpenAI-compatible model ids, then config. */
export function resolveAgentIdForRequest(params: {
  /** Incoming HTTP request carrying optional agent headers. */
  req: IncomingMessage;
  /** OpenAI-compatible request model that may encode the target agent. */
  model: string | undefined;
}): string {
  const cfg = getRuntimeConfig();
  const fromHeader = resolveAgentIdFromHeader(params.req);
  if (fromHeader) {
    return fromHeader;
  }

  const fromModel = resolveAgentIdFromModel(params.model, cfg);
  return fromModel ?? resolveDefaultAgentId(cfg);
}

function resolveSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
  prefix: string;
}): string {
  const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
  if (explicit) {
    // Explicit session keys are an interop escape hatch for HTTP clients that
    // already manage Gateway sessions; generated keys stay agent-scoped below.
    return explicit;
  }

  const user = params.user?.trim();
  const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}

/** Builds the agent/session/channel context shared by HTTP compatibility endpoints. */
export function resolveGatewayRequestContext(params: {
  /** Incoming HTTP request carrying optional session/channel headers. */
  req: IncomingMessage;
  /** OpenAI-compatible request model that may encode the target agent. */
  model: string | undefined;
  /** Optional OpenAI user id folded into generated session keys. */
  user?: string | undefined;
  /** Prefix used when generating a new Gateway session key. */
  sessionPrefix: string;
  /** Message channel used unless the endpoint opts into the channel header. */
  defaultMessageChannel: string;
  /** Whether x-openclaw-message-channel may override the default channel. */
  useMessageChannelHeader?: boolean;
}): { agentId: string; sessionKey: string; messageChannel: string } {
  const agentId = resolveAgentIdForRequest({ req: params.req, model: params.model });
  const sessionKey = resolveSessionKey({
    req: params.req,
    agentId,
    user: params.user,
    prefix: params.sessionPrefix,
  });

  const messageChannel = params.useMessageChannelHeader
    ? (normalizeMessageChannel(getHeader(params.req, "x-openclaw-message-channel")) ??
      params.defaultMessageChannel)
    : params.defaultMessageChannel;

  return { agentId, sessionKey, messageChannel };
}
