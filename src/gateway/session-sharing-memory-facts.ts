import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureSessionSharingMemoryFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-incognito.js";
import type { SessionFactsRequest } from "./session-sharing-target.types.js";

export function prepareMemorySessionMutationFacts(
  params: {
    cfg: OpenClawConfig;
    agentId: string;
    canonicalKey: string;
    allowMissing?: true;
    storageReady?: SessionFactsRequest["storageReady"];
  },
  assertRoutingCurrent: (cfg: OpenClawConfig) => void,
) {
  const { agentId, canonicalKey } = params;
  let memoryActive = true;
  const memory = captureSessionSharingMemoryFacts(
    {
      agentId,
      sessionKey: canonicalKey,
      resolved: { storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId }) },
    },
    () => {
      if (!memoryActive) {
        throw new SessionMutationFactsUnavailableError();
      }
    },
    Boolean(params.allowMissing),
  );
  if (!memory) {
    return undefined;
  }
  const read = {
    storageTarget: { agentId, canonicalKey, storePath: memory.location.path },
    // The actor installs creation and its sharing facts together before acknowledgement.
    bindCreation() {},
    prepareRead() {
      return undefined;
    },
    readCurrent(cfg: OpenClawConfig) {
      assertRoutingCurrent(cfg);
      return memory.readCurrent();
    },
    release() {
      memoryActive = false;
    },
  };
  const prepare = async () => {
    if (params.storageReady) {
      const ready = params.storageReady;
      const prepared = await ("ready" in ready ? ready.ready : ready);
      prepared?.assertCurrent();
    }
    read.readCurrent(params.cfg);
    return read;
  };
  return prepare();
}
