import { Graph, type Node } from "@antv/x6";
import { MiniMap } from "@antv/x6-plugin-minimap";
import { Selection } from "@antv/x6-plugin-selection";
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { WorkflowPlan } from "../views/workflow.js";

const STATUS_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  pending: { fill: "#374151", stroke: "#6b7280", text: "#d1d5db" },
  in_progress: { fill: "#1e3a5f", stroke: "#3b82f6", text: "#93c5fd" },
  completed: { fill: "#14532d", stroke: "#22c55e", text: "#86efac" },
  skipped: { fill: "#44403c", stroke: "#a8a29e", text: "#d6d3d1" },
  failed: { fill: "#450a0a", stroke: "#ef4444", text: "#fca5a5" },
};

const STATUS_ICONS: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  skipped: "◌",
  failed: "✕",
};

@customElement("workflow-graph")
export class WorkflowGraphElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 400px;
    }

    .graph-container {
      width: 100%;
      height: 100%;
      min-height: 400px;
      background: var(--bg-secondary, #1f2937);
      border-radius: 8px;
      overflow: hidden;
      position: relative;
    }

    .graph-toolbar {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      gap: 4px;
      z-index: 10;
    }

    .graph-toolbar button {
      padding: 6px 10px;
      background: var(--bg-tertiary, #374151);
      border: 1px solid var(--border, #4b5563);
      border-radius: 4px;
      color: var(--text-primary, #f3f4f6);
      cursor: pointer;
      font-size: 12px;
    }

    .graph-toolbar button:hover {
      background: var(--bg-hover, #4b5563);
    }

    .graph-legend {
      position: absolute;
      bottom: 8px;
      left: 8px;
      display: flex;
      gap: 12px;
      padding: 8px 12px;
      background: var(--bg-tertiary, #374151);
      border-radius: 6px;
      font-size: 11px;
      z-index: 10;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--text-secondary, #9ca3af);
    }

    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    .minimap-container {
      position: absolute;
      bottom: 8px;
      right: 8px;
      border: 1px solid var(--border, #4b5563);
      border-radius: 4px;
      overflow: hidden;
    }
  `;

  @property({ type: Object })
  plan: WorkflowPlan | null = null;

  @state()
  private graph: Graph | null = null;

  private containerRef: HTMLElement | null = null;
  private minimapRef: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  override firstUpdated(): void {
    this.containerRef = this.shadowRoot?.getElementById("graph-container") ?? null;
    this.minimapRef = this.shadowRoot?.getElementById("minimap-container") ?? null;

    if (this.containerRef) {
      this.initGraph();
    }

    this.resizeObserver = new ResizeObserver(() => {
      if (this.graph && this.containerRef) {
        const rect = this.containerRef.getBoundingClientRect();
        this.graph.resize(rect.width, rect.height);
      }
    });

    if (this.containerRef) {
      this.resizeObserver.observe(this.containerRef);
    }
  }

  override updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("plan") && this.graph) {
      this.renderGraph();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.graph?.dispose();
  }

  private initGraph(): void {
    if (!this.containerRef) {
      return;
    }

    const rect = this.containerRef.getBoundingClientRect();

    this.graph = new Graph({
      container: this.containerRef,
      width: rect.width || 800,
      height: rect.height || 400,
      background: { color: "transparent" },
      grid: {
        visible: true,
        type: "dot",
        size: 20,
        args: {
          color: "#374151",
          thickness: 1,
        },
      },
      panning: {
        enabled: true,
        modifiers: [],
      },
      mousewheel: {
        enabled: true,
        modifiers: ["ctrl", "meta"],
        factor: 1.1,
        maxScale: 2,
        minScale: 0.3,
      },
      connecting: {
        router: {
          name: "manhattan",
          args: {
            padding: 20,
          },
        },
        connector: {
          name: "rounded",
          args: {
            radius: 8,
          },
        },
      },
    });

    if (this.minimapRef) {
      this.graph.use(
        new MiniMap({
          container: this.minimapRef,
          width: 150,
          height: 100,
          padding: 10,
        }),
      );
    }

    this.graph.use(
      new Selection({
        enabled: true,
        showNodeSelectionBox: true,
      }),
    );

    this.renderGraph();
  }

  private renderGraph(): void {
    if (!this.graph || !this.plan) {
      return;
    }

    this.graph.clearCells();

    const tasks = [...this.plan.tasks].toSorted((a, b) => a.order - b.order);
    const nodeWidth = 220;
    const nodeHeight = 60;
    const horizontalGap = 80;
    const verticalGap = 40;
    const startX = 50;
    const startY = 50;

    const nodesPerRow = 3;
    const nodes: Node[] = [];

    tasks.forEach((task, index) => {
      const row = Math.floor(index / nodesPerRow);
      const col = index % nodesPerRow;
      const isReversed = row % 2 === 1;
      const actualCol = isReversed ? nodesPerRow - 1 - col : col;

      const x = startX + actualCol * (nodeWidth + horizontalGap);
      const y = startY + row * (nodeHeight + verticalGap);

      const colors = STATUS_COLORS[task.status] || STATUS_COLORS.pending;
      const icon = STATUS_ICONS[task.status] || STATUS_ICONS.pending;

      const node = this.graph!.addNode({
        id: task.id,
        x,
        y,
        width: nodeWidth,
        height: nodeHeight,
        shape: "rect",
        attrs: {
          body: {
            fill: colors.fill,
            stroke: colors.stroke,
            strokeWidth: 2,
            rx: 8,
            ry: 8,
          },
          label: {
            text: `${icon}  ${task.content}`,
            fill: colors.text,
            fontSize: 13,
            fontWeight: 500,
            textWrap: {
              width: nodeWidth - 30,
              height: nodeHeight - 20,
              ellipsis: true,
            },
          },
        },
        data: { task },
      });

      nodes.push(node);
    });

    for (let i = 0; i < nodes.length - 1; i++) {
      const sourceTask = tasks[i];
      const sourceColors = STATUS_COLORS[sourceTask.status] || STATUS_COLORS.pending;

      this.graph.addEdge({
        source: { cell: nodes[i].id },
        target: { cell: nodes[i + 1].id },
        attrs: {
          line: {
            stroke: sourceColors.stroke,
            strokeWidth: 2,
            targetMarker: {
              name: "block",
              width: 10,
              height: 8,
            },
          },
        },
        router: {
          name: "manhattan",
          args: {
            padding: 20,
            startDirections: ["right", "bottom"],
            endDirections: ["left", "top"],
          },
        },
        connector: {
          name: "rounded",
          args: { radius: 8 },
        },
      });
    }

    this.graph.centerContent();
  }

  private handleZoomIn = (): void => {
    this.graph?.zoom(0.2);
  };

  private handleZoomOut = (): void => {
    this.graph?.zoom(-0.2);
  };

  private handleFitView = (): void => {
    this.graph?.zoomToFit({ padding: 40, maxScale: 1.5 });
  };

  private handleCenter = (): void => {
    this.graph?.centerContent();
  };

  override render() {
    return html`
      <div class="graph-container" id="graph-container">
        <div class="graph-toolbar">
          <button @click=${this.handleZoomIn} title="Zoom In">+</button>
          <button @click=${this.handleZoomOut} title="Zoom Out">−</button>
          <button @click=${this.handleFitView} title="Fit View">⊡</button>
          <button @click=${this.handleCenter} title="Center">◎</button>
        </div>

        <div class="graph-legend">
          <div class="legend-item">
            <div class="legend-dot" style="background: #6b7280;"></div>
            <span>Pending</span>
          </div>
          <div class="legend-item">
            <div class="legend-dot" style="background: #3b82f6;"></div>
            <span>In Progress</span>
          </div>
          <div class="legend-item">
            <div class="legend-dot" style="background: #22c55e;"></div>
            <span>Completed</span>
          </div>
          <div class="legend-item">
            <div class="legend-dot" style="background: #ef4444;"></div>
            <span>Failed</span>
          </div>
        </div>

        <div class="minimap-container" id="minimap-container"></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "workflow-graph": WorkflowGraphElement;
  }
}
