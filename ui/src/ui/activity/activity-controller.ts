import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { AgentEventPayload } from "../app-tool-stream.ts";
import {
  createMetricsHistory,
  pushSample,
  getSparklineData,
  type MetricsHistory,
} from "./activity-metrics-history.ts";
import {
  createActivityTree,
  applyActivityEvent,
  computeMetrics,
  pruneCompletedBranches,
  filterTree,
  type ActivityFilterCriteria,
} from "./activity-tree.ts";
import type {
  ActivityTree,
  ActivityMetrics,
  ActivityNode,
  ActivityNodeKind,
} from "./activity-types.ts";

const THROTTLE_MS = 100;
const PRUNE_INTERVAL_MS = 30_000;
const METRICS_SAMPLE_INTERVAL_MS = 2_000;

export class ActivityController implements ReactiveController {
  private _tree: ActivityTree = createActivityTree();
  private _metrics: ActivityMetrics = {
    activeRuns: 0,
    activeTools: 0,
    totalToolCalls: 0,
    totalErrors: 0,
    completedNodes: 0,
  };
  private _metricsHistory: MetricsHistory = createMetricsHistory();
  private _selectedNodeId: string | null = null;
  private _filters: ActivityFilterCriteria = {
    kinds: new Set<ActivityNodeKind>(["run", "tool", "thinking", "subagent"]),
    search: "",
    timeRangeMs: null,
  };
  private _host: ReactiveControllerHost;
  private _updateTimer: ReturnType<typeof setTimeout> | null = null;
  private _pruneTimer: ReturnType<typeof setInterval> | null = null;
  private _sampleTimer: ReturnType<typeof setInterval> | null = null;
  private _dirty = false;

  constructor(host: ReactiveControllerHost) {
    this._host = host;
    host.addController(this);
  }

  get tree(): ActivityTree {
    return this._tree;
  }

  get filteredTree(): ActivityTree {
    const hasFilters =
      this._filters.search !== "" ||
      this._filters.timeRangeMs !== null ||
      this._filters.kinds.size < 4;
    if (!hasFilters) {
      return this._tree;
    }
    return filterTree(this._tree, this._filters);
  }

  get filters(): ActivityFilterCriteria {
    return this._filters;
  }

  get metrics(): ActivityMetrics {
    return this._metrics;
  }

  get selectedNode(): ActivityNode | null {
    if (!this._selectedNodeId) {
      return null;
    }
    return this._tree.nodeById.get(this._selectedNodeId) ?? null;
  }

  get toolCallsHistory(): number[] {
    return getSparklineData(this._metricsHistory, (m) => m.totalToolCalls);
  }

  get errorsHistory(): number[] {
    return getSparklineData(this._metricsHistory, (m) => m.totalErrors);
  }

  get activeRunsHistory(): number[] {
    return getSparklineData(this._metricsHistory, (m) => m.activeRuns);
  }

  selectNode(nodeId: string | null): void {
    this._selectedNodeId = nodeId;
    this._host.requestUpdate();
  }

  setSearch(search: string): void {
    this._filters = { ...this._filters, search };
    this._host.requestUpdate();
  }

  toggleKind(kind: ActivityNodeKind): void {
    const next = new Set(this._filters.kinds);
    if (next.has(kind)) {
      next.delete(kind);
    } else {
      next.add(kind);
    }
    this._filters = { ...this._filters, kinds: next };
    this._host.requestUpdate();
  }

  setTimeRange(ms: number | null): void {
    this._filters = { ...this._filters, timeRangeMs: ms };
    this._host.requestUpdate();
  }

  hostConnected(): void {
    this._pruneTimer = setInterval(() => {
      pruneCompletedBranches(this._tree);
      this._metrics = computeMetrics(this._tree);
      this._host.requestUpdate();
    }, PRUNE_INTERVAL_MS);

    this._sampleTimer = setInterval(() => {
      pushSample(this._metricsHistory, this._metrics);
    }, METRICS_SAMPLE_INTERVAL_MS);
  }

  hostDisconnected(): void {
    if (this._pruneTimer !== null) {
      clearInterval(this._pruneTimer);
      this._pruneTimer = null;
    }
    if (this._sampleTimer !== null) {
      clearInterval(this._sampleTimer);
      this._sampleTimer = null;
    }
    if (this._updateTimer !== null) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }
  }

  handleEvent(payload: AgentEventPayload): void {
    if (payload.stream !== "activity") {
      return;
    }
    // eslint-disable-next-line no-console
    console.log("[activity]", JSON.stringify(payload.data));

    this._tree = applyActivityEvent(this._tree, {
      runId: payload.runId,
      ts: payload.ts,
      sessionKey: payload.sessionKey,
      data: payload.data as {
        kind: string;
        agentId?: string;
        parentRunId?: string;
        depth?: number;
        toolName?: string;
        toolCallId?: string;
        durationMs?: number;
        isError?: boolean;
        error?: string;
        metadata?: Record<string, unknown>;
      },
    });

    this._dirty = true;
    this._scheduleUpdate();
  }

  reset(): void {
    this._tree = createActivityTree();
    this._metrics = {
      activeRuns: 0,
      activeTools: 0,
      totalToolCalls: 0,
      totalErrors: 0,
      completedNodes: 0,
    };
    this._metricsHistory = createMetricsHistory();
    this._selectedNodeId = null;
    this._host.requestUpdate();
  }

  private _scheduleUpdate(): void {
    if (this._updateTimer !== null) {
      return;
    }
    this._updateTimer = setTimeout(() => {
      this._updateTimer = null;
      if (this._dirty) {
        this._dirty = false;
        this._metrics = computeMetrics(this._tree);
        this._host.requestUpdate();
      }
    }, THROTTLE_MS);
  }
}
