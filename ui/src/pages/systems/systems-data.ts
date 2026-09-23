import type {
  EnvironmentSummary,
  EnvironmentsListResult,
  SystemInfoResult,
} from "@openclaw/gateway-protocol";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { readSystemInfo } from "../../lib/system-info.ts";

export type SystemsInventory = {
  environments: EnvironmentSummary[];
  nodes: NodeListNode[];
  gatewaySystemInfo: SystemInfoResult | null;
  gatewaySampledAtMs: number | null;
  errors: { nodes?: string; systemInfo?: string };
};

type SystemsSessionRelation = {
  // These are recorded bindings, not proof that a model turn ran on the host.
  kind: "placement" | "retained-placement" | "runner" | "exec-binding" | "gateway";
  session: GatewaySessionRow;
};

export type SystemsInventoryRow = {
  environment: EnvironmentSummary;
  node?: NodeListNode;
  gatewaySystemInfo?: SystemInfoResult;
  sessions: SystemsSessionRelation[];
};

/** The route owns connection epochs, refresh scheduling and publication of this snapshot. */
export async function loadSystemsInventory(
  gateway: ApplicationGateway,
  options: { isCurrent: () => boolean; signal?: AbortSignal },
): Promise<SystemsInventory | undefined> {
  const client = gateway.snapshot.client;
  if (!client || !options.isCurrent() || options.signal?.aborted) {
    return undefined;
  }
  const requestOptions = { signal: options.signal };
  const [inventory, nodes, systemInfo] = await Promise.allSettled([
    client.request<EnvironmentsListResult>(
      "environments.list",
      { includeDesktopSetup: true },
      requestOptions,
    ),
    client.request<{ nodes: NodeListNode[] }>("node.list", {}, requestOptions),
    readSystemInfo(gateway, options.signal),
  ]);
  if (!options.isCurrent() || options.signal?.aborted) {
    return undefined;
  }
  if (
    systemInfo.status === "rejected" &&
    systemInfo.reason instanceof DOMException &&
    systemInfo.reason.name === "AbortError"
  ) {
    return undefined;
  }
  // Never rebuild inventory from auxiliary node reads: that would resurrect cloud-owned
  // pairings deliberately suppressed by environments.list and hide inventory failures.
  if (inventory.status === "rejected") {
    throw inventory.reason;
  }
  return {
    environments: inventory.value.environments,
    nodes: nodes.status === "fulfilled" ? nodes.value.nodes : [],
    gatewaySystemInfo: systemInfo.status === "fulfilled" ? systemInfo.value.value : null,
    gatewaySampledAtMs: systemInfo.status === "fulfilled" ? systemInfo.value.at : null,
    errors: {
      ...(nodes.status === "rejected" ? { nodes: formatUiError(nodes.reason) } : {}),
      ...(systemInfo.status === "rejected" ? { systemInfo: formatUiError(systemInfo.reason) } : {}),
    },
  };
}

/** Join only exact Gateway identities; desktop capability never determines row membership. */
export function projectSystemsInventory(
  inventory: SystemsInventory,
  sessions: readonly GatewaySessionRow[],
): SystemsInventoryRow[] {
  const nodes = new Map(inventory.nodes.map((node) => [`node:${node.nodeId}`, node]));
  const relations = new Map<string, SystemsSessionRelation[]>();
  const add = (id: string, kind: SystemsSessionRelation["kind"], session: GatewaySessionRow) => {
    const existing = relations.get(id);
    const relation = { kind, session };
    if (existing) {
      existing.push(relation);
    } else {
      relations.set(id, [relation]);
    }
  };
  for (const session of sessions) {
    const placement = session.placement;
    if (placement && placement.state !== "local") {
      if (placement.state === "requested") {
        continue;
      }
      if (placement.environmentId) {
        add(
          placement.environmentId,
          placement.state === "reclaimed" || placement.state === "failed"
            ? "retained-placement"
            : "placement",
          session,
        );
      }
      if (placement.state === "active" && placement.runner?.deviceId) {
        add(`node:${placement.runner.deviceId}`, "runner", session);
      }
      continue;
    }
    const execNode = session.execNode?.trim();
    add(execNode ? `node:${execNode}` : "gateway", execNode ? "exec-binding" : "gateway", session);
  }
  return inventory.environments
    .filter((environment) => {
      // Terminal worker records remain in Gateway history after their machine is gone.
      return (
        environment.type !== "worker" ||
        (environment.worker?.state !== "destroyed" && environment.worker?.state !== "failed")
      );
    })
    .map((environment) => {
      return {
        environment,
        node: environment.type === "node" ? nodes.get(environment.id) : undefined,
        gatewaySystemInfo:
          environment.id === "gateway" ? (inventory.gatewaySystemInfo ?? undefined) : undefined,
        sessions: relations.get(environment.id) ?? [],
      };
    });
}
