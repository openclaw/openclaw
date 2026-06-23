// Shared ownership checks for outbound APIs that accept an explicit agent
// owner alongside an agent-scoped session key.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";

type AgentSessionOwnerCheck = {
  agentId?: string | null;
  sessionKey?: string | null;
  ownerLabel: string;
  sessionKeyLabel?: string;
};

type AgentSessionKeyCheck = {
  sessionKey?: string | null;
  label: string;
};

export type AgentSessionOwnerMismatch = {
  agentId: string;
  sessionAgentId: string;
  message: string;
};

function resolveAgentSessionKeyOwner(sessionKey?: string | null): string | undefined {
  const parsedSessionKey = parseAgentSessionKey(sessionKey);
  return parsedSessionKey?.agentId ? normalizeAgentId(parsedSessionKey.agentId) : undefined;
}

export function resolveAgentSessionOwnerMismatch(
  params: AgentSessionOwnerCheck,
): AgentSessionOwnerMismatch | undefined {
  const explicitAgentId = normalizeOptionalString(params.agentId);
  if (!explicitAgentId) {
    return undefined;
  }
  const sessionAgentId = resolveAgentSessionKeyOwner(params.sessionKey);
  if (!sessionAgentId) {
    return undefined;
  }
  const agentId = normalizeAgentId(explicitAgentId);
  if (agentId === sessionAgentId) {
    return undefined;
  }
  const sessionKeyLabel = params.sessionKeyLabel ?? "session key";
  return {
    agentId,
    sessionAgentId,
    message: `${params.ownerLabel} agentId "${agentId}" does not match ${sessionKeyLabel} agent "${sessionAgentId}"`,
  };
}

export function assertAgentSessionOwnerMatch(params: AgentSessionOwnerCheck): void {
  const mismatch = resolveAgentSessionOwnerMismatch(params);
  if (mismatch) {
    throw new Error(mismatch.message);
  }
}

function assertAgentSessionKeyOwnersMatch(params: {
  ownerLabel: string;
  leftSessionKey?: string | null;
  leftSessionKeyLabel: string;
  rightSessionKey?: string | null;
  rightSessionKeyLabel: string;
}): void {
  const leftAgentId = resolveAgentSessionKeyOwner(params.leftSessionKey);
  const rightAgentId = resolveAgentSessionKeyOwner(params.rightSessionKey);
  if (!leftAgentId || !rightAgentId || leftAgentId === rightAgentId) {
    return;
  }
  throw new Error(
    `${params.ownerLabel} ${params.leftSessionKeyLabel} agent "${leftAgentId}" does not match ${params.rightSessionKeyLabel} agent "${rightAgentId}"`,
  );
}

export function assertAgentSessionOwnership(params: {
  ownerLabel: string;
  agentIds?: readonly (string | null | undefined)[];
  sessionKeys?: readonly AgentSessionKeyCheck[];
}): void {
  const sessionKeys = params.sessionKeys ?? [];
  for (const agentId of params.agentIds ?? []) {
    for (const sessionKey of sessionKeys) {
      assertAgentSessionOwnerMatch({
        ownerLabel: params.ownerLabel,
        agentId,
        sessionKey: sessionKey.sessionKey,
        sessionKeyLabel: sessionKey.label,
      });
    }
  }
  for (let i = 0; i < sessionKeys.length; i += 1) {
    for (let j = i + 1; j < sessionKeys.length; j += 1) {
      const left = sessionKeys[i];
      const right = sessionKeys[j];
      assertAgentSessionKeyOwnersMatch({
        ownerLabel: params.ownerLabel,
        leftSessionKey: left?.sessionKey,
        leftSessionKeyLabel: left?.label ?? "session key",
        rightSessionKey: right?.sessionKey,
        rightSessionKeyLabel: right?.label ?? "session key",
      });
    }
  }
}
