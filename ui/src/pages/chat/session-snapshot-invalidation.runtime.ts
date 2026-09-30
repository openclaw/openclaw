import type { SessionDeleteTarget } from "../../lib/sessions/session-capability.ts";
import { resetSessionSnapshotDatabase } from "./session-snapshot-database.ts";
import { publishSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";

export async function clearStoredChatSnapshots(): Promise<void> {
  const invalidated = publishSnapshotInvalidation({});
  await invalidated;
  await resetSessionSnapshotDatabase();
}

export function deleteStoredChatSessionSnapshots(
  host: Parameters<typeof resolveChatSnapshotKey>[0],
  sessions: readonly Pick<SessionDeleteTarget, "agentId" | "key">[],
): Promise<void> {
  return import("./session-snapshot-invalidation.ts").then(({ deleteStoredChatSnapshot }) =>
    Promise.all(
      sessions.map(({ key, agentId }) =>
        deleteStoredChatSnapshot(
          resolveChatSnapshotKey(
            { ...host, assistantAgentId: agentId ?? host.assistantAgentId },
            { sessionKey: key, agentId },
          ),
        ),
      ),
    ).then(() => undefined),
  );
}
