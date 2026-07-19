import type { DurableRuntimeConfig } from "../config/types.durable.js";
import { isDurableAuthorityEnabled, isDurableRuntimeEnabled } from "../durable/config.js";
import { getDurableRuntimeHealthSnapshot } from "../durable/health.js";
import {
  formatDurableInspectionStoreError,
  projectDurableDeliveryAttempt,
  projectDurableHealthSnapshot,
  projectDurableObligation,
  projectDurableRunInspection,
  projectDurableRunSummary,
  projectDurableStoreStats,
  projectDurableUncertainty,
  projectDurableWake,
  projectDurableWakeInspection,
  type DurableCoordinationProjection,
  type DurableDeliveryAttemptSummary,
  type DurableEventSummary,
  type DurableLinkSummary,
  type DurableObligationSummary,
  type DurablePublicStoreStats,
  type DurableRefSummary,
  type DurableRunInspection,
  type DurableRunSummary,
  type DurableSignalSummary,
  type DurableStepSummary,
  type DurableTimerSummary,
  type DurableUncertaintySummary,
  type DurableWakeInspectionSummary,
  type DurableWakeSummary,
} from "../durable/inspection-projection.js";
import { openDurableRuntimeStoreReadOnly } from "../durable/store-factory.js";
import type { DurableRuntimeReadStore } from "../durable/types.js";
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
  | "obligations"
  | "wakes"
  | "wake"
  | "uncertainty"
  | "delivery-attempts"
  | "why"
  | "stats"
  | "health";

export type DurableCliOptions = {
  action: DurableCliAction;
  runtimeRunId?: string;
  json?: boolean;
  limit?: number;
  durableConfig?: DurableRuntimeConfig;
  env?: NodeJS.ProcessEnv;
};

type DurableRunDetails = DurableRunInspection;

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

function reportDurableInspectionFailure(
  opts: DurableCliOptions,
  runtime: RuntimeEnv,
  error: unknown,
): void {
  const message = formatDurableInspectionStoreError(error);
  if (opts.json) {
    writeJson(runtime, { error: message });
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
}

function formatTime(value?: number): string {
  return value ? new Date(value).toISOString() : "-";
}

function parseLimit(value: number | undefined): number {
  return Math.max(1, Math.min(500, Math.trunc(value ?? 50)));
}

function renderObligations(obligations: DurableObligationSummary[]): string {
  if (obligations.length === 0) {
    return "No unresolved durable obligations.";
  }
  return obligations
    .map((obligation) => {
      const reason = obligation.reason ? ` reason=${obligation.reason}` : "";
      return `${obligation.obligationId} ${obligation.kind}/${obligation.status} source=${obligation.sourceOwner}:${obligation.sourceRef} updated=${formatTime(obligation.updatedAt)}${reason}`;
    })
    .join("\n");
}

function renderWakes(wakes: DurableWakeSummary[]): string {
  if (wakes.length === 0) {
    return "No durable wake obligations.";
  }
  return wakes
    .map(
      (wake) =>
        `${wake.wakeId} ${wake.reason}/${wake.status} source=${wake.sourceOwner}:${wake.sourceRef} attempts=${wake.attemptCount} updated=${formatTime(wake.updatedAt)}`,
    )
    .join("\n");
}

function renderUncertaintyFacts(facts: DurableUncertaintySummary[]): string {
  if (facts.length === 0) {
    return "No unresolved durable uncertainty facts.";
  }
  return facts
    .map(
      (fact) =>
        `${fact.factId} ${fact.kind}/${fact.status} source=${fact.sourceOwner}:${fact.sourceRef} updated=${formatTime(fact.updatedAt)}`,
    )
    .join("\n");
}

function renderDeliveryAttempts(attempts: DurableDeliveryAttemptSummary[]): string {
  if (attempts.length === 0) {
    return "No delivery attempt evidence.";
  }
  return attempts
    .map((attempt) => {
      const error = attempt.error ? ` error=${attempt.error}` : "";
      return `${attempt.deliveryAttemptId} ${attempt.status} source=${attempt.sourceOwner}:${attempt.sourceRef} scheduled=${formatTime(attempt.scheduledAt)}${error}`;
    })
    .join("\n");
}

function renderWakeInspection(inspection: DurableWakeInspectionSummary): string {
  const { wake } = inspection;
  return [
    `Wake: ${wake.wakeId}`,
    `Status: ${wake.status}`,
    `Reason: ${wake.reason}`,
    `Source: ${wake.sourceOwner}:${wake.sourceRef}`,
    `Target: ${inspection.targetResolution.status ?? "unresolved"}${inspection.targetResolution.targetRef ? ` ${inspection.targetResolution.targetRef}` : ""}`,
    `Delivery attempts: ${inspection.deliveryAttempts.length}`,
    `Open uncertainty facts: ${inspection.unresolvedUncertainty.length}`,
  ].join("\n");
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
  store: DurableRuntimeReadStore,
  runtimeRunId: string,
): DurableRunDetails | undefined {
  const run = store.getRun(runtimeRunId);
  if (!run) {
    return undefined;
  }
  return projectDurableRunInspection({
    run,
    steps: store.listSteps(runtimeRunId),
    children: store.listChildLinks(runtimeRunId),
    parents: store.listParentLinks(runtimeRunId),
    signals: store.listSignals(runtimeRunId),
    refs: store.listRefs(runtimeRunId),
    timers: store.listTimers(runtimeRunId),
    timeline: store.getTimeline(runtimeRunId),
  });
}

function summarizeRun(run: DurableRunSummary): string {
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

function recoveryDiagnosticSummary(run: DurableRunSummary): string | undefined {
  if (!run.recovery) {
    return undefined;
  }
  const parts = [`recovery=${run.recovery.state}`];
  if (run.recovery.reason) {
    parts.push(`reason=${run.recovery.reason}`);
  }
  parts.push(`next=${run.recovery.nextAction}`);
  return parts.join(" ");
}

function renderRuns(runs: DurableRunSummary[]): string {
  if (runs.length === 0) {
    return "No durable runtime runs found.";
  }
  return runs.map(summarizeRun).join("\n");
}

function renderTimeline(events: DurableEventSummary[]): string {
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

function renderSteps(steps: DurableStepSummary[]): string {
  if (steps.length === 0) {
    return "No durable runtime steps found.";
  }
  return steps
    .map((step) => {
      return [
        step.stepId,
        step.stepType,
        `${step.status}/${step.recoveryState}`,
        `attempt=${step.attempt}`,
        step.heartbeatAt ? `heartbeat=${formatTime(step.heartbeatAt)}` : "",
        step.outputRef ? `output=${step.outputRef}` : "",
        step.errorRef ? `error=${step.errorRef}` : "",
      ]
        .filter(Boolean)
        .join("  ");
    })
    .join("\n");
}

function renderLinks(links: DurableLinkSummary[], direction: "children" | "parents"): string {
  if (links.length === 0) {
    return `No durable runtime ${direction} found.`;
  }
  return links
    .map((link) => {
      return [
        direction === "children"
          ? `child=${link.childRuntimeRunId}`
          : `parent=${link.parentRuntimeRunId}`,
        `step=${link.parentStepId}`,
        link.linkType,
        link.status,
        `updated=${formatTime(link.updatedAt)}`,
      ]
        .filter(Boolean)
        .join("  ");
    })
    .join("\n");
}

function renderSignals(signals: DurableSignalSummary[]): string {
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

function renderRefs(refs: DurableRefSummary[]): string {
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
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}

function renderTimers(timers: DurableTimerSummary[]): string {
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
  if (projection.waitingReason === "signal") {
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
  const projection = details.coordination;
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
  lines.push("Inspect:");
  for (const command of payload.commands) {
    lines.push(`- ${command}`);
  }
  return lines.join("\n");
}

export async function durableCommand(opts: DurableCliOptions, runtime: RuntimeEnv): Promise<void> {
  const env = opts.env ?? process.env;
  if (!isDurableRuntimeEnabled(opts.durableConfig)) {
    if (opts.json) {
      writeJson(runtime, { enabled: false });
    } else {
      write(
        runtime,
        "Durable runtime is disabled. Set durable.mode to observe or authority to inspect durable state.",
      );
    }
    runtime.exit(1);
    return;
  }

  if (opts.action === "health") {
    const health: {
      enabled: true;
      authority: boolean;
      ready: boolean;
      process: ReturnType<typeof getDurableRuntimeHealthSnapshot>;
      store?: DurablePublicStoreStats;
      storeError?: string;
    } = {
      enabled: true,
      authority: isDurableAuthorityEnabled(opts.durableConfig),
      ready: false,
      process: projectDurableHealthSnapshot(getDurableRuntimeHealthSnapshot()),
    };
    try {
      const store = openDurableRuntimeStoreReadOnly({ env });
      try {
        health.store = projectDurableStoreStats(store.getStats());
        health.ready = true;
      } finally {
        store.close();
      }
    } catch (error) {
      health.storeError = formatDurableInspectionStoreError(error);
    }
    if (opts.json) {
      writeJson(runtime, health);
    } else if (health.store) {
      write(
        runtime,
        `Durable runtime: ${health.process.status} authority=${yesNo(health.authority)} ready=yes open_runs=${health.store.openRuns} pending_wakes=${health.store.pendingWakes} unresolved_uncertainty=${health.store.unresolvedUncertaintyFacts}`,
      );
    } else {
      write(
        runtime,
        `Durable runtime: degraded authority=${yesNo(health.authority)} ready=no store_error=${health.storeError ?? "unavailable"}`,
      );
    }
    return;
  }

  let store: DurableRuntimeReadStore | undefined;
  try {
    store = openDurableRuntimeStoreReadOnly({ env });
    if (opts.action === "stats") {
      const stats = projectDurableStoreStats(store.getStats());
      if (opts.json) {
        writeJson(runtime, stats);
      } else {
        write(
          runtime,
          `Durable runtime store: runs=${stats.runs} open=${stats.openRuns} steps=${stats.steps} events=${stats.events}`,
        );
      }
      return;
    }

    if (opts.action === "runs") {
      const runs = store
        .listRuns({ limit: parseLimit(opts.limit) })
        .map((run) => projectDurableRunSummary({ run }));
      if (opts.json) {
        writeJson(runtime, runs);
      } else {
        write(runtime, renderRuns(runs));
      }
      return;
    }

    if (opts.action === "obligations") {
      const obligations = store
        .listUnresolvedObligations({ limit: parseLimit(opts.limit) })
        .map(projectDurableObligation);
      if (opts.json) {
        writeJson(runtime, obligations);
      } else {
        write(runtime, renderObligations(obligations));
      }
      return;
    }

    if (opts.action === "wakes") {
      const wakes = store
        .listWakeObligations({ limit: parseLimit(opts.limit) })
        .map(projectDurableWake);
      if (opts.json) {
        writeJson(runtime, wakes);
      } else {
        write(runtime, renderWakes(wakes));
      }
      return;
    }

    if (opts.action === "uncertainty") {
      const facts = store
        .listUnresolvedUncertaintyFacts({ limit: parseLimit(opts.limit) })
        .map(projectDurableUncertainty);
      if (opts.json) {
        writeJson(runtime, facts);
      } else {
        write(runtime, renderUncertaintyFacts(facts));
      }
      return;
    }

    if (opts.action === "wake" || opts.action === "delivery-attempts") {
      const wakeId = opts.runtimeRunId?.trim();
      if (!wakeId) {
        runtime.error("A wake obligation id is required.");
        runtime.exit(1);
        return;
      }
      if (opts.action === "wake") {
        const inspection = store.getWakeObligationInspection(wakeId);
        if (!inspection) {
          runtime.error(`Wake obligation not found: ${wakeId}`);
          runtime.exit(1);
          return;
        }
        const projected = projectDurableWakeInspection(inspection);
        if (opts.json) {
          writeJson(runtime, projected);
        } else {
          write(runtime, renderWakeInspection(projected));
        }
        return;
      }
      const attempts = store
        .listDeliveryAttemptEvidence({ wakeId, limit: parseLimit(opts.limit) })
        .map(projectDurableDeliveryAttempt);
      if (opts.json) {
        writeJson(runtime, attempts);
      } else {
        write(runtime, renderDeliveryAttempts(attempts));
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
            ? details.coordination
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
            ? JSON.stringify(details.coordination, null, 2)
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
  } catch (error) {
    reportDurableInspectionFailure(opts, runtime, error);
  } finally {
    try {
      store?.close();
    } catch {
      // A read-only close failure must not expose local storage diagnostics to CLI callers.
    }
  }
}
