import type { SessionEntryReadScope } from "../config/sessions/session-accessor.types.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { attachSessionEntrySnapshots } from "../config/sessions/session-entry-snapshot-values.js";
import type { GatewaySessionStorePlan } from "./session-utils-store-selection.js";
import type { GatewaySessionStoreTargetWithStore } from "./session-utils-store.types.js";

export function prepareIncognitoGatewaySessionStoreTarget(params: {
  agentId: string;
  canonicalKey: string;
  env?: NodeJS.ProcessEnv;
  projection?: SessionEntryReadScope["projection"];
}): GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore> {
  const { agentId, canonicalKey } = params;
  const captured = captureSessionActorStorageOwner(
    { agentId, sessionKey: canonicalKey, env: params.env },
    { assertCurrent() {}, authorize() {} },
  );
  if (!captured) {
    throw new Error("Incognito session lookup requires a memory target");
  }
  return {
    reads: [],
    resolve() {
      const hot = captured.owner?.readSession(canonicalKey, captured.authority);
      const entry = hot?.entry && attachSessionEntrySnapshots(hot.entry, {}, params.projection);
      return {
        agentId,
        canonicalKey,
        storePath: captured.path,
        storeKeys: [canonicalKey],
        store: entry ? { [canonicalKey]: entry } : {},
        readSource: { agentId, path: captured.path },
      };
    },
  };
}
