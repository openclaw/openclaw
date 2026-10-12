import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureSessionActorMutationFacts,
  captureSessionSharingActorBinding,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-incognito.js";

export function prepareMemorySessionMutationFacts(
  params: {
    cfg: OpenClawConfig;
    agentId: string;
    canonicalKey: string;
    allowMissing?: true;
    storageReady?: Promise<void>;
  },
  assertRoutingCurrent: (cfg: OpenClawConfig) => void,
) {
  const { agentId, canonicalKey } = params;
  const binding = captureSessionSharingActorBinding({
    agentId,
    sessionKey: canonicalKey,
    resolved: null,
  });
  if (!binding) {
    return undefined;
  }
  const memory = captureSessionActorMutationFacts(
    binding,
    canonicalKey,
    Boolean(params.allowMissing),
    params.cfg.session?.store && resolveSessionStorePathCore(params.cfg.session.store, { agentId }),
  );
  let active = true;
  const read = {
    storageTarget: { agentId, canonicalKey, storePath: memory.location.path },
    // The actor installs creation and its sharing facts together before acknowledgement.
    bindCreation() {},
    readCurrent(cfg: OpenClawConfig) {
      if (!active) {
        throw new SessionMutationFactsUnavailableError();
      }
      assertRoutingCurrent(cfg);
      return memory.readCurrent();
    },
    release() {
      active = false;
    },
  };
  const prepare = async () => {
    if (params.storageReady) {
      await params.storageReady;
    }
    read.readCurrent(params.cfg);
    return read;
  };
  return prepare();
}
