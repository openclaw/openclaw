import { projectNodePairing } from "../infra/device-pairing-node.records.js";
import type { DevicePairingNodeSnapshot } from "../infra/device-pairing-read.types.js";
import { readDevicePairingNodeSnapshot } from "../infra/device-pairing-store-readonly.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import { createKnownNodeCatalog, listKnownNodes } from "./node-catalog.js";
import {
  collectNodeCatalogRuntimeState,
  readNodeCatalogRevision,
} from "./node-registry-private.js";
import type { NodeRegistry, NodeSession } from "./node-registry.js";

type CatalogView = "nodes" | "environments" | "worker-environments";
type PreparedNodeCatalog = {
  nodes: readonly NodeListNode[];
  connectedNodes: readonly NodeSession[];
};
const preparedCatalogs = new WeakMap<
  NodeRegistry,
  {
    pairing: DevicePairingNodeSnapshot;
    revision: number;
    connectedNodes: NodeSession[];
    views: Map<CatalogView, PreparedNodeCatalog>;
  }
>();

/** Pairing publications and registry mutations own the lifetime of these read-only projections. */
export async function readKnownNodeCatalog(
  registry: NodeRegistry,
  view: CatalogView = "nodes",
): Promise<PreparedNodeCatalog> {
  const pairing = await readDevicePairingNodeSnapshot();
  const revision = readNodeCatalogRevision(registry);
  let prepared = preparedCatalogs.get(registry);
  if (
    !prepared ||
    prepared.pairing !== pairing ||
    prepared.revision !== revision ||
    // Connection policy can revoke a client before the transport unregisters it.
    prepared.connectedNodes.some((node) => node.client.invalidated === true)
  ) {
    prepared = {
      pairing,
      revision,
      connectedNodes: registry.listConnectedForPairingStates(pairing.bindings),
      views: new Map(),
    };
    preparedCatalogs.set(registry, prepared);
  }
  let result = prepared.views.get(view);
  if (!result) {
    const nodePairing = projectNodePairing(pairing.paired);
    const catalog = createKnownNodeCatalog({
      pairedDevices: pairing.paired,
      pairedNodes: nodePairing.paired,
      // Environment discovery never exposes pending-only node metadata.
      pendingNodes: view === "nodes" ? nodePairing.pending : undefined,
      connectedNodes: prepared.connectedNodes,
      ...collectNodeCatalogRuntimeState(
        registry,
        prepared.connectedNodes,
        view === "worker-environments",
      ),
    });
    result = Object.freeze({
      nodes: freezeJsonSnapshot(structuredClone(listKnownNodes(catalog))),
      connectedNodes: Object.freeze(prepared.connectedNodes),
    });
    prepared.views.set(view, result);
  }
  return result;
}
