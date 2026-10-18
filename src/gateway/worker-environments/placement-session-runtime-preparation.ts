import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewaySessionStoreTargetWithStore } from "../session-utils-store.types.js";
import {
  readWorkerPlacementModelSource,
  resolveWorkerPlacementSessionRuntime,
  resolveWorkerPlacementSessionRuntimeAsync,
} from "./placement-session-runtime.js";

/** Prepare inherited model facts; execution and credentials retain their own live authority. */
export async function prepareWorkerPlacementSessionRuntime(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
  initialTarget?: GatewaySessionStoreTargetWithStore;
}) {
  const parents = new Map<string, () => SessionEntry | undefined>();
  await resolveWorkerPlacementSessionRuntimeAsync({
    ...params,
    readSourceEntry: async (key) => {
      const metadata = captureSessionEntryMetadataRead(
        { sessionKey: key, agentId: params.agentId },
        () => {},
      );
      if (metadata) {
        parents.set(key, () => metadata.readCurrent());
        return metadata.readCurrent();
      }
      // A parent model or store-routing change during placement applies on the next preparation.
      const entry = await readWorkerPlacementModelSource(params, key);
      parents.set(key, () => entry);
      return entry;
    },
  });
  return (currentCfg: OpenClawConfig, currentEntry: SessionEntry): string =>
    resolveWorkerPlacementSessionRuntime({
      cfg: currentCfg,
      entry: currentEntry,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      readSourceEntry: (key) => {
        const read = parents.get(key);
        if (!read) {
          throw new Error("Session model inheritance changed during worker placement; retry.");
        }
        return read();
      },
    });
}
