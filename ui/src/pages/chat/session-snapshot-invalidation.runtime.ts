import type { SessionDeleteTarget } from "../../lib/sessions/session-capability.ts";
import { publishSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";

export function clearStoredChatSnapshots(): Promise<void> {
  const invalidated = publishSnapshotInvalidation({});
  return import("./session-snapshot-database.ts").then(async ({ resetSessionSnapshotDatabase }) => {
    await invalidated;
    await resetSessionSnapshotDatabase();
  });
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
