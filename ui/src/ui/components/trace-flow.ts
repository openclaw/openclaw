/**
 * SVG-based call chain flow visualization for Lit.
 * Renders a directed acyclic graph of trace nodes with edges,
 * supporting click-to-expand on subagent nodes.
 *
 * Uses a simple top-to-bottom Sugiyama-style layout algorithm
 * (no external dependency needed for the typical linear/branching traces).
 */

import { html, nothing, type TemplateResult } from "lit";
import type { TraceNode, TraceEdge, TraceNodeKind, TraceNodeStatus } from "../types/console-types.ts";

// ─── Layout constants ───────────────────────────────────────────

const NODE_WIDTH = 220;
const NODE_HEIGHT = 64;
const NODE_GAP_X = 40;
const NODE_GAP_Y = 60;
const PADDING = 40;

// ─── Node color mapping ────────────────────────────────────────

function nodeColor(kind: TraceNodeKind): string {
  switch (kind) {
    case "inbound":
      return "var(--info)";
    case "router":
      return "var(--accent-2)";
    case "prompt-assembly":
      return "var(--warn)";
    case "model-call":
      return "var(--accent)";
    case "tool-call":
      return "var(--ok)";
    case "subagent":
      return "#a78bfa";
    case "outbound":
      return "var(--info)";
    case "error":
      return "var(--danger)";
    default:
      return "var(--muted)";
  }
}

function statusIcon(status: TraceNodeStatus): string {
  switch (status) {
    case "success":
      return "\u2713";
    case "error":
      return "\u2717";
    case "running":
      return "\u25CB";
    case "pending":
      return "\u2022";
    case "skipped":
      return "\u2014";
    default:
      return "";
  }
}

function kindIcon(kind: TraceNodeKind): string {
  switch (kind) {
    case "inbound":
      return "\u2193";
    case "router":
      return "\u2194";
    case "prompt-assembly":
      return "\u2630";
    case "model-call":
      return "\u2726";
    case "tool-call":
      return "\u2699";
    case "subagent":
      return "\u2B21";
    case "outbound":
      return "\u2191";
    case "error":
      return "\u26A0";
    default:
      return "\u2022";
  }
}

// ─── Layout calculation ─────────────────────────────────────────

type LayoutNode = {
  node: TraceNode;
  x: number;
  y: number;
  col: number;
  row: number;
};

type LayoutResult = {
  nodes: LayoutNode[];
  width: number;
  height: number;
};

function layoutNodes(nodes: TraceNode[], edges: TraceEdge[]): LayoutResult {
  if (nodes.length === 0) {
    return { nodes: [], width: PADDING * 2, height: PADDING * 2 };
  }

  // Build adjacency from edges
  const childMap = new Map<string, string[]>();
  const parentMap = new Map<string, string[]>();
  for (const edge of edges) {
    if (!childMap.has(edge.source)) childMap.set(edge.source, []);
    childMap.get(edge.source)!.push(edge.target);
    if (!parentMap.has(edge.target)) parentMap.set(edge.target, []);
    parentMap.get(edge.target)!.push(edge.source);
  }

  // Topological sort to assign rows
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const rowAssignment = new Map<string, number>();

  // Find root nodes (no parents)
  const roots = nodes.filter((n) => !parentMap.has(n.id) || parentMap.get(n.id)!.length === 0);
  if (roots.length === 0 && nodes.length > 0) {
    // Fallback: treat first node as root
    roots.push(nodes[0]);
  }

  // BFS to assign rows
  const queue: Array<{ id: string; row: number }> = roots.map((n) => ({ id: n.id, row: 0 }));
  while (queue.length > 0) {
    const { id, row } = queue.shift()!;
    if (visited.has(id)) {
      // Update row to max if revisited
      const existing = rowAssignment.get(id) ?? 0;
      if (row > existing) rowAssignment.set(id, row);
      continue;
    }
    visited.add(id);
    rowAssignment.set(id, row);
    const children = childMap.get(id) ?? [];
    for (const childId of children) {
      queue.push({ id: childId, row: row + 1 });
    }
  }

  // Handle unvisited nodes (disconnected)
  for (const node of nodes) {
    if (!visited.has(node.id)) {
      rowAssignment.set(node.id, (rowAssignment.size > 0 ? Math.max(...rowAssignment.values()) + 1 : 0));
    }
  }

  // Group by row
  const rowGroups = new Map<number, TraceNode[]>();
  for (const node of nodes) {
    const row = rowAssignment.get(node.id) ?? 0;
    if (!rowGroups.has(row)) rowGroups.set(row, []);
    rowGroups.get(row)!.push(node);
  }

  // Assign x/y positions
  const layoutNodes: LayoutNode[] = [];
  let maxCol = 0;
  const maxRow = Math.max(...rowGroups.keys(), 0);

  for (const [row, group] of rowGroups) {
    maxCol = Math.max(maxCol, group.length - 1);
    for (let col = 0; col < group.length; col++) {
      layoutNodes.push({
        node: group[col],
        x: PADDING + col * (NODE_WIDTH + NODE_GAP_X),
        y: PADDING + row * (NODE_HEIGHT + NODE_GAP_Y),
        col,
        row,
      });
    }
  }

  return {
    nodes: layoutNodes,
    width: PADDING * 2 + (maxCol + 1) * NODE_WIDTH + maxCol * NODE_GAP_X,
    height: PADDING * 2 + (maxRow + 1) * NODE_HEIGHT + maxRow * NODE_GAP_Y,
  };
}

// ─── SVG Rendering ──────────────────────────────────────────────

function renderEdgeSVG(
  edge: TraceEdge,
  layoutMap: Map<string, LayoutNode>,
): TemplateResult | typeof nothing {
  const source = layoutMap.get(edge.source);
  const target = layoutMap.get(edge.target);
  if (!source || !target) return nothing;

  const x1 = source.x + NODE_WIDTH / 2;
  const y1 = source.y + NODE_HEIGHT;
  const x2 = target.x + NODE_WIDTH / 2;
  const y2 = target.y;

  // Bezier curve
  const midY = (y1 + y2) / 2;

  return html`
    <g class="trace-edge">
      <path
        d="M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}"
        fill="none"
        stroke="var(--border-strong)"
        stroke-width="2"
        stroke-dasharray=${edge.label ? "none" : "none"}
      />
      <polygon
        points="${x2 - 4},${y2 - 6} ${x2 + 4},${y2 - 6} ${x2},${y2}"
        fill="var(--border-strong)"
      />
      ${
        edge.label
          ? html`
              <text
                x=${(x1 + x2) / 2}
                y=${midY - 6}
                text-anchor="middle"
                class="trace-edge-label"
              >${edge.label}</text>
            `
          : nothing
      }
    </g>
  `;
}

function renderNodeSVG(
  layoutNode: LayoutNode,
  isSubagent: boolean,
  onNodeClick: (node: TraceNode) => void,
): TemplateResult {
  const { node, x, y } = layoutNode;
  const color = nodeColor(node.kind);
  const icon = kindIcon(node.kind);
  const sIcon = statusIcon(node.status);
  const duration = node.durationMs != null ? `${node.durationMs}ms` : "";
  const tokens = node.tokens ? `${node.tokens.total} tok` : "";
  const subtitle = [duration, tokens].filter(Boolean).join(" \u00B7 ");

  return html`
    <g
      class="trace-node ${isSubagent ? "trace-node--subagent" : ""}"
      transform="translate(${x}, ${y})"
      @click=${() => onNodeClick(node)}
      style="cursor: ${isSubagent ? "pointer" : "default"}"
    >
      <rect
        width=${NODE_WIDTH}
        height=${NODE_HEIGHT}
        rx="8"
        ry="8"
        fill="var(--card)"
        stroke=${color}
        stroke-width=${isSubagent ? "2" : "1.5"}
      />
      ${
        isSubagent
          ? html`
              <rect
                width=${NODE_WIDTH}
                height=${NODE_HEIGHT}
                rx="8"
                ry="8"
                fill=${color}
                opacity="0.08"
              />
            `
          : nothing
      }
      <!-- Status indicator -->
      <circle
        cx="16"
        cy="20"
        r="5"
        fill=${node.status === "success" ? "var(--ok)" : node.status === "error" ? "var(--danger)" : node.status === "running" ? "var(--warn)" : "var(--muted)"}
      />
      <!-- Kind icon -->
      <text x="30" y="24" class="trace-node-icon" fill=${color}>${icon}</text>
      <!-- Label -->
      <text x="44" y="24" class="trace-node-label">${node.label}</text>
      <!-- Subtitle -->
      <text x="16" y="48" class="trace-node-subtitle">${subtitle}</text>
      <!-- Status text -->
      <text x=${NODE_WIDTH - 16} y="24" text-anchor="end" class="trace-node-status" fill=${node.status === "success" ? "var(--ok)" : node.status === "error" ? "var(--danger)" : "var(--muted)"}>${sIcon}</text>
      ${
        isSubagent
          ? html`
              <text x=${NODE_WIDTH - 16} y="48" text-anchor="end" class="trace-node-expand" fill=${color}>
                \u25B6 detail
              </text>
            `
          : nothing
      }
    </g>
  `;
}

// ─── Public render function ─────────────────────────────────────

export type TraceFlowProps = {
  nodes: TraceNode[];
  edges: TraceEdge[];
  onSubagentClick: (node: TraceNode) => void;
};

export function renderTraceFlow(props: TraceFlowProps): TemplateResult {
  const { nodes, edges, onSubagentClick } = props;

  if (nodes.length === 0) {
    return html`<div class="trace-flow-empty">No trace data available.</div>`;
  }

  const layout = layoutNodes(nodes, edges);
  const layoutMap = new Map(layout.nodes.map((ln) => [ln.node.id, ln]));

  const svgWidth = Math.max(layout.width, 320);
  const svgHeight = Math.max(layout.height, 200);

  return html`
    <div class="trace-flow-container">
      <svg
        class="trace-flow-svg"
        viewBox="0 0 ${svgWidth} ${svgHeight}"
        width="100%"
        style="max-height: ${svgHeight}px; min-height: 200px;"
      >
        <defs>
          <filter id="node-shadow" x="-10%" y="-10%" width="120%" height="130%">
            <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="rgba(0,0,0,0.3)" />
          </filter>
        </defs>
        <!-- Edges first (behind nodes) -->
        ${edges.map((edge) => renderEdgeSVG(edge, layoutMap))}
        <!-- Nodes -->
        ${layout.nodes.map((ln) =>
          renderNodeSVG(
            ln,
            ln.node.kind === "subagent" && (ln.node.children?.length ?? 0) > 0,
            onSubagentClick,
          ),
        )}
      </svg>
    </div>
  `;
}

// ─── Subagent detail panel ──────────────────────────────────────

export function renderSubagentDetail(
  node: TraceNode,
  onClose: () => void,
): TemplateResult {
  const children = node.children ?? [];
  // Create linear edges for children
  const childEdges: TraceEdge[] = [];
  for (let i = 0; i < children.length - 1; i++) {
    childEdges.push({
      id: `sub-e${i}`,
      source: children[i].id,
      target: children[i + 1].id,
    });
  }

  return html`
    <div class="subagent-detail-panel">
      <div class="subagent-detail-header">
        <div>
          <span class="subagent-detail-icon" style="color: #a78bfa">\u2B21</span>
          <span class="subagent-detail-title">${node.label}</span>
          <span class="data-table-badge data-table-badge--direct" style="margin-left: 8px;">
            ${node.status}
          </span>
        </div>
        <button class="btn btn--sm" @click=${onClose}>Close</button>
      </div>

      <div class="subagent-detail-meta">
        ${node.durationMs != null ? html`<span class="meta-chip">Duration: ${node.durationMs}ms</span>` : nothing}
        ${node.tokens ? html`<span class="meta-chip">Tokens: ${node.tokens.total}</span>` : nothing}
        ${Object.entries(node.meta).map(([key, value]) =>
          html`<span class="meta-chip">${key}: ${String(value)}</span>`,
        )}
      </div>

      ${
        children.length > 0
          ? renderTraceFlow({
              nodes: children,
              edges: childEdges,
              onSubagentClick: () => {}, // No nested expansion for now
            })
          : html`<div class="muted" style="padding: 16px;">No child nodes.</div>`
      }
    </div>
  `;
}
