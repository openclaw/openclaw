import path from "node:path";
import {
  deleteSessionEntryLifecycle,
  listSessionEntriesCore,
} from "../../config/sessions/session-accessor.js";
import { disposeSessionReadContexts } from "../session-read-contexts.test-support.js";

/** Callers settle their readers and writers before clearing an admitted fixture store. */
export async function deletePersistentSessionStoreRows({
  agentId,
  storePath,
}: {
  agentId: string;
  storePath: string;
}): Promise<void> {
  for (const { sessionKey } of listSessionEntriesCore({ agentId, storePath })) {
    await deleteSessionEntryLifecycle({
      agentId,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
      deleteDeliveryArtifacts: true,
    });
  }
}

/** Reset case-owned rows while retaining the suite Gateway's admitted store and workers. */
export async function resetPersistentGatewaySessionStore(dir: string): Promise<void> {
  // Handler fixtures use only row deletion and must not install the Gateway's mocks.
  const { settleGatewaySessionStoreFixture } =
    await import("./server-sessions-resources.test-helpers.js");
  const { projection } = await settleGatewaySessionStoreFixture(dir);
  if (!projection) {
    throw new Error("Persistent session fixture requires its suite Gateway projection");
  }
  await disposeSessionReadContexts();
  const storePath = path.join(dir, "sessions.json");
  await deletePersistentSessionStoreRows({ agentId: "main", storePath });
  await settleGatewaySessionStoreFixture(dir);
}
