import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { formatCliCommand } from "../cli/command-format.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

type ExplicitAgentSelection = {
  rawAgentId: string;
  agentId: string;
};

export class InvalidGatewayAgentIdError extends Error {
  constructor(rawAgentId: string) {
    super(
      `Unknown agent id "${rawAgentId}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
    );
    this.name = "InvalidGatewayAgentIdError";
  }
}

export function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return undefined;
}

export function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = getHeader(req, "authorization")?.trim() ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = raw.slice(7).trim();
  return token || undefined;
}

function resolveExplicitAgentIdFromHeader(
  req: IncomingMessage,
): ExplicitAgentSelection | undefined {
  const raw =
    getHeader(req, "x-openclaw-agent-id")?.trim() ||
    getHeader(req, "x-openclaw-agent")?.trim() ||
    "";
  if (!raw) {
    return undefined;
  }
  return { rawAgentId: raw, agentId: normalizeAgentId(raw) };
}

export function resolveAgentIdFromHeader(req: IncomingMessage): string | undefined {
  return resolveExplicitAgentIdFromHeader(req)?.agentId;
}

function resolveExplicitAgentIdFromModel(
  model: string | undefined,
): ExplicitAgentSelection | undefined {
  const raw = model?.trim();
  if (!raw) {
    return undefined;
  }

  const m =
    raw.match(/^openclaw[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ??
    raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i);
  const agentId = m?.groups?.agentId;
  if (!agentId) {
    return undefined;
  }
  return { rawAgentId: agentId, agentId: normalizeAgentId(agentId) };
}

export function resolveAgentIdFromModel(model: string | undefined): string | undefined {
  return resolveExplicitAgentIdFromModel(model)?.agentId;
}

function assertKnownExplicitAgentSelection(
  selection: ExplicitAgentSelection,
  knownAgentIds: readonly string[] | undefined,
): string {
  if (!knownAgentIds?.includes(selection.agentId)) {
    throw new InvalidGatewayAgentIdError(selection.rawAgentId);
  }
  return selection.agentId;
}

export function resolveAgentIdForRequest(params: {
  req: IncomingMessage;
  model: string | undefined;
  knownAgentIds?: readonly string[];
}): string {
  const fromHeader = resolveExplicitAgentIdFromHeader(params.req);
  if (fromHeader) {
    return assertKnownExplicitAgentSelection(fromHeader, params.knownAgentIds);
  }

  const fromModel = resolveExplicitAgentIdFromModel(params.model);
  if (fromModel) {
    return assertKnownExplicitAgentSelection(fromModel, params.knownAgentIds);
  }

  return "main";
}

export function resolveSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
  prefix: string;
}): string {
  const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
  if (explicit) {
    return explicit;
  }

  const user = params.user?.trim();
  const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}

export function resolveGatewayRequestContext(params: {
  req: IncomingMessage;
  model: string | undefined;
  user?: string | undefined;
  sessionPrefix: string;
  defaultMessageChannel: string;
  useMessageChannelHeader?: boolean;
  knownAgentIds?: readonly string[];
}): { agentId: string; sessionKey: string; messageChannel: string } {
  const agentId = resolveAgentIdForRequest({
    req: params.req,
    model: params.model,
    knownAgentIds: params.knownAgentIds,
  });
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
