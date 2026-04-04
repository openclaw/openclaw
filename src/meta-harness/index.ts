/**
 * Meta-Harness public API
 *
 * Main entry point for the meta-harness subsystem.
 * All methods are workspace-gated: if manifest.json is missing, they are no-ops.
 */

import { buildDailySummary, buildWeeklySummary } from "./aggregation.js";
import { checkWorkspaceGating, ensureRuntimeLayout } from "./gating.js";
import type {
  FlowTrace,
  ChildTrace,
  RichTrace,
  DailySummary,
  WeeklySummary,
  TraceId,
  TriggerKind,
  TriageDomain,
  AutomationLevel,
  RunOutcome,
  ToolOutcome,
  Observation,
} from "./types.js";
import {
  generateTraceId,
  writeFlowTrace,
  writeChildTrace,
  writeRichTrace,
  writeDailySummary,
  writeWeeklySummary,
} from "./writer.js";

export type {
  FlowTrace,
  ChildTrace,
  RichTrace,
  DailySummary,
  WeeklySummary,
  TraceId,
  TriggerKind,
  TriageDomain,
  AutomationLevel,
  RunOutcome,
  ToolOutcome,
  Observation,
  GatingResult,
  MetaHarnessManifest,
} from "./types.js";
export { checkWorkspaceGating, ensureRuntimeLayout } from "./gating.js";
export { generateTraceId } from "./writer.js";
export { buildDailySummary, buildWeeklySummary } from "./aggregation.js";

const HARNESS_VERSION = "1.0.0";

/**
 * Create a flow trace builder for a specific run.
 * Returns null if Meta-Harness is not enabled for this workspace.
 */
export function createFlowTraceBuilder(params: {
  workspaceDir: string;
  sessionId: string;
  flowId: string;
  trigger: TriggerKind;
  taskSummary: string;
  triageDomain: TriageDomain;
  automationLevel: AutomationLevel;
}): FlowTraceBuilder | null {
  // We check gating lazily (on finalize) to avoid blocking normal operations.
  return new FlowTraceBuilder(params);
}

/**
 * FlowTraceBuilder — accumulates data during a run and writes on finalize.
 */
export class FlowTraceBuilder {
  private _traceId: TraceId;
  private startTime: number;
  private toolOutcomes: ToolOutcome[] = [];
  private delegations: import("./types.js").DelegationEntry[] = [];
  private observations: Observation[] = [];

  constructor(
    private params: {
      workspaceDir: string;
      sessionId: string;
      flowId: string;
      trigger: TriggerKind;
      taskSummary: string;
      triageDomain: TriageDomain;
      automationLevel: AutomationLevel;
    },
  ) {
    this._traceId = generateTraceId();
    this.startTime = Date.now();
  }

  get traceId(): TraceId {
    return this._traceId;
  }

  /**
   * Record a tool call outcome.
   */
  recordToolOutcome(outcome: ToolOutcome): void {
    this.toolOutcomes.push(outcome);
  }

  /**
   * Record a delegation to a child agent.
   */
  recordDelegation(delegation: import("./types.js").DelegationEntry): void {
    this.delegations.push(delegation);
  }

  /**
   * Record an observation.
   */
  recordObservation(observation: Observation): void {
    this.observations.push(observation);
  }

  /**
   * Finalize and write the flow trace.
   * Returns the written file path, or null if Meta-Harness is disabled.
   */
  async finalize(outcome: RunOutcome): Promise<string | null> {
    const gating = await checkWorkspaceGating(this.params.workspaceDir);
    if (!gating.enabled) {
      return null;
    }

    const trace: FlowTrace = {
      trace_id: this.traceId,
      timestamp: new Date(this.startTime).toISOString(),
      session_id: this.params.sessionId,
      flow_id: this.params.flowId,
      trigger: this.params.trigger,
      task_summary: this.params.taskSummary,
      triage_domain: this.params.triageDomain,
      automation_level: this.params.automationLevel,
      delegation_list: this.delegations,
      outcome,
      observations: this.observations,
      harness_version: HARNESS_VERSION,
      tool_outcomes: this.toolOutcomes,
      duration_ms: Date.now() - this.startTime,
    };

    return writeFlowTrace(this.params.workspaceDir, trace);
  }

  /**
   * Write a child trace linked to this flow.
   */
  async writeChildTrace(childTrace: Omit<ChildTrace, "parent_trace_id">): Promise<string | null> {
    const gating = await checkWorkspaceGating(this.params.workspaceDir);
    if (!gating.enabled) {
      return null;
    }

    const full: ChildTrace = {
      ...childTrace,
      parent_trace_id: this._traceId,
    };
    return writeChildTrace(this.params.workspaceDir, full);
  }

  /**
   * Write a rich trace (only on escalation conditions).
   */
  async writeRichTrace(escalationReason: string, rawContent: string): Promise<string | null> {
    const gating = await checkWorkspaceGating(this.params.workspaceDir);
    if (!gating.enabled) {
      return null;
    }

    const richTrace: RichTrace = {
      trace_id: this.traceId,
      parent_trace_id: undefined,
      escalation_reason: escalationReason,
      timestamp: new Date().toISOString(),
      raw_content: rawContent,
    };
    return writeRichTrace(this.params.workspaceDir, richTrace);
  }
}

/**
 * Generate and write a daily summary for a given date.
 */
export async function generateDailySummary(
  workspaceDir: string,
  date: string,
): Promise<string | null> {
  const gating = await checkWorkspaceGating(workspaceDir);
  if (!gating.enabled) {
    return null;
  }

  const summary = await buildDailySummary(workspaceDir, date);
  return writeDailySummary(workspaceDir, summary);
}

/**
 * Generate and write a weekly summary for a given week range.
 */
export async function generateWeeklySummary(
  workspaceDir: string,
  weekStart: string,
  weekEnd: string,
): Promise<string | null> {
  const gating = await checkWorkspaceGating(workspaceDir);
  if (!gating.enabled) {
    return null;
  }

  const summary = await buildWeeklySummary(workspaceDir, weekStart, weekEnd);
  return writeWeeklySummary(workspaceDir, summary);
}
