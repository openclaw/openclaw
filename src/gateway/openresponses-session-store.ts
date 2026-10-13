import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { validateKey } from "../plugin-state/plugin-state-store.validation.js";
import {
  isIncognitoResponseSession,
  MAX_RESPONSE_SESSION_ENTRIES,
  RESPONSE_SESSION_RETENTION_MS,
  type ResponseSessionLookup,
  type ResponseSessionScope,
  type ResponseSessionWrite,
} from "./openresponses-session-store.types.js";

function openStore(env?: NodeJS.ProcessEnv) {
  return createCorePluginStateKeyedStore<ResponseSessionScope & { sessionKey: string }>({
    ownerId: "core:openresponses",
    namespace: "response-sessions",
    defaultTtlMs: RESPONSE_SESSION_RETENTION_MS,
    maxEntries: MAX_RESPONSE_SESSION_ENTRIES,
    overflowPolicy: "evict-oldest",
    env,
  });
}

export async function lookupResponseSession(
  input: ResponseSessionLookup,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    if (validateKey(input.responseId, "lookup") !== input.responseId) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const stored = await openStore(env).lookup(input.responseId);
  return stored?.authSubject === input.authSubject &&
    stored.agentId === input.agentId &&
    stored.requestedSessionKey === input.requestedSessionKey
    ? stored.sessionKey
    : undefined;
}

export async function rememberResponseSession(
  input: ResponseSessionWrite,
  assertCurrent: () => void,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (isIncognitoResponseSession(input)) {
    return;
  }
  const { responseId, sessionKey, authSubject, agentId, requestedSessionKey } = input;
  await openStore(env).register(
    responseId,
    {
      sessionKey,
      authSubject,
      agentId,
      ...(requestedSessionKey === undefined ? {} : { requestedSessionKey }),
    },
    { assertCurrent },
  );
  assertCurrent();
}
