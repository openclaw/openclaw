// Keep the deprecated synchronous SDK loader outside the worker topology import graph.
import { createGatewaySessionLineageReader } from "../../gateway/session-utils-store-lineage.native.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  mergeCombinedSessionStore,
  prepareCombinedSessionStore,
  type GatewayCombinedSessionStore,
} from "./combined-store-gateway.js";
import type { GatewaySessionStoreOptions } from "./combined-store.types.js";
import { listSessionEntriesReadOnly } from "./session-accessor.sqlite-entry-list.read.js";

export function loadCombinedSessionStoreForGatewayCore(
  cfg: OpenClawConfig,
  opts: GatewaySessionStoreOptions = {},
): GatewayCombinedSessionStore {
  const prepared = prepareCombinedSessionStore(cfg, opts);
  return mergeCombinedSessionStore(
    cfg,
    opts,
    prepared,
    (target) =>
      opts.loadEntries
        ? opts.loadEntries(target, prepared.projection)
        : listSessionEntriesReadOnly({ ...target, clone: false, projection: prepared.projection }),
    createGatewaySessionLineageReader(cfg),
  );
}
