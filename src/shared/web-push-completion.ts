/** Native final-response identity, never a navigation hint or display tag. */
export type WebPushCompletion = {
  version: 1;
  agentId: string;
  sessionKey: string;
  runId: string;
  messageId: string;
  profileId: string | null;
};

function identityPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export function readWebPushCompletion(value: unknown): WebPushCompletion | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !identityPart(record.agentId) ||
    !identityPart(record.sessionKey) ||
    !identityPart(record.runId) ||
    !identityPart(record.messageId) ||
    !(record.profileId === null || identityPart(record.profileId))
  ) {
    return null;
  }
  return {
    version: 1,
    agentId: record.agentId,
    sessionKey: record.sessionKey,
    runId: record.runId,
    messageId: record.messageId,
    profileId: record.profileId,
  };
}

/** Final lifecycle frames can carry the committed key before history supplies the row ID. */
export function webPushCompletionMessageId(identity: {
  id: string | null;
  idempotencyKey: string | null;
}): string | null {
  return identity.idempotencyKey
    ? `key:${identity.idempotencyKey}`
    : identity.id
      ? `id:${identity.id}`
      : null;
}

export function webPushCompletionKey(value: WebPushCompletion): string {
  return JSON.stringify([
    value.agentId, value.sessionKey, value.runId, value.messageId, value.profileId,
  ]);
}
