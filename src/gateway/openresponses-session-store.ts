import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { validateKey } from "../plugin-state/plugin-state-store.validation.js";
import { isIncognitoSessionKey, toAgentStoreSessionKey } from "../routing/session-key.js";

type ResponseSessionScope = {
  authSubject: string;
  agentId: string;
  requestedSessionKey?: string;
};

function openStore(env?: NodeJS.ProcessEnv) {
  return createCorePluginStateKeyedStore<ResponseSessionScope & { sessionKey: string }>({
    ownerId: "core:openresponses",
    namespace: "response-sessions",
    // Match the default session maintenance age and count; response metadata stays bounded too.
    defaultTtlMs: 30 * 24 * 60 * 60_000,
    maxEntries: 5_000,
    overflowPolicy: "evict-oldest",
    env,
  });
}

export async function lookupResponseSession(
  input: ResponseSessionScope & { responseId: string },
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
  input: ResponseSessionScope & { responseId: string; sessionKey: string },
  assertCurrent: () => void,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (
    [input.sessionKey, input.requestedSessionKey].some((requestKey) =>
      isIncognitoSessionKey(toAgentStoreSessionKey({ agentId: input.agentId, requestKey })),
    )
  ) {
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
