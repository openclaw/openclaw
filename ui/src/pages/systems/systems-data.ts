import type {
  EnvironmentSummary,
  EnvironmentsListResult,
  SystemInfoResult,
} from "@openclaw/gateway-protocol";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
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

/** The page owner schedules and publishes this canonical membership read. */
export async function loadSystemsInventory(
  gateway: ApplicationGateway,
  options: { signal?: AbortSignal },
): Promise<SystemsInventory | undefined> {
  const client = gateway.snapshot.client;
  if (!client) {
    return undefined;
  }
  // Only this list owns membership. Optional measurements load independently in the page owner.
  const inventory = await client.request<EnvironmentsListResult>(
    "environments.list",
    { includeDesktopSetup: true },
    { signal: options.signal },
  );
  return {
    environments: inventory.environments,
    nodes: [],
    gatewaySystemInfo: null,
    gatewaySampledAtMs: null,
    errors: {},
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
    const existing = relations.get(id) ?? [];
    existing.push({ kind, session });
    relations.set(id, existing);
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
    .map((environment) => ({
      environment,
      node: environment.type === "node" ? nodes.get(environment.id) : undefined,
      gatewaySystemInfo:
        environment.id === "gateway" ? (inventory.gatewaySystemInfo ?? undefined) : undefined,
      sessions: relations.get(environment.id) ?? [],
    }));
}
