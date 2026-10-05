// Shared startup tracing for the entry wrapper and CLI dispatcher.
import process from "node:process";
import { isForegroundGatewayRunArgv } from "../../gateway-run-argv.mjs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  isUpdateCanaryStartupMilestone,
  supportsUpdateCanaryProgress,
  UPDATE_CANARY_PROGRESS_PREFIX,
} from "../infra/update-candidate-canary-progress.js";

type GatewayStartupTraceSource = "entry" | "cli.main";
type GatewayStartupTraceLineFormatter = (message: string) => string;
type DiagnosticsTimelineModule = typeof import("../infra/diagnostics-timeline.js");
type StartupTraceMeasureOptions = {
  timeline?: boolean;
};
type PendingTimelineEvent =
  | {
      type: "mark";
      name: string;
      durationMs: number;
      totalMs: number;
    }
  | {
      type: "span";
      name: string;
      durationMs: number;
    };

const CLI_STARTUP_TIMELINE_PHASE = "cli.startup";
const STARTUP_PROGRESS_PHASES = new Set([
  "entry.run-main-import",
  "cli.main.gateway-run-select-environment",
  "cli.main.gateway-run-imports",
  "cli.main.gateway-run-pre-bootstrap",
  "cli.main.gateway-run-bootstrap",
  "cli.main.gateway-run-reload-environment",
]);
const BOOTSTRAP_PROGRESS_PHASES = new Set([
  "cli.bootstrap.admission.database-readiness",
  "gateway.server-start-import",
]);

type GatewayBootstrapStep = {
  name: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  calls: number;
  metrics: Record<string, number>;
};

const MAX_BOOTSTRAP_STEPS = 128;
let bootstrapSteps: Map<string, GatewayBootstrapStep> | undefined = new Map();

/** Collect process facts once; Gateway startup consumes them before serving. */
export function recordGatewayBootstrapStep(
  name: string,
  startedAt: number,
  completedAt: number,
  metrics: Readonly<Record<string, number>> = {},
): void {
  if (!bootstrapSteps || !isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE)) {
    return;
  }
  const stepName =
    bootstrapSteps.has(name) || bootstrapSteps.size < MAX_BOOTSTRAP_STEPS ? name : "omitted-steps";
  let step = bootstrapSteps.get(stepName);
  if (!step) {
    step = { name: stepName, startedAt, completedAt, durationMs: 0, calls: 0, metrics: {} };
    bootstrapSteps.set(stepName, step);
  }
  step.startedAt = Math.min(step.startedAt, startedAt);
  step.completedAt = Math.max(step.completedAt, completedAt);
  step.durationMs += completedAt - startedAt;
  step.calls += 1;
  for (const [key, value] of Object.entries(metrics)) {
    step.metrics[key] = (step.metrics[key] ?? 0) + value;
  }
}

export function consumeGatewayBootstrapSteps(): GatewayBootstrapStep[] {
  const steps = [...(bootstrapSteps?.values() ?? [])];
  bootstrapSteps = undefined;
  return steps.toSorted((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
}

export async function measureGatewayBootstrapStep<T>(
  name: string,
  run: () => T | Promise<T>,
  metrics?: () => Readonly<Record<string, number>>,
): Promise<T> {
  const traceEnabled = isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE);
  const progressEnabled =
    BOOTSTRAP_PROGRESS_PHASES.has(name) ||
    (isForegroundGatewayRunArgv(process.argv) &&
      (name.startsWith("cli.bootstrap.") ||
        name === "cli.command.config-ready" ||
        name === "cli.command.config-guard-import"));
  if (!traceEnabled && !progressEnabled) {
    return await run();
  }
  const startedAt = performance.now();
  const { formatConsoleDiagnosticLine } = await import("../logging/json-console-line.js");
  if (progressEnabled) {
    process.stderr.write(
      `${formatConsoleDiagnosticLine({ level: "info", message: `[gateway] startup phase: ${name} starting total=${startedAt.toFixed(1)}ms` })}\n`,
    );
  }
  try {
    return await run();
  } finally {
    const completedAt = performance.now();
    const facts = metrics?.() ?? {};
    recordGatewayBootstrapStep(name, startedAt, completedAt, facts);
    const counts = Object.entries(facts)
      .map(([key, value]) => ` ${key}=${value}`)
      .join("");
    const message = `[gateway] startup ${traceEnabled ? "trace" : "phase"}: ${name} ${(completedAt - startedAt).toFixed(1)}ms total=${completedAt.toFixed(1)}ms start=${startedAt.toFixed(1)}ms${counts}`;
    process.stderr.write(`${formatConsoleDiagnosticLine({ level: "info", message })}\n`);
  }
}

function hasDiagnosticsTimelinePath(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH?.trim());
}

export function createGatewayDispatchStartupTrace(
  argv: string[],
  source: GatewayStartupTraceSource,
): {
  enabled: boolean;
  consoleEnabled: boolean;
  requiresDiagnosticsConfig(): Promise<boolean>;
  configureDiagnosticsTimeline(config: OpenClawConfig): Promise<void>;
  setLineFormatter(formatter: GatewayStartupTraceLineFormatter): void;
  mark(name: string): void;
  measure<T>(
    name: string,
    run: () => T | PromiseLike<T>,
    options?: StartupTraceMeasureOptions,
  ): Promise<T>;
} {
  const gatewayInvocation = argv.slice(2).includes("gateway");
  const enabled = isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) && gatewayInvocation;
  const progressEnabled = isForegroundGatewayRunArgv(argv);
  const updateCanary = gatewayInvocation && supportsUpdateCanaryProgress(argv);
  const started = performance.now();
  if (source === "entry" && enabled) {
    bootstrapSteps = new Map();
    recordGatewayBootstrapStep("entry.imports", 0, started);
  }
  let last = started;
  let lineFormatter: GatewayStartupTraceLineFormatter | null = null;
  let pendingMessages: string[] = [];
  const timelineModule = hasDiagnosticsTimelinePath(process.env)
    ? import("../infra/diagnostics-timeline.js").catch(() => null)
    : null;
  let timelineActivation: "unknown" | "enabled" | "disabled" = timelineModule
    ? "unknown"
    : "disabled";
  let timelineConfig: OpenClawConfig | undefined;
  let timelineConfigResolved = false;
  const pendingTimelineEvents: PendingTimelineEvent[] = [];
  let pendingTimelineWrites = Promise.resolve();
  const timelineName = (name: string) => `${source}.${name}`;
  const resolveTimelineActivation = async (): Promise<typeof timelineActivation> => {
    if (timelineActivation !== "unknown" || !timelineModule) {
      return timelineActivation;
    }
    const module = await timelineModule;
    if (!module) {
      timelineActivation = "disabled";
      return timelineActivation;
    }
    if (module.isDiagnosticsTimelineEnabled({ env: process.env })) {
      timelineActivation = "enabled";
      return timelineActivation;
    }
    if (timelineConfigResolved) {
      timelineActivation = module.isDiagnosticsTimelineEnabled({
        config: timelineConfig,
        env: process.env,
      })
        ? "enabled"
        : "disabled";
    }
    return timelineActivation;
  };
  const writeTimelineEvent = (
    module: DiagnosticsTimelineModule,
    event: PendingTimelineEvent,
  ): void => {
    const commonOptions = {
      ...(timelineConfig ? { config: timelineConfig } : {}),
      env: process.env,
    };
    if (event.type === "mark") {
      module.emitDiagnosticsTimelineEvent(
        {
          type: "mark",
          name: event.name,
          phase: CLI_STARTUP_TIMELINE_PHASE,
          durationMs: event.durationMs,
          attributes: { totalMs: event.totalMs },
        },
        commonOptions,
      );
      return;
    }
    module.emitCompletedDiagnosticsTimelineSpan(event.name, event.durationMs, {
      phase: CLI_STARTUP_TIMELINE_PHASE,
      ...commonOptions,
    });
  };
  const flushPendingTimelineEvents = async (): Promise<void> => {
    const activation = await resolveTimelineActivation();
    if (activation === "unknown") {
      return;
    }
    if (activation === "disabled") {
      pendingTimelineEvents.length = 0;
      return;
    }
    const module = await timelineModule;
    if (!module) {
      pendingTimelineEvents.length = 0;
      return;
    }
    const events = pendingTimelineEvents.splice(0);
    for (const event of events) {
      writeTimelineEvent(module, event);
    }
  };
  const enqueueTimelineEvent = (event: PendingTimelineEvent): void => {
    if (!timelineModule || timelineActivation === "disabled") {
      return;
    }
    if (timelineActivation === "unknown") {
      pendingTimelineEvents.push(event);
      return;
    }
    pendingTimelineWrites = pendingTimelineWrites.then(async () => {
      const module = await timelineModule;
      if (module) {
        writeTimelineEvent(module, event);
      }
    });
  };
  const flushPending = (formatter: GatewayStartupTraceLineFormatter) => {
    const queued = pendingMessages;
    pendingMessages = [];
    for (const message of queued) {
      process.stderr.write(`${formatter(message)}\n`);
    }
  };
  const flushPendingPlainOnExit = () => {
    if (!lineFormatter) {
      flushPending((message) => message);
    }
  };
  if (enabled) {
    // Direct process.exit paths cannot await config-backed formatting. Never
    // silently lose explicitly requested trace records on an unknown early exit.
    process.once("exit", flushPendingPlainOnExit);
  }
  const writeMessage = (message: string) => {
    if (!lineFormatter) {
      pendingMessages.push(message);
      return;
    }
    process.stderr.write(`${lineFormatter(message)}\n`);
  };
  const emit = (name: string, durationMs: number, completedAt: number, completed = true) => {
    const milestone = `${source}.${name}`;
    if (updateCanary && completed && isUpdateCanaryStartupMilestone(milestone)) {
      process.stderr.write(`${UPDATE_CANARY_PROGRESS_PREFIX}${milestone}\n`);
    }
    if (!enabled && !(progressEnabled && STARTUP_PROGRESS_PHASES.has(milestone))) {
      return;
    }
    const startedAt = completedAt - durationMs;
    recordGatewayBootstrapStep(`${source}.${name}`, startedAt, completedAt);
    writeMessage(
      `[gateway] startup ${enabled ? "trace" : "phase"}: ${source}.${name} ${durationMs.toFixed(1)}ms total=${completedAt.toFixed(1)}ms start=${startedAt.toFixed(1)}ms${completed ? "" : " failed"}`,
    );
  };
  return {
    enabled,
    consoleEnabled: enabled || progressEnabled,
    async requiresDiagnosticsConfig() {
      await flushPendingTimelineEvents();
      return timelineActivation === "unknown";
    },
    async configureDiagnosticsTimeline(config) {
      timelineConfig = config;
      timelineConfigResolved = true;
      await flushPendingTimelineEvents();
      await pendingTimelineWrites;
    },
    setLineFormatter(formatter) {
      lineFormatter = formatter;
      process.off("exit", flushPendingPlainOnExit);
      flushPending(formatter);
    },
    mark(name: string) {
      const now = performance.now();
      const durationMs = now - last;
      const totalMs = now - started;
      emit(name, durationMs, now);
      enqueueTimelineEvent({
        type: "mark",
        name: timelineName(name),
        durationMs,
        totalMs,
      });
      last = now;
    },
    async measure<T>(
      name: string,
      run: () => T | PromiseLike<T>,
      options: StartupTraceMeasureOptions = {},
    ): Promise<T> {
      const before = performance.now();
      if (progressEnabled && STARTUP_PROGRESS_PHASES.has(timelineName(name))) {
        writeMessage(
          `[gateway] startup phase: ${timelineName(name)} starting total=${before.toFixed(1)}ms`,
        );
      }
      let bufferCompletedTimelineSpan = false;
      let completed = false;
      try {
        if (timelineModule && options.timeline !== false) {
          await flushPendingTimelineEvents();
          const module = await timelineModule;
          if (module && timelineActivation === "enabled") {
            await pendingTimelineWrites;
            const result = await module.measureDiagnosticsTimelineSpan(
              timelineName(name),
              () => Promise.resolve(run()),
              {
                phase: CLI_STARTUP_TIMELINE_PHASE,
                ...(timelineConfig ? { config: timelineConfig } : {}),
                env: process.env,
              },
            );
            completed = true;
            return result;
          }
          bufferCompletedTimelineSpan = timelineActivation === "unknown";
        }
        const result = await run();
        completed = true;
        return result;
      } finally {
        const now = performance.now();
        if (bufferCompletedTimelineSpan && completed) {
          enqueueTimelineEvent({
            type: "span",
            name: timelineName(name),
            durationMs: now - before,
          });
        }
        emit(name, now - before, now, completed);
        last = now;
      }
    },
  };
}

export async function configureCliStartupDiagnostics(
  traces: Array<ReturnType<typeof createGatewayDispatchStartupTrace> | undefined>,
  readConfig?: () => Promise<OpenClawConfig>,
): Promise<void> {
  const activeTraces = traces.filter(
    (trace): trace is ReturnType<typeof createGatewayDispatchStartupTrace> => Boolean(trace),
  );
  if (
    !(await Promise.all(activeTraces.map((trace) => trace.requiresDiagnosticsConfig()))).some(
      Boolean,
    )
  ) {
    return;
  }
  const { withConsoleLogsRoutedToStderr } = await import("./json-output-mode.js");
  const { readSourceConfigBestEffort } = await import("../config/io.js");
  // Clients need authored flags; Gateway admission supplies its isolated config reader.
  const config = await withConsoleLogsRoutedToStderr(readConfig ?? readSourceConfigBestEffort);
  await Promise.all(activeTraces.map((trace) => trace.configureDiagnosticsTimeline(config)));
}

export async function prepareGatewayStartupTraceConsoleFormatting(
  trace: ReturnType<typeof createGatewayDispatchStartupTrace>,
): Promise<() => void> {
  if (!trace.consoleEnabled) {
    return () => {};
  }
  const { formatConsoleDiagnosticLine } = await import("../logging/json-console-line.js");
  return () =>
    trace.setLineFormatter((message) => formatConsoleDiagnosticLine({ level: "info", message }));
}

export async function configureGatewayStartupTraceConsoleFormatting(
  trace: ReturnType<typeof createGatewayDispatchStartupTrace>,
): Promise<void> {
  (await prepareGatewayStartupTraceConsoleFormatting(trace))();
}
