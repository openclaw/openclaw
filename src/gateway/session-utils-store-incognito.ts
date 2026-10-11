import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import {
  gatewaySessionStoreReadOptions,
  readGatewaySessionStore,
  type GatewaySessionStoreRead,
} from "./session-utils-store-read.js";
import type { GatewaySessionStorePlan } from "./session-utils-store-selection.js";
import type { GatewaySessionStoreTargetWithStore } from "./session-utils-store.types.js";

export function prepareIncognitoGatewaySessionStoreTarget(
  params: Parameters<typeof gatewaySessionStoreReadOptions>[0] & {
    agentId: string;
    canonicalKey: string;
    clone?: boolean;
    readStore?: typeof readGatewaySessionStore;
  },
): GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore> {
  const { agentId, canonicalKey } = params;
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: params.env });
  const read: GatewaySessionStoreRead = {
    storePath,
    agentId,
    clone: params.clone,
    // Arbitrary stale keys must not materialize process-lifetime incognito state.
    options: gatewaySessionStoreReadOptions(params, [canonicalKey], true),
  };
  return {
    reads: [read],
    resolve: () => ({
      agentId,
      storePath,
      canonicalKey,
      storeKeys: [canonicalKey],
      store: (params.readStore ?? readGatewaySessionStore)(read),
      ...(read.readSource ? { readSource: read.readSource } : {}),
      ...(read.capturedReadSource
        ? {
            capturedReadSource: read.capturedReadSource,
            capturedReadSources: [read.capturedReadSource],
          }
        : {}),
    }),
  };
}
