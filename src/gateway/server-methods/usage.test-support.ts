import type { SessionEntry } from "../../config/sessions/types.js";
import type { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";

export type UsageSessionStoreFixture = Pick<
  Parameters<typeof createSessionRowProjectionFixture>[0],
  "store" | "targetsBySessionKey"
>;

export function createUsageSessionStoreFixture(
  store: Record<string, SessionEntry>,
  owners: ReadonlyArray<readonly [string, string]>,
  storePathForAgent = (agentId: string) => `/tmp/agents/${agentId}/agent/openclaw-agent.sqlite`,
): UsageSessionStoreFixture {
  return {
    store,
    targetsBySessionKey: new Map(
      owners.map(([key, agentId]) => [
        key,
        {
          agentId,
          entry: store[key],
          readSourceEntry: (sourceKey: string) => store[sourceKey],
          resolveSourceKey: (sourceKey: string) => sourceKey,
          storeTarget: { agentId, storePath: storePathForAgent(agentId) },
        },
      ]),
    ),
  };
}
