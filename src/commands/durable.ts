import { buildDurableCoordinationProjection } from "../durable/coordination-projection.js";
import { openDurableWorkflowSqliteStore } from "../durable/sqlite-store.js";
import type {
  DurableWorkflowEvent,
  DurableWorkflowLink,
  DurableWorkflowRef,
  DurableWorkflowRun,
  DurableWorkflowSignal,
  DurableWorkflowStep,
  DurableWorkflowStore,
  DurableWorkflowTimer,
} from "../durable/types.js";
import type { RuntimeEnv } from "../runtime.js";

export type DurableCliAction =
  | "runs"
  | "show"
  | "timeline"
  | "steps"
  | "children"
  | "parents"
  | "signals"
  | "refs"
  | "timers"
  | "coordination"
  | "stats";

export type DurableCliOptions = {
  action: DurableCliAction;
  workflowRunId?: string;
  json?: boolean;
  limit?: number;
  env?: NodeJS.ProcessEnv;
};

type DurableRunDetails = {
  run: DurableWorkflowRun;
  steps: DurableWorkflowStep[];
  children: DurableWorkflowLink[];
  parents: DurableWorkflowLink[];
  signals: DurableWorkflowSignal[];
  refs: DurableWorkflowRef[];
  timers: DurableWorkflowTimer[];
  timeline: DurableWorkflowEvent[];
};

function write(runtime: RuntimeEnv, value: string): void {
  runtime.log(value);
}

function writeJson(runtime: RuntimeEnv, value: unknown): void {
  runtime.log(JSON.stringify(value, null, 2));
}

function formatTime(value?: number): string {
  return value ? new Date(value).toISOString() : "-";
}

function parseLimit(value: number | undefined): number {
  return Math.max(1, Math.min(500, Math.trunc(value ?? 50)));
}

function requireRunId(opts: DurableCliOptions, runtime: RuntimeEnv): string | undefined {
  const workflowRunId = opts.workflowRunId?.trim();
  if (workflowRunId) {
    return workflowRunId;
  }
  runtime.error("A workflow run id is required.");
  runtime.exit(1);
  return undefined;
}

function loadRunDetails(
  store: DurableWorkflowStore,
  workflowRunId: string,
): DurableRunDetails | undefined {
  const run = store.getRun(workflowRunId);
  if (!run) {
    return undefined;
  }
  return {
    run,
    steps: store.listSteps(workflowRunId),
    children: store.listChildLinks(workflowRunId),
    parents: store.listParentLinks(workflowRunId),
    signals: store.listSignals(workflowRunId),
    refs: store.listRefs(workflowRunId),
    timers: store.listTimers(workflowRunId),
    timeline: store.getTimeline(workflowRunId),
  };
}

function summarizeRun(run: DurableWorkflowRun): string {
  const heartbeat = run.heartbeatAt ? ` heartbeat=${formatTime(run.heartbeatAt)}` : "";
  const source = run.sourceRef ? ` source=${run.sourceRef}` : "";
  const parent = run.parentWorkflowRunId ? ` parent=${run.parentWorkflowRunId}` : "";
  return [
    run.workflowRunId,
    run.workflowId,
    `${run.status}/${run.recoveryState}`,
    `updated=${formatTime(run.updatedAt)}`,
    `${source}${parent}${heartbeat}`.trim(),
  ]
    .filter(Boolean)
    .join("  ");
}

function renderRuns(runs: DurableWorkflowRun[]): string {
  if (runs.length === 0) {
    return "No durable workflow runs found.";
  }
  return runs.map(summarizeRun).join("\n");
}

function renderTimeline(events: DurableWorkflowEvent[]): string {
  if (events.length === 0) {
    return "No durable workflow events found.";
  }
  return events
    .map((event) =>
      [
        `#${event.eventSeq}`,
        formatTime(event.eventTime),
        event.eventType,
        event.stepId ? `step=${event.stepId}` : "",
        event.correlationId ? `corr=${event.correlationId}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}

function renderSteps(steps: DurableWorkflowStep[]): string {
  if (steps.length === 0) {
    return "No durable workflow steps found.";
  }
  return steps
    .map((step) =>
      [
        step.stepId,
        step.stepType,
        `${step.status}/${step.recoveryState}`,
        `attempt=${step.attempt}`,
        step.heartbeatAt ? `heartbeat=${formatTime(step.heartbeatAt)}` : "",
        step.outputRef ? `output=${step.outputRef}` : "",
        step.errorRef ? `error=${step.errorRef}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}

function renderLinks(links: DurableWorkflowLink[], direction: "children" | "parents"): string {
  if (links.length === 0) {
    return `No durable workflow ${direction} found.`;
  }
  return links
    .map((link) =>
      [
        direction === "children"
          ? `child=${link.childWorkflowRunId}`
          : `parent=${link.parentWorkflowRunId}`,
        `step=${link.parentStepId}`,
        link.linkType,
        link.status,
        `updated=${formatTime(link.updatedAt)}`,
      ].join("  "),
    )
    .join("\n");
}

function renderSignals(signals: DurableWorkflowSignal[]): string {
  if (signals.length === 0) {
    return "No durable workflow signals found.";
  }
  return signals
    .map((signal) =>
      [
        signal.signalId,
        signal.signalType,
        signal.consumedAt ? "consumed" : "pending",
        `received=${formatTime(signal.receivedAt)}`,
        signal.correlationId ? `corr=${signal.correlationId}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}

function renderRefs(refs: DurableWorkflowRef[]): string {
  if (refs.length === 0) {
    return "No durable workflow refs found.";
  }
  return refs
    .map((ref) =>
      [
        ref.refId,
        ref.refKind,
        ref.storageKind,
        ref.stepId ? `step=${ref.stepId}` : "",
        ref.hash ? `hash=${ref.hash}` : "",
        ref.storageUri ? `uri=${ref.storageUri}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}

function renderTimers(timers: DurableWorkflowTimer[]): string {
  if (timers.length === 0) {
    return "No durable workflow timers found.";
  }
  return timers
    .map((timer) =>
      [
        timer.timerId,
        timer.timerType,
        timer.status,
        `due=${formatTime(timer.dueAt)}`,
        timer.stepId ? `step=${timer.stepId}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}

function renderDetails(details: DurableRunDetails): string {
  return [
    summarizeRun(details.run),
    "",
    "Steps:",
    renderSteps(details.steps),
    "",
    "Children:",
    renderLinks(details.children, "children"),
    "",
    "Signals:",
    renderSignals(details.signals),
    "",
    "Timeline:",
    renderTimeline(details.timeline),
  ].join("\n");
}

export async function durableCommand(opts: DurableCliOptions, runtime: RuntimeEnv): Promise<void> {
  const store = openDurableWorkflowSqliteStore({ env: opts.env });
  try {
    if (opts.action === "stats") {
      const stats = store.getStats();
      if (opts.json) {
        writeJson(runtime, stats);
      } else {
        write(
          runtime,
          `Durable workflow store: ${stats.path}\nruns=${stats.runs} open=${stats.openRuns} steps=${stats.steps} events=${stats.events}`,
        );
      }
      return;
    }

    if (opts.action === "runs") {
      const runs = store.listRuns({ limit: parseLimit(opts.limit) });
      opts.json ? writeJson(runtime, runs) : write(runtime, renderRuns(runs));
      return;
    }

    const workflowRunId = requireRunId(opts, runtime);
    if (!workflowRunId) {
      return;
    }

    const details = loadRunDetails(store, workflowRunId);
    if (!details) {
      runtime.error(`Durable workflow run not found: ${workflowRunId}`);
      runtime.exit(1);
      return;
    }

    const payload =
      opts.action === "show"
        ? details
        : opts.action === "coordination"
          ? buildDurableCoordinationProjection({
              run: details.run,
              steps: details.steps,
              childLinks: details.children,
              refs: details.refs,
            })
          : opts.action === "timeline"
            ? details.timeline
            : opts.action === "steps"
              ? details.steps
              : opts.action === "children"
                ? details.children
                : opts.action === "parents"
                  ? details.parents
                  : opts.action === "signals"
                    ? details.signals
                    : opts.action === "refs"
                      ? details.refs
                      : details.timers;

    if (opts.json) {
      writeJson(runtime, payload);
      return;
    }

    const text =
      opts.action === "show"
        ? renderDetails(details)
        : opts.action === "coordination"
          ? JSON.stringify(
              buildDurableCoordinationProjection({
                run: details.run,
                steps: details.steps,
                childLinks: details.children,
                refs: details.refs,
              }),
              null,
              2,
            )
          : opts.action === "timeline"
            ? renderTimeline(details.timeline)
            : opts.action === "steps"
              ? renderSteps(details.steps)
              : opts.action === "children"
                ? renderLinks(details.children, "children")
                : opts.action === "parents"
                  ? renderLinks(details.parents, "parents")
                  : opts.action === "signals"
                    ? renderSignals(details.signals)
                    : opts.action === "refs"
                      ? renderRefs(details.refs)
                      : renderTimers(details.timers);
    write(runtime, text);
  } finally {
    store.close();
  }
}
