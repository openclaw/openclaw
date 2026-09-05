import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  resolveDefaultAgentId,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { modelKey, parseModelRef, resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionEntryAccessTarget } from "../config/sessions/session-accessor.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../plugins/runtime-state.js";
import {
  buildAgentMainSessionKey,
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  isValidAgentId,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  isAgentHarnessSessionStoreEntryProtected,
} from "../sessions/agent-harness-session-key.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { getHeader, type AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { authorizeResolvedSessionMutation, isResolvedIncognitoSession } from "./session-sharing.js";
import { canonicalizeSessionKeyForAgent } from "./session-store-key.js";

export {
  authorizeControlUiReadRequestOrReply,
  authorizeControlUiSessionOwnerReadRequestOrReply,
  authorizeOpenAiCompatibleHttpModelOverride,
  authorizeGatewayHttpRequestOrReply,
  authorizeScopedGatewayHttpRequestOrReply,
  checkGatewayHttpRequestAuth,
  getBearerToken,
  getHeader,
  resolveOpenAiCompatibleHttpSenderIsOwner,
  resolveSharedSecretHttpOperatorScopes,
  resolveTrustedHttpOperatorScopes,
  type AuthorizedGatewayHttpRequest,
} from "./http-auth-utils.js";

export const OPENCLAW_MODEL_ID = "openclaw";
/** Default OpenAI-compatible model alias that targets the default OpenClaw agent. */
export const OPENCLAW_DEFAULT_MODEL_ID = "openclaw/default";
const AGENT_MODEL_PATTERN = /^(?:openclaw[:/]|agent:)(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i;

class UnknownGatewayAgentError extends Error {
  constructor(readonly agentId: string) {
    super(`Unknown agent '${agentId}'.`);
    this.name = "UnknownGatewayAgentError";
  }
}

class GatewaySessionKeyOverrideError extends Error {
  constructor() {
    super("`x-openclaw-session-key` cannot use reserved internal session namespaces.");
    this.name = "GatewaySessionKeyOverrideError";
  }
}

class InvalidGatewayModelError extends Error {
  constructor() {
    super("Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.");
    this.name = "InvalidGatewayModelError";
  }
}

class GatewayAgentSelectionConflictError extends Error {
  constructor(selected: string, fromSessionKey: string) {
    super(
      `Selected agent '${selected}' does not match the agent in \`x-openclaw-session-key\` ('${fromSessionKey}').`,
    );
    this.name = "GatewayAgentSelectionConflictError";
  }
}

export function isUnknownGatewayAgentError(err: unknown): err is UnknownGatewayAgentError {
  return err instanceof UnknownGatewayAgentError;
}

export function isAgentSelectionRequiredError(err: unknown): err is AgentSelectionRequiredError {
  return err instanceof AgentSelectionRequiredError;
}

export function isGatewayAgentRequestError(err: unknown): err is Error {
  return (
    isAgentSelectionRequiredError(err) ||
    err instanceof InvalidGatewayModelError ||
    isUnknownGatewayAgentError(err) ||
    err instanceof GatewayAgentSelectionConflictError
  );
}

export function isGatewayRequestContextError(err: unknown): err is Error {
  return isGatewayAgentRequestError(err) || err instanceof GatewaySessionKeyOverrideError;
}

export function isGatewayAgentSelectionConflictError(
  err: unknown,
): err is GatewayAgentSelectionConflictError {
  return err instanceof GatewayAgentSelectionConflictError;
}

function assertKnownAgentId(agentId: string, cfg = getRuntimeConfig()): void {
  if (!listAgentIds(cfg).includes(agentId)) {
    throw new UnknownGatewayAgentError(agentId);
  }
}

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
    return tryResolveDefaultAgentId(cfg);
  }

  const agentId = raw.match(AGENT_MODEL_PATTERN)?.groups?.agentId;
  if (!agentId) {
    return undefined;
  }
  return normalizeAgentId(agentId);
}

/** Checks OpenClaw routing-model syntax without resolving fleet ownership. */
export function isOpenClawAgentModelId(model: string | undefined): boolean {
  const raw = model?.trim();
  if (!raw) {
    return false;
  }
  const lowered = normalizeLowercaseStringOrEmpty(raw);
  if (lowered === OPENCLAW_MODEL_ID || lowered === OPENCLAW_DEFAULT_MODEL_ID) {
    return true;
  }
  return AGENT_MODEL_PATTERN.test(raw);
}

/** Validates and resolves the `x-openclaw-model` override for OpenAI-compatible requests. */
export async function resolveOpenAiCompatModelOverride(params: {
  req: IncomingMessage;
  agentId: string;
  model: string | undefined;
}): Promise<{ modelOverride?: string; errorMessage?: string }> {
  const requestModel = params.model?.trim();
  if (requestModel && !isOpenClawAgentModelId(requestModel)) {
    return {
      errorMessage: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
    };
  }

  const raw = getHeader(params.req, "x-openclaw-model")?.trim();
  if (!raw) {
    return {};
  }

  const cfg = getRuntimeConfig();
  const defaultModelRef = resolveDefaultModelForAgent({ cfg, agentId: params.agentId });
  const defaultProvider = defaultModelRef.provider;
  const workspaceDir = getActivePluginRegistryWorkspaceDirFromState();
  const manifestMetadataSnapshot = getCurrentPluginMetadataSnapshot({
    config: cfg,
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
  const modelManifestContext = {
    manifestPlugins: manifestMetadataSnapshot,
  };
  const parsed = parseModelRef(raw, defaultProvider, {
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });
  if (!parsed) {
    return { errorMessage: "Invalid `x-openclaw-model`." };
  }

  // Overrides must pass the same visibility policy as model picker surfaces;
  // otherwise API clients could target hidden plugin/provider models by header.
  const catalog = await loadGatewayModelCatalog({ agentId: params.agentId });
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
  if (!policy.allows(parsed)) {
    return {
      errorMessage: `Model '${normalized}' is not allowed for agent '${params.agentId}'.`,
    };
  }

  return { modelOverride: raw };
}

function resolveAgentIdFromSessionKeyHeader(req: IncomingMessage): string | undefined {
  const explicit = getHeader(req, "x-openclaw-session-key")?.trim();
  if (!explicit) {
    return undefined;
  }
  const agentId = parseAgentSessionKey(explicit)?.agentId;
  return agentId ? normalizeAgentId(agentId) : undefined;
}

// `openclaw` and `openclaw/default` name no agent, so they must not outrank an
// agent-scoped session key. Only the suffixed forms select an agent by id.
function resolveNamedAgentIdFromModel(model: string | undefined): string | undefined {
  const raw = model?.trim();
  if (!raw) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(raw);
  if (lowered === OPENCLAW_MODEL_ID || lowered === OPENCLAW_DEFAULT_MODEL_ID) {
    return undefined;
  }
  return resolveAgentIdFromModel(raw);
}

// The session key owns execution downstream: command preparation derives its
// agent from `agent:<id>:` when nothing overrides it. A selector that names a
// different agent would run one agent under another's session, so reject it
// here instead of splitting the owner across the two layers.
function assertSessionKeyAgentMatches(selected: string, fromSessionKey: string | undefined): void {
  if (fromSessionKey && fromSessionKey !== selected) {
    throw new GatewayAgentSelectionConflictError(selected, fromSessionKey);
  }
}

/** Resolves the request agent from headers, model alias, session key, or the configured default. */
export function resolveAgentIdForRequest(params: {
  req: IncomingMessage;
  model: string | undefined;
}): string {
  const cfg = getRuntimeConfig();
  if (params.model?.trim() && !isOpenClawAgentModelId(params.model)) {
    throw new InvalidGatewayModelError();
  }

  const fromSessionKey = resolveAgentIdFromSessionKeyHeader(params.req);

  const headerAgent =
    normalizeOptionalString(getHeader(params.req, "x-openclaw-agent-id")) ||
    normalizeOptionalString(getHeader(params.req, "x-openclaw-agent"));
  if (headerAgent) {
    if (!isValidAgentId(headerAgent)) {
      throw new UnknownGatewayAgentError(headerAgent);
    }
    const agentId = normalizeAgentId(headerAgent);
    assertKnownAgentId(agentId, cfg);
    assertSessionKeyAgentMatches(agentId, fromSessionKey);
    return agentId;
  }

  const fromModel = resolveNamedAgentIdFromModel(params.model);
  if (fromModel) {
    assertKnownAgentId(fromModel, cfg);
    assertSessionKeyAgentMatches(fromModel, fromSessionKey);
    return fromModel;
  }

  if (fromSessionKey) {
    assertKnownAgentId(fromSessionKey, cfg);
    return fromSessionKey;
  }

  return resolveDefaultAgentId(cfg);
}

function isReservedSessionKeyOverride(sessionKey: string, agentId: string): boolean {
  const lowered = normalizeLowercaseStringOrEmpty(sessionKey);
  const harnessLookupKey = sessionKey.startsWith("agent:")
    ? sessionKey
    : canonicalizeSessionKeyForAgent(agentId, sessionKey);
  const harnessEntry = isAgentHarnessSessionKey(sessionKey)
    ? resolveSessionEntryAccessTarget({
        cfg: getRuntimeConfig(),
        sessionKey: harnessLookupKey,
      }).entry
    : undefined;
  const harnessKeyReserved =
    isAgentHarnessSessionKey(sessionKey) &&
    (!harnessEntry || isAgentHarnessSessionStoreEntryProtected(sessionKey, harnessEntry));
  return (
    lowered.startsWith("subagent:") ||
    lowered.startsWith("cron:") ||
    lowered.startsWith("acp:") ||
    harnessKeyReserved ||
    isSubagentSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey)
  );
}

export function resolveGatewayRequestContext(params: {
  req: IncomingMessage;
  model: string | undefined;
  user?: string | undefined;
  sessionPrefix: string;
}): { agentId: string; sessionKey: string; messageChannel: string } {
  const agentId = resolveAgentIdForRequest({ req: params.req, model: params.model });
  const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
  let sessionKey: string;
  if (explicit) {
    if (isReservedSessionKeyOverride(explicit, agentId)) {
      throw new GatewaySessionKeyOverrideError();
    }
    sessionKey = explicit;
  } else {
    const user = params.user?.trim();
    const mainKey = user
      ? `${params.sessionPrefix}-user:${user}`
      : `${params.sessionPrefix}:${randomUUID()}`;
    sessionKey = buildAgentMainSessionKey({ agentId, mainKey });
  }

  const messageChannel =
    normalizeMessageChannel(getHeader(params.req, "x-openclaw-message-channel")) ?? "webchat";

  return { agentId, sessionKey, messageChannel };
}

export function authorizeOpenAiCompatibleHttpSession(params: {
  agentId: string;
  sessionKey: string;
  requestAuth: AuthorizedGatewayHttpRequest;
  senderIsOwner: boolean;
}): { allowed: true } | { allowed: false; message: string } {
  const cfg = getRuntimeConfig();
  const authenticatedUserProfile = params.requestAuth.authenticatedUserProfile;
  const authorizationError = authorizeResolvedSessionMutation({
    cfg,
    client: createSyntheticPluginRuntimeClient({
      ...(authenticatedUserProfile ? { authenticatedUserProfile } : {}),
      operatorRoleActor: params.requestAuth.operatorRoleActor,
      operatorAccessAuthority: params.requestAuth.operatorAccessAuthority,
      scopes: params.senderIsOwner ? [ADMIN_SCOPE] : [],
    }),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (authorizationError) {
    return { allowed: false, message: authorizationError.message };
  }
  if (
    !params.senderIsOwner &&
    !authenticatedUserProfile &&
    isResolvedIncognitoSession({ cfg, sessionKey: params.sessionKey, agentId: params.agentId })
  ) {
    return { allowed: false, message: `missing scope: ${ADMIN_SCOPE}` };
  }
  return { allowed: true };
}
