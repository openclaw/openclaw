import { DEFAULT_GATEWAY_PORT } from "../config/paths.js";
import { loadNodeHostConfig } from "../node-host/config.js";

type NodeOnlyServiceLike = {
  installed: boolean | null;
  loaded?: boolean | null;
  externallyManaged?: boolean;
  runtime?:
    | {
        status?: string;
        pid?: number;
      }
    | undefined;
  runtimeShort?: string | null;
};

export type NodeOnlyGatewayInfo = {
  gatewayTarget: string;
  gatewayValue: string;
  connectionDetails: string;
};

function resolveNodeGatewayTarget(gateway?: { host?: string; port?: number }): string {
  return gateway?.host
    ? `${gateway.host}:${gateway.port ?? DEFAULT_GATEWAY_PORT}`
    : "(gateway address unknown)";
}

function hasRunningRuntime(
  runtime:
    | {
        status?: string;
        pid?: number;
      }
    | undefined,
): boolean {
  return runtime?.status === "running" || typeof runtime?.pid === "number";
}

function isNodeServiceActive(node: NodeOnlyServiceLike): boolean {
  if (node.installed !== true) {
    return false;
  }
  if (node.externallyManaged === true) {
    return true;
  }
  // Node host may be managed by launchd/systemd, a foreground process, or an
  // externally reported runtime string depending on install mode.
  if (node.loaded === true) {
    return true;
  }
  if (hasRunningRuntime(node.runtime)) {
    return true;
  }
  return typeof node.runtimeShort === "string" && node.runtimeShort.startsWith("running");
}

/** Reports remote gateway details when this machine intentionally runs only the node host. */
export async function resolveNodeOnlyGatewayInfo(params: {
  daemon: Pick<NodeOnlyServiceLike, "installed">;
  node: NodeOnlyServiceLike;
}): Promise<NodeOnlyGatewayInfo | null> {
  if (params.daemon.installed !== false || !isNodeServiceActive(params.node)) {
    return null;
  }

  // Node-only hosts intentionally delegate gateway traffic to a remote target;
  // status should not report the absent local gateway as a local failure.
  const gatewayTarget = resolveNodeGatewayTarget((await loadNodeHostConfig())?.gateway);
  return {
    gatewayTarget,
    gatewayValue: `node → ${gatewayTarget} · no local gateway`,
    connectionDetails: [
      "Node-only mode detected",
      "Local gateway: not expected on this machine",
      `Remote gateway target: ${gatewayTarget}`,
      "Inspect the remote gateway host for live channel and health details.",
    ].join("\n"),
  };
}
