import { isIncognitoSessionKey, toAgentStoreSessionKey } from "../routing/session-key.js";

export type ResponseSessionScope = {
  authSubject: string;
  agentId: string;
  requestedSessionKey?: string;
};

export type ResponseSessionLookup = ResponseSessionScope & {
  responseId: string;
};

export type ResponseSessionWrite = ResponseSessionLookup & { sessionKey: string };

export function isIncognitoResponseSession(input: ResponseSessionWrite): boolean {
  return [input.sessionKey, input.requestedSessionKey].some((requestKey) =>
    isIncognitoSessionKey(toAgentStoreSessionKey({ agentId: input.agentId, requestKey })),
  );
}

// Match the default session maintenance age and count; response metadata stays bounded too.
export const RESPONSE_SESSION_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const MAX_RESPONSE_SESSION_ENTRIES = 5_000;
