import path from "node:path";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveStateDir } from "../state-dir.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";

export function matchSessionEntryCohortScope(
  reader: SessionEntryCohortReader,
  input: SessionAccessScope,
) {
  reader.assertCurrent();
  const key = resolveSqliteSessionKey(input.sessionKey, reader.logicalAgentId);
  if (
    key !== reader.sessionKey ||
    (input.agentId && normalizeAgentId(input.agentId) !== reader.logicalAgentId) ||
    (input.storePath && !reader.storePaths.includes(path.resolve(input.storePath))) ||
    (input.env && resolveStateDir(input.env) !== resolveStateDir(reader.database.env))
  ) {
    return undefined;
  }
  return key;
}

export function assertSessionEntryCohortScope(
  reader: SessionEntryCohortReader,
  input: SessionAccessScope,
) {
  const key = matchSessionEntryCohortScope(reader, input);
  if (key === undefined) {
    throw new Error("Session read differs from its original admitted target");
  }
  return key;
}
