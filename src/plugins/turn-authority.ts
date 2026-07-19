/** Canonical immutable authority snapshot for one admitted turn. */
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAuthorizationInvocationContext,
  createAuthorizationPrincipal,
} from "./authorization-policy-context.js";
import type {
  AuthorizationInvocationContext,
  AuthorizationPrincipal,
  TurnAuthoritySnapshot,
} from "./authorization-policy.types.js";

const issuedTurnAuthoritySnapshots = new WeakSet<object>();
const INVALID_TURN_AUTHORITY_ERROR_MESSAGE = "turn-authority-invalid";

export type ClassifiedTurnAuthority =
  | { kind: "absent" }
  | { kind: "issued"; snapshot: TurnAuthoritySnapshot }
  | { kind: "invalid" };

/** Non-throwing tri-state inspection for request boundaries that must shape invalid input. */
export function classifyTurnAuthoritySnapshot(value: unknown): ClassifiedTurnAuthority {
  if (value === undefined) {
    return { kind: "absent" };
  }
  if (isIssuedTurnAuthoritySnapshot(value)) {
    return { kind: "issued", snapshot: value };
  }
  return { kind: "invalid" };
}

function throwInvalidTurnAuthority(): never {
  const error = new Error(INVALID_TURN_AUTHORITY_ERROR_MESSAGE);
  error.name = "TurnAuthorityValidationError";
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined | false {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return false;
  }
  return normalizeOptionalString(value) ?? false;
}

function readOptionalBoolean(value: unknown): boolean | undefined | null {
  return value === undefined || typeof value === "boolean" ? value : null;
}

function readOptionalStrings(value: unknown): readonly string[] | undefined | false {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return false;
  }
  return value;
}

function decodeAuthorizationPrincipal(value: unknown): AuthorizationPrincipal | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return undefined;
  }
  const provider = readOptionalString(value.provider);
  const accountId = readOptionalString(value.accountId);
  if (provider === false || accountId === false) {
    return undefined;
  }
  if (value.kind === "sender") {
    const senderId = readOptionalString(value.senderId);
    const aliases = value.aliases;
    if (aliases !== undefined && !isRecord(aliases)) {
      return undefined;
    }
    const senderName = readOptionalString(isRecord(aliases) ? aliases.name : undefined);
    const senderUsername = readOptionalString(isRecord(aliases) ? aliases.username : undefined);
    const senderE164 = readOptionalString(isRecord(aliases) ? aliases.e164 : undefined);
    const senderIsOwner = readOptionalBoolean(value.senderIsOwner);
    const isAuthorizedSender = readOptionalBoolean(value.isAuthorizedSender);
    const roleIds = readOptionalStrings(value.roleIds);
    if (
      !senderId ||
      senderName === false ||
      senderUsername === false ||
      senderE164 === false ||
      senderIsOwner === null ||
      isAuthorizedSender === null ||
      roleIds === false
    ) {
      return undefined;
    }
    return createAuthorizationPrincipal({
      provider,
      accountId,
      senderId,
      senderName,
      senderUsername,
      senderE164,
      senderIsOwner,
      isAuthorizedSender,
      roleIds,
    });
  }
  if (value.kind === "operator") {
    const scopes = readOptionalStrings(value.scopes);
    const clientId = readOptionalString(value.clientId);
    const deviceId = readOptionalString(value.deviceId);
    const isOwner = readOptionalBoolean(value.isOwner);
    if (!scopes || clientId === false || deviceId === false || isOwner === null) {
      return undefined;
    }
    return createAuthorizationPrincipal({
      operatorScopes: scopes,
      operatorClientId: clientId,
      operatorDeviceId: deviceId,
      operatorIsOwner: isOwner,
    });
  }
  if (value.kind === "service") {
    const serviceId = readOptionalString(value.serviceId);
    return serviceId ? createAuthorizationPrincipal({ serviceId }) : undefined;
  }
  if (value.kind === "unknown") {
    return createAuthorizationPrincipal({ provider, accountId });
  }
  return undefined;
}

function decodeAuthorizationInvocationContext(
  value: unknown,
): AuthorizationInvocationContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const principal = decodeAuthorizationPrincipal(value.principal);
  if (!principal) {
    return undefined;
  }
  const agentId = readOptionalString(value.agentId);
  const sessionKey = readOptionalString(value.sessionKey);
  const sessionId = readOptionalString(value.sessionId);
  const runId = readOptionalString(value.runId);
  const conversationId = readOptionalString(value.conversationId);
  const parentConversationId = readOptionalString(value.parentConversationId);
  const trigger = readOptionalString(value.trigger);
  const threadId =
    value.threadId === undefined ||
    (typeof value.threadId === "number" && Number.isFinite(value.threadId)) ||
    typeof value.threadId === "string"
      ? value.threadId
      : false;
  if (
    agentId === false ||
    sessionKey === false ||
    sessionId === false ||
    runId === false ||
    conversationId === false ||
    parentConversationId === false ||
    trigger === false ||
    threadId === false
  ) {
    return undefined;
  }
  return createAuthorizationInvocationContext({
    principal,
    agentId,
    sessionKey,
    sessionId,
    runId,
    conversationId,
    parentConversationId,
    threadId,
    trigger,
  });
}

function freezePrincipal(principal: AuthorizationPrincipal): AuthorizationPrincipal {
  if (principal.kind === "sender") {
    const normalized = createAuthorizationPrincipal({
      provider: principal.provider,
      accountId: principal.accountId,
      senderId: principal.senderId,
      senderName: principal.aliases?.name,
      senderUsername: principal.aliases?.username,
      senderE164: principal.aliases?.e164,
      senderIsOwner: principal.senderIsOwner,
      isAuthorizedSender: principal.isAuthorizedSender,
      roleIds: principal.roleIds,
    });
    if (normalized.kind !== "sender") {
      throw new Error("sender authority requires a sender id");
    }
    return Object.freeze({
      ...normalized,
      ...(normalized.aliases ? { aliases: Object.freeze({ ...normalized.aliases }) } : {}),
      ...(normalized.roleIds ? { roleIds: Object.freeze([...normalized.roleIds]) } : {}),
    });
  }
  if (principal.kind === "operator") {
    return Object.freeze({
      ...principal,
      scopes: Object.freeze([...principal.scopes]),
    });
  }
  return Object.freeze({ ...principal });
}

function freezeAuthorization(
  authorization: AuthorizationInvocationContext,
): Readonly<AuthorizationInvocationContext> {
  return Object.freeze({
    ...authorization,
    principal: freezePrincipal(authorization.principal),
  });
}

function normalizeDigest(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && /^[A-Za-z0-9_-]{16,128}$/u.test(normalized) ? normalized : undefined;
}

function digestCapability(value: string | undefined): string | undefined {
  const capability = normalizeOptionalString(value);
  return capability
    ? createHash("sha256").update(capability).digest("base64url").slice(0, 32)
    : undefined;
}

function issueTurnAuthoritySnapshot(value: {
  authorization: AuthorizationInvocationContext;
  controllerKey?: string;
  capabilityDigest?: string;
}): TurnAuthoritySnapshot {
  const snapshot = Object.freeze({
    authorization: freezeAuthorization(value.authorization),
    ...(value.controllerKey ? { controllerKey: value.controllerKey } : {}),
    ...(value.capabilityDigest ? { capabilityDigest: value.capabilityDigest } : {}),
  });
  issuedTurnAuthoritySnapshots.add(snapshot);
  return snapshot;
}

/** Issues a snapshot from host-verified principal and scope facts. */
export function createTurnAuthoritySnapshot(params: {
  principal: AuthorizationPrincipal;
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  parentConversationId?: string | null;
  threadId?: string | number | null;
  trigger?: string | null;
  controllerKey?: string | null;
  capability?: string | null;
}): TurnAuthoritySnapshot {
  const authorization = freezeAuthorization(
    createAuthorizationInvocationContext({
      principal: params.principal,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      runId: params.runId,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
      threadId: params.threadId,
      trigger: params.trigger,
    }),
  );
  const controllerKey = normalizeOptionalString(params.controllerKey);
  const capabilityDigest = digestCapability(params.capability ?? undefined);
  return issueTurnAuthoritySnapshot({
    authorization,
    controllerKey,
    capabilityDigest,
  });
}

/** Issues authority from the Gateway's authenticated operator connection facts. */
export function createOperatorTurnAuthoritySnapshot(params: {
  scopes?: readonly string[] | null;
  pairedClientId?: string | null;
  deviceId?: string | null;
  connectionId?: string | null;
  isOwner?: boolean;
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  parentConversationId?: string | null;
  threadId?: string | number | null;
  trigger?: string | null;
  capability?: string | null;
}): TurnAuthoritySnapshot {
  const deviceId = normalizeOptionalString(params.deviceId);
  const connectionId = normalizeOptionalString(params.connectionId);
  return createTurnAuthoritySnapshot({
    principal: createAuthorizationPrincipal({
      operatorScopes: params.scopes,
      operatorClientId: params.pairedClientId,
      operatorDeviceId: deviceId,
      operatorIsOwner: params.isOwner,
    }),
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
    threadId: params.threadId,
    trigger: params.trigger,
    controllerKey: deviceId
      ? `device:${deviceId}`
      : connectionId
        ? `connection:${connectionId}`
        : undefined,
    capability: params.capability,
  });
}

/** Re-issues values only after their signed transport envelope was verified. */
export function restoreVerifiedTurnAuthoritySnapshot(
  value: unknown,
): TurnAuthoritySnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const authorization = decodeAuthorizationInvocationContext(value.authorization);
  const controllerKey = normalizeOptionalString(value.controllerKey);
  const capabilityDigest = normalizeDigest(
    typeof value.capabilityDigest === "string" ? value.capabilityDigest : undefined,
  );
  if (
    !authorization ||
    (value.controllerKey !== undefined && !controllerKey) ||
    (value.capabilityDigest !== undefined && !capabilityDigest)
  ) {
    return undefined;
  }
  return issueTurnAuthoritySnapshot({ authorization, controllerKey, capabilityDigest });
}

/** Rebinds execution identity while preserving the admitted source authority and conversation. */
export function rebindTurnAuthoritySnapshot(
  source: unknown,
  params: {
    agentId: string;
    sessionKey: string;
    sessionId?: string | null;
    runId?: string | null;
    trigger: string | null | undefined;
  },
): TurnAuthoritySnapshot | undefined {
  const classified = classifyTurnAuthoritySnapshot(source);
  if (classified.kind === "absent") {
    return undefined;
  }
  if (classified.kind === "invalid") {
    throwInvalidTurnAuthority();
  }
  const sourceSnapshot = classified.snapshot;
  const authorization = createAuthorizationInvocationContext({
    principal: sourceSnapshot.authorization.principal,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    conversationId: sourceSnapshot.authorization.conversationId,
    parentConversationId: sourceSnapshot.authorization.parentConversationId,
    threadId: sourceSnapshot.authorization.threadId,
    trigger: params.trigger,
  });
  return issueTurnAuthoritySnapshot({
    authorization,
    controllerKey: sourceSnapshot.controllerKey,
    capabilityDigest: sourceSnapshot.capabilityDigest,
  });
}

export function isIssuedTurnAuthoritySnapshot(value: unknown): value is TurnAuthoritySnapshot {
  return Boolean(
    typeof value === "object" && value !== null && issuedTurnAuthoritySnapshots.has(value),
  );
}

export function resolveTurnAuthorityAuthorization(
  value: unknown,
): Readonly<AuthorizationInvocationContext> | undefined {
  const classified = classifyTurnAuthoritySnapshot(value);
  if (classified.kind === "absent") {
    return undefined;
  }
  if (classified.kind === "invalid") {
    throwInvalidTurnAuthority();
  }
  return classified.snapshot.authorization;
}
