import { captureMemoryExactSessionReader } from "../config/sessions/session-accessor.memory-exact-read.js";
import type { SessionEntryReadScope } from "../config/sessions/session-accessor.types.js";
import type { GatewaySessionStorePlan } from "./session-utils-store-selection.js";
import type { GatewaySessionStoreTargetWithStore } from "./session-utils-store.types.js";

export function prepareIncognitoGatewaySessionStoreTarget(params: {
  agentId: string;
  canonicalKey: string;
  env?: NodeJS.ProcessEnv;
  projection?: SessionEntryReadScope["projection"];
}): GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore> {
  const { agentId, canonicalKey } = params;
  const memory = captureMemoryExactSessionReader({
    agentId,
    sessionKey: canonicalKey,
    env: params.env,
  });
  if (!memory) {
    throw new Error("Incognito session lookup requires a memory target");
  }
  return {
    reads: [],
    resolve() {
      const entry = memory.read(canonicalKey, params.projection);
      return {
        agentId,
        canonicalKey,
        storePath: memory.path,
        storeKeys: [canonicalKey],
        store: entry ? { [canonicalKey]: entry } : {},
        readSource: { agentId, path: memory.path },
        ...(memory.source ? { capturedReadSource: memory.source } : {}),
        capturedReadSources: memory.source ? [memory.source] : [],
      };
    },
  };
}
