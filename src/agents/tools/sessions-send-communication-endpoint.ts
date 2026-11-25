import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../../config/sessions/session-actor-storage-binding.js";
import { listSessionTranscriptInstancesInWorker } from "../../config/sessions/session-history.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import type { CommunicationEndpoint } from "../../sessions/communication-admission.js";

/** Read parent identity continuity through the same captured endpoint owner. */
export async function readSessionCommunicationLineage(
  endpoint: CommunicationEndpoint,
  read: (endpoint: CommunicationEndpoint) => Promise<CommunicationEndpoint>,
  assertCurrent: () => void,
): Promise<CommunicationEndpoint[]> {
  const chain = [endpoint];
  while (chain.at(-1)?.entry?.spawnedBy) {
    const child = chain.at(-1)!;
    const key = child.entry!.spawnedBy!;
    if (chain.length >= 32 || chain.some((entry) => entry.sessionKey === key)) {
      throw new Error("Session communication ancestry is invalid.");
    }
    const parent = await read({
      agentId: parseAgentSessionKey(key)?.agentId ?? child.agentId,
      sessionKey: key,
      storePath: "",
      entry: undefined,
    });
    if (
      !(await matchesSessionCommunicationParent(
        parent,
        child.entry?.parentSessionId,
        assertCurrent,
      ))
    ) {
      throw new Error("The child's parent session lineage changed; re-spawn the child.");
    }
    chain.push(parent);
  }
  return chain;
}

async function matchesSessionCommunicationParent(
  parent: CommunicationEndpoint,
  expectedId: string | undefined,
  assertCurrent: () => void,
): Promise<boolean> {
  if (!parent.entry) {
    return false;
  }
  if (!expectedId || expectedId === parent.entry.sessionId) {
    return true;
  }
  if (isIncognitoSessionKey(parent.sessionKey)) {
    return false;
  }
  let sessionId: string | undefined = parent.entry.sessionId;
  // Historical windows record same-key continuity; never follow a window owned by another key.
  for (let depth = 0; sessionId && depth < 32; depth++) {
    const [window] = await listSessionTranscriptInstancesInWorker(
      { agentId: parent.agentId, storePath: parent.storePath, projection: "list" },
      { sessionId, includeAllWindows: true },
    );
    assertCurrent();
    if (window?.sessionKey !== parent.sessionKey) {
      return false;
    }
    if (sessionId === expectedId) {
      return true;
    }
    sessionId = window.entry.previousSessionId;
  }
  return false;
}

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
