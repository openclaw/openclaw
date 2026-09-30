import type { SessionDeleteTarget } from "../../lib/sessions/session-capability.ts";
import { publishSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";

const loadSnapshotInvalidation = () => import("./session-snapshot-invalidation.ts");

export function clearStoredChatSnapshots(): Promise<void> {
  const invalidated = publishSnapshotInvalidation({});
  return loadSnapshotInvalidation().then(async ({ clearStoredChatSnapshotStorage }) => {
    await invalidated;
    await clearStoredChatSnapshotStorage();
  });
}

export function deleteStoredChatSessionSnapshots(
  host: Parameters<typeof resolveChatSnapshotKey>[0],
  sessions: readonly Pick<SessionDeleteTarget, "agentId" | "key">[],
): Promise<void> {
  return loadSnapshotInvalidation().then(({ deleteStoredChatSnapshot }) =>
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
