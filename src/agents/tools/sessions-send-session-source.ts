import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import type { GatewaySessionStoreTargetWithStore } from "../../gateway/session-utils-store.types.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { withSubagentSessionSource } from "../subagents/spawn/subagent-session-source.js";
import type { SessionsSendToolOptions } from "./sessions-send-tool.types.js";

export function withSessionsSendRequesterSource<T>(
  opts: SessionsSendToolOptions | undefined,
  consume: () => Promise<T>,
): Promise<T> {
  return opts?.agentSessionKey && isIncognitoSessionKey(opts.agentSessionKey)
    ? withSubagentSessionSource(
        {
          agentId: opts.agentId ?? resolveAgentIdFromSessionKey(opts.agentSessionKey),
          sessionKey: opts.agentSessionKey,
        },
        consume,
      )
    : consume();
}

/** Incognito requesters read the selected memory owner; durable targets use the worker. */
export function createSessionsSendSessionReaders(cfg: OpenClawConfig) {
  const readTarget = (key: string, agentId: string) =>
    resolveGatewaySessionStoreTargetInWorker({
      cfg,
      key,
      agentId,
      projection: "full",
    });
  return {
    readTarget,
    readRequester: async (
      sessionKey: string,
      agentId: string,
    ): Promise<GatewaySessionStoreTargetWithStore | undefined> => {
      const source = captureSessionActorStorageOwner(
        { agentId, sessionKey },
        { assertCurrent() {}, authorize() {} },
      );
      if (!source) {
        return readTarget(sessionKey, agentId);
      }
      const entry = readCapturedSessionActorEntry(source, sessionKey);
      if (!entry) {
        return undefined;
      }
      return {
        agentId,
        canonicalKey: sessionKey,
        storeKeys: [sessionKey],
        storePath: source.path,
        store: { [sessionKey]: entry },
      };
    },
  };
}
