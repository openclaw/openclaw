import { isDurableRuntimesEnabled } from "../durable/config.js";
import {
  buildDurableCoordinationProjection,
  type DurableCoordinationProjection,
} from "../durable/coordination-projection.js";
import { openDurableRuntimeStore } from "../durable/store-factory.js";
import type {
  DurableRuntimeEvent,
  DurableRuntimeLink,
  DurableRuntimeRef,
  DurableRuntimeRun,
  DurableRuntimeSignal,
  DurableRuntimeStep,
  DurableRuntimeStore,
  DurableRuntimeTimer,
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
  | "why"
  | "stats";

export type DurableCliOptions = {
  action: DurableCliAction;
  runtimeRunId?: string;
  json?: boolean;
  limit?: number;
  env?: NodeJS.ProcessEnv;
};

type DurableRunDetails = {
  run: DurableRuntimeRun;
  steps: DurableRuntimeStep[];
  children: DurableRuntimeLink[];
  parents: DurableRuntimeLink[];
  signals: DurableRuntimeSignal[];
  refs: DurableRuntimeRef[];
  timers: DurableRuntimeTimer[];
  timeline: DurableRuntimeEvent[];
};

type DurableWhyPayload = {
  summary: string;
  projection: DurableCoordinationProjection;
  commands: string[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseLimit(value: number | undefined): number {
  return Math.max(1, Math.min(500, Math.trunc(value ?? 50)));
}

function requireRunId(opts: DurableCliOptions, runtime: RuntimeEnv): string | undefined {
  const runtimeRunId = opts.runtimeRunId?.trim();
  if (runtimeRunId) {
    return runtimeRunId;
  }
  runtime.error("A runtime run id is required.");
  runtime.exit(1);
  return undefined;
}

function loadRunDetails(
  store: DurableRuntimeStore,
  runtimeRunId: string,
): DurableRunDetails | undefined {
  const run = store.getRun(runtimeRunId);
  if (!run) {
    return undefined;
  }
  return {
    run,
    steps: store.listSteps(runtimeRunId),
    children: store.listChildLinks(runtimeRunId),
    parents: store.listParentLinks(runtimeRunId),
    signals: store.listSignals(runtimeRunId),
    refs: store.listRefs(runtimeRunId),
    timers: store.listTimers(runtimeRunId),
    timeline: store.getTimeline(runtimeRunId),
  };
}

function summarizeRun(run: DurableRuntimeRun): string {
  const heartbeat = run.heartbeatAt ? ` heartbeat=${formatTime(run.heartbeatAt)}` : "";
  const source = run.sourceRef ? ` source=${run.sourceRef}` : "";
  const parent = run.parentRuntimeRunId ? ` parent=${run.parentRuntimeRunId}` : "";
  const diagnostic = recoveryDiagnosticSummary(run);
  return [
    run.runtimeRunId,
    run.operationKind,
    `${run.status}/${run.recoveryState}`,
    `updated=${formatTime(run.updatedAt)}`,
    diagnostic,
    `${source}${parent}${heartbeat}`.trim(),
  ]
    .filter(Boolean)
    .join("  ");
}

function recoveryDiagnosticSummary(run: DurableRuntimeRun): string | undefined {
  const raw =
    run.metadata && typeof run.metadata.recoveryDiagnostic === "object"
      ? (run.metadata.recoveryDiagnostic as Record<string, unknown>)
      : undefined;
  if (!raw) {
    return undefined;
  }
  const state = typeof raw.state === "string" ? raw.state : undefined;
  const reason = typeof raw.reason === "string" ? raw.reason : undefined;
  const nextAction = typeof raw.nextAction === "string" ? raw.nextAction : undefined;
  const parts = [state ? `recovery=${state}` : "recovery=diagnostic"];
  if (reason) {
    parts.push(`reason=${reason}`);
  }
  if (nextAction) {
    parts.push(`next=${nextAction}`);
  }
  return parts.join(" ");
}

function renderRuns(runs: DurableRuntimeRun[]): string {
  if (runs.length === 0) {
    return "No durable runtime runs found.";
  }
  return runs.map(summarizeRun).join("\n");
}

function renderTimeline(events: DurableRuntimeEvent[]): string {
  if (events.length === 0) {
    return "No durable runtime events found.";
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

function renderSteps(steps: DurableRuntimeStep[]): string {
  if (steps.length === 0) {
    return "No durable runtime steps found.";
  }
  return steps
    .map((step) => {
      const metadata = metadataRecord(step.metadata);
      const outcome = metadataRecord(metadata.outcome);
      const ack = metadataRecord(metadata.ack);
      const delivery = metadataRecord(metadata.delivery);
      const fanInGroupId = optionalString(metadata.fanInGroupId);
      const terminalOutcome = optionalString(outcome.terminalOutcome);
      const ackStatus = optionalString(ack.status);
      const deliveryStatus = optionalString(delivery.status);
      return [
        step.stepId,
        step.stepType,
        `${step.status}/${step.recoveryState}`,
        `attempt=${step.attempt}`,
        fanInGroupId ? `fan_in=${fanInGroupId}` : "",
        terminalOutcome ? `outcome=${terminalOutcome}` : "",
        ackStatus ? `ack=${ackStatus}` : "",
        deliveryStatus ? `delivery=${deliveryStatus}` : "",
        step.heartbeatAt ? `heartbeat=${formatTime(step.heartbeatAt)}` : "",
        step.outputRef ? `output=${step.outputRef}` : "",
        step.errorRef ? `error=${step.errorRef}` : "",
      ]
        .filter(Boolean)
        .join("  ");
    })
    .join("\n");
}

function renderLinks(links: DurableRuntimeLink[], direction: "children" | "parents"): string {
  if (links.length === 0) {
    return `No durable runtime ${direction} found.`;
  }
  return links
    .map((link) => {
      const metadata = metadataRecord(link.metadata);
      const fanInGroupId = optionalString(metadata.fanInGroupId);
      const childSessionKey = optionalString(metadata.childSessionKey);
      return [
        direction === "children"
          ? `child=${link.childRuntimeRunId}`
          : `parent=${link.parentRuntimeRunId}`,
        `step=${link.parentStepId}`,
        link.linkType,
        link.status,
        fanInGroupId ? `fan_in=${fanInGroupId}` : "",
        childSessionKey ? `session=${childSessionKey}` : "",
        `updated=${formatTime(link.updatedAt)}`,
      ]
        .filter(Boolean)
        .join("  ");
    })
    .join("\n");
}

function renderSignals(signals: DurableRuntimeSignal[]): string {
  if (signals.length === 0) {
    return "No durable runtime signals found.";
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

function renderRefs(refs: DurableRuntimeRef[]): string {
  if (refs.length === 0) {
    return "No durable runtime refs found.";
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

function renderTimers(timers: DurableRuntimeTimer[]): string {
  if (timers.length === 0) {
    return "No durable runtime timers found.";
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

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

function buildWhyCommands(projection: DurableCoordinationProjection): string[] {
  const commands = [
    `openclaw durable timeline ${projection.runtimeRunId}`,
    `openclaw durable steps ${projection.runtimeRunId}`,
  ];
  if (projection.children.total > 0) {
    commands.push(`openclaw durable children ${projection.runtimeRunId}`);
  }
  if (projection.controls.canSignal) {
    commands.push(`openclaw durable signals ${projection.runtimeRunId}`);
  }
  if (
    projection.refs.inputRef ||
    projection.refs.outputRefs.length > 0 ||
    projection.refs.errorRefs.length > 0 ||
    projection.refs.artifactRefs.length > 0
  ) {
    commands.push(`openclaw durable refs ${projection.runtimeRunId}`);
  }
  return commands;
}

function explainProjection(projection: DurableCoordinationProjection): string {
  if (projection.recovery) {
    return projection.recovery.message;
  }
  if (projection.waitingReason) {
    switch (projection.waitingReason) {
      case "child":
        return `Run is waiting for child work: ${projection.children.open} open of ${projection.children.total} children.`;
      case "signal":
        return "Run is waiting for a durable signal or human input.";
      case "timer":
        return "Run is waiting for a durable timer.";
      case "retry":
        return "Run has a retry scheduled; durable runtime will only requeue it when the timer is due.";
      case "worker":
        return "Run or step is claimed by a worker and should heartbeat while active.";
      case "unknown":
        return "Run needs reconciliation before any retry or resume policy is applied.";
    }
  }
  if (projection.completedAt) {
    return `Run is terminal: ${projection.status}/${projection.recoveryState}.`;
  }
  return `Run is open: ${projection.status}/${projection.recoveryState}.`;
}

function buildWhyPayload(details: DurableRunDetails): DurableWhyPayload {
  const projection = buildDurableCoordinationProjection({
    run: details.run,
    steps: details.steps,
    childLinks: details.children,
    refs: details.refs,
  });
  return {
    summary: explainProjection(projection),
    projection,
    commands: buildWhyCommands(projection),
  };
}

function renderWhy(payload: DurableWhyPayload): string {
  const projection = payload.projection;
  const lines = [
    `${projection.runtimeRunId}  ${projection.operationKind}  ${projection.status}/${projection.recoveryState}`,
    `Summary: ${payload.summary}`,
    `Updated: ${formatTime(projection.updatedAt)}`,
  ];
  if (projection.completedAt) {
    lines.push(`Completed: ${formatTime(projection.completedAt)}`);
  }
  if (projection.sourceRef) {
    lines.push(`Source: ${projection.sourceRef}`);
  }
  if (projection.currentStepId) {
    lines.push(`Current step: ${projection.currentStepId}`);
  }
  if (projection.waitingReason) {
    lines.push(`Waiting reason: ${projection.waitingReason}`);
  }
  if (projection.heartbeatAt) {
    lines.push(`Heartbeat: ${formatTime(projection.heartbeatAt)}`);
  }
  if (projection.children.total > 0) {
    lines.push(
      `Children: total=${projection.children.total} open=${projection.children.open} terminal=${projection.children.terminal} succeeded=${projection.children.succeeded} failed=${projection.children.failed} lost=${projection.children.lost}`,
    );
  }
  if (projection.recovery) {
    lines.push(
      `Recovery: ${projection.recovery.state}/${projection.recovery.severity} next=${projection.recovery.nextAction}`,
    );
    if (projection.recovery.reason) {
      lines.push(`Reason: ${projection.recovery.reason}`);
    }
    if (projection.recovery.safeRecoveryActions?.length) {
      lines.push(`Safe actions: ${projection.recovery.safeRecoveryActions.join(", ")}`);
    }
  }
  lines.push(
    `Controls: cancel=${yesNo(projection.controls.canCancel)} retry=${yesNo(
      projection.controls.canRetry,
    )} resume=${yesNo(projection.controls.canResume)} signal=${yesNo(
      projection.controls.canSignal,
    )}`,
  );
  lines.push("Inspect:");
  for (const command of payload.commands) {
    lines.push(`- ${command}`);
  }
  return lines.join("\n");
}

export async function durableCommand(opts: DurableCliOptions, runtime: RuntimeEnv): Promise<void> {
  const env = opts.env ?? process.env;
  if (!isDurableRuntimesEnabled(env)) {
    if (opts.json) {
      writeJson(runtime, { enabled: false });
    } else {
      write(
        runtime,
        "Durable runtime is disabled. Set OPENCLAW_DURABLE_RUNTIME=1 to inspect durable runtime state.",
      );
    }
    return;
  }

  const store = openDurableRuntimeStore({ env });
  try {
    if (opts.action === "stats") {
      const stats = store.getStats();
      if (opts.json) {
        writeJson(runtime, stats);
      } else {
        write(
          runtime,
          `Durable runtime store: ${stats.path}\nruns=${stats.runs} open=${stats.openRuns} steps=${stats.steps} events=${stats.events}`,
        );
      }
      return;
    }

    if (opts.action === "runs") {
      const runs = store.listRuns({ limit: parseLimit(opts.limit) });
      if (opts.json) {
        writeJson(runtime, runs);
      } else {
        write(runtime, renderRuns(runs));
      }
      return;
    }

    const runtimeRunId = requireRunId(opts, runtime);
    if (!runtimeRunId) {
      return;
    }

    const details = loadRunDetails(store, runtimeRunId);
    if (!details) {
      runtime.error(`Durable runtime run not found: ${runtimeRunId}`);
      runtime.exit(1);
      return;
    }

    const payload =
      opts.action === "show"
        ? details
        : opts.action === "why"
          ? buildWhyPayload(details)
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
        : opts.action === "why"
          ? renderWhy(buildWhyPayload(details))
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
