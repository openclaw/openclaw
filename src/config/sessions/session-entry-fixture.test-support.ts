import { it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readSessionEntriesFromStoreInWorker } from "./session-entry-read-runtime.js";

type ReadOptions = Extract<
  Parameters<typeof readSessionEntriesFromStoreInWorker>[0],
  { sessionKeys: readonly string[] }
>;
export function entryFixture(env: NodeJS.ProcessEnv, name = "test", agentId = "main") {
  const database = openOpenClawAgentDatabase({ agentId, env });
  const sessionKey = `agent:${agentId}:${name}`;
  const store = { agentId, storePath: database.path, env };
  const scope = { ...store, sessionKey };
  const input = { ...store, sessionKeys: [sessionKey] };
  const read = (options: Partial<ReadOptions> = {}) =>
    readSessionEntriesFromStoreInWorker({ ...input, ...options });
  return {
    database,
    store,
    scope,
    input,
    sessionKey,
    env,
    options: { agentId, path: database.path, env },
    read,
    entry: async (options: Partial<ReadOptions> = {}) => (await read(options)).entries[0]?.entry,
    replace: (entry: Partial<Parameters<typeof replaceSessionEntrySync>[1]> = {}) =>
      replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1, ...entry }),
  };
}

export function sessionTests(
  options: Parameters<typeof withOpenClawTestState>[0] = { scenario: "minimal" },
) {
  return it.extend<{ state: OpenClawTestState; store: ReturnType<typeof entryFixture> }>({
    state: async ({ task: _task }, use) => withOpenClawTestState(options, use),
    store: async ({ state }, use) => use(entryFixture(state.env)),
  });
}
export const test = sessionTests();
