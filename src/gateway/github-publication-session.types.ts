import type { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

export type PublicationSessionIdentity = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision?: string | null;
};
export type PublicationSessionRead = Pick<
  Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>,
  "agentId" | "canonicalKey" | "storePath" | "entry"
>;
