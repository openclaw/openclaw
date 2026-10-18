import type { SessionDeleteTarget } from "../../lib/sessions/session-capability.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";

export { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";

export function deleteStoredChatSessionSnapshots(
  host: Parameters<typeof resolveChatSnapshotKey>[0],
  sessions: readonly Pick<SessionDeleteTarget, "agentId" | "key">[],
): Promise<void> {
  const keys = sessions.map(({ key, agentId }) =>
    resolveChatSnapshotKey(host, { sessionKey: key, agentId }),
  );
  return import("./session-snapshot-invalidation.ts").then(({ deleteStoredChatSnapshot }) =>
    Promise.all(keys.map((key) => deleteStoredChatSnapshot(key))).then(() => undefined),
  );
}
