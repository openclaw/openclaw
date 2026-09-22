import { parseAgentSessionKey } from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { SessionBackingFacts, SessionBackingFactsScope } from "./session-backing-facts.js";
import { readSessionEntriesFromStoreInWorker } from "./session-entry-read-runtime.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

/** A publication during a batch makes its prepared backing evidence unknown. */
export async function readSessionBackingFactsInWorker(
  scopes: readonly SessionBackingFactsScope[],
): Promise<Array<SessionBackingFacts | undefined>> {
  const changedKeys = new Set<string>();
  let allChanged = false;
  const stop = sessionChanges.subscribe((change) => {
    if ("all" in change) {
      allChanged = true;
    } else {
      changedKeys.add(change.sessionKey);
    }
  });
  try {
    const results = await Promise.all(
      scopes.map(async (scope) => {
        const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(scope.storePath);
        const agentId = target.agentId ?? parseAgentSessionKey(scope.sessionKeys[0] ?? "")?.agentId;
        if (!agentId) {
          throw new Error("Cannot resolve backing session facts without an agent id");
        }
        const result = await readSessionEntriesFromStoreInWorker({
          ...scope,
          agentId,
          projection: "backing",
        });
        return result.entries;
      }),
    );
    return results.map((result, index) =>
      allChanged || scopes[index]!.sessionKeys.some((key) => changedKeys.has(key))
        ? undefined
        : result,
    );
  } finally {
    stop();
  }
}
