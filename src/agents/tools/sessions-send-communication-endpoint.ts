import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import type { CommunicationEndpoint } from "../../sessions/communication-admission.js";

/** Read through the selected storage owner, including private in-memory sessions. */
export async function readSessionCommunicationEndpoint(params: {
  config: OpenClawConfig;
  endpoint: Pick<CommunicationEndpoint, "agentId" | "sessionKey" | "storePath">;
  assertCurrent: () => void;
}): Promise<CommunicationEndpoint> {
  const source = captureSessionActorStorageOwner(params.endpoint, {
    assertCurrent: params.assertCurrent,
    authorize() {},
  });
  if (source) {
    return {
      agentId: source.agentId,
      sessionKey: params.endpoint.sessionKey,
      storePath: source.path,
      entry: readCapturedSessionActorEntry(source, params.endpoint.sessionKey),
    };
  }
  const loaded = await resolveGatewaySessionStoreTargetInWorker({
    cfg: params.config,
    key: params.endpoint.sessionKey,
    agentId: params.endpoint.agentId,
    assertActive: params.assertCurrent,
    projection: "full",
  });
  return {
    agentId: loaded.agentId,
    sessionKey: loaded.canonicalKey,
    storePath: loaded.readSource?.path ?? loaded.storePath,
    entry: loaded.store[loaded.canonicalKey],
  };
}
