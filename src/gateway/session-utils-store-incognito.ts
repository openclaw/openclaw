import path from "node:path";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { attachSessionEntrySnapshots } from "../config/sessions/session-entry-snapshot-values.js";
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
  const memory = getSessionActorStorageBinding({});
  if (!memory) {
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
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({
    agentId,
    env: params.env ?? { OPENCLAW_STATE_DIR: path.resolve(memory.path, "../../../..") },
  });
  const sameOwner = agentId === memory.agentId && storePath === memory.path;
  return {
    reads: [],
    resolve() {
      memory.actor.assertReadable();
      const current = sameOwner
        ? memory.actor.storage.readCurrent(
            { type: "session.entry.read", input: { sessionKey: canonicalKey } },
            memory.authority,
          )
        : undefined;
      const entry = current && attachSessionEntrySnapshots(current, {}, params.projection);
      return {
        agentId,
        canonicalKey,
        storePath,
        storeKeys: [canonicalKey],
        store: entry ? { [canonicalKey]: entry } : {},
        readSource: { agentId, path: storePath },
      };
    },
  };
}
