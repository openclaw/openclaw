// Octopus Orchestrator — `openclaw octo node list/show` CLI commands (M4-08)
//
// Displays node information from an in-memory NodeRegistryView (not SQLite).
// Nodes are tracked by the Head via connect/disconnect events.
//
// Architecture:
//   gatherNodeList / gatherNodeShow — query the registry, return structured data
//   formatNodeList / formatNodeShow — render human-readable output
//   formatNodeListJson / formatNodeShowJson — render JSON
//   runNodeList / runNodeShow — compose gather + format, write to output, return exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface NodeSummary {
  nodeId: string;
  capabilities: string[];
  activeArms: number;
  connected: boolean;
}

export interface NodeDetail extends NodeSummary {
  maxArms: number;
  lastTelemetryTs: number;
  leaseCount: number;
}

export interface NodeRegistryView {
  listNodes(): NodeSummary[];
  getNode(nodeId: string): NodeDetail | null;
}

export interface NodeListOptions {
  json?: boolean;
}

export interface NodeShowOptions {
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Gather — pure data extraction
// ──────────────────────────────────────────────────────────────────────────

/** Gathers the list of connected nodes. */
export function gatherNodeList(registry: NodeRegistryView): NodeSummary[] {
  return registry.listNodes();
}

/** Gathers detail for a single node. Returns null if not found. */
export function gatherNodeShow(registry: NodeRegistryView, nodeId: string): NodeDetail | null {
  return registry.getNode(nodeId);
}

// ──────────────────────────────────────────────────────────────────────────
// Format — human-readable
// ──────────────────────────────────────────────────────────────────────────

/** Formats the node list for human display. */
export function formatNodeList(nodes: NodeSummary[]): string {
  const lines: string[] = [];

  lines.push("Nodes");
  lines.push("=====");
  lines.push("");

  if (nodes.length === 0) {
    lines.push("No connected nodes.");
    lines.push("");
    return lines.join("\n");
  }

  for (const node of nodes) {
    const status = node.connected ? "connected" : "disconnected";
    const caps = node.capabilities.length > 0 ? node.capabilities.join(", ") : "none";
    lines.push(`${node.nodeId}  ${status}  arms=${node.activeArms}  capabilities=[${caps}]`);
  }

  lines.push("");
  return lines.join("\n");
}

/** Formats a single node detail for human display. */
export function formatNodeShow(detail: NodeDetail): string {
  const lines: string[] = [];

  lines.push(`Node: ${detail.nodeId}`);
  lines.push("=".repeat(`Node: ${detail.nodeId}`.length));
  lines.push("");

  const status = detail.connected ? "connected" : "disconnected";
  lines.push(`Status:          ${status}`);
  lines.push(`Active arms:     ${detail.activeArms}`);
  lines.push(`Max arms:        ${detail.maxArms}`);
  lines.push(`Lease count:     ${detail.leaseCount}`);
  lines.push(
    `Last telemetry:  ${detail.lastTelemetryTs > 0 ? new Date(detail.lastTelemetryTs).toISOString() : "never"}`,
  );

  const caps = detail.capabilities.length > 0 ? detail.capabilities.join(", ") : "none";
  lines.push(`Capabilities:    ${caps}`);
  lines.push("");

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Format — JSON
// ──────────────────────────────────────────────────────────────────────────

/** Formats the node list as JSON. */
export function formatNodeListJson(nodes: NodeSummary[]): string {
  return JSON.stringify(nodes, null, 2) + "\n";
}

/** Formats node detail as JSON. */
export function formatNodeShowJson(detail: NodeDetail): string {
  return JSON.stringify(detail, null, 2) + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Entry points
// ──────────────────────────────────────────────────────────────────────────

/** Entry point for `openclaw octo node list`. Returns exit code 0. */
export function runNodeList(
  registry: NodeRegistryView,
  opts: NodeListOptions,
  out: { write: (s: string) => void } = process.stdout,
): number {
  const nodes = gatherNodeList(registry);
  const output = opts.json ? formatNodeListJson(nodes) : formatNodeList(nodes);
  out.write(output);
  return 0;
}

/** Entry point for `openclaw octo node show <id>`. Returns 0 on success, 1 if not found. */
export function runNodeShow(
  registry: NodeRegistryView,
  nodeId: string,
  opts: NodeShowOptions,
  out: { write: (s: string) => void } = process.stdout,
  err: { write: (s: string) => void } = process.stderr,
): number {
  const detail = gatherNodeShow(registry, nodeId);
  if (detail === null) {
    err.write(`Error: unknown node "${nodeId}"\n`);
    return 1;
  }
  const output = opts.json ? formatNodeShowJson(detail) : formatNodeShow(detail);
  out.write(output);
  return 0;
}
