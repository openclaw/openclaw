// Shared startup tracing for the entry wrapper and CLI dispatcher.
import process from "node:process";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";

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
  if (!isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE)) {
    return await run();
  }
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    const completedAt = performance.now();
    const facts = metrics?.() ?? {};
    recordGatewayBootstrapStep(name, startedAt, completedAt, facts);
    const { formatConsoleDiagnosticLine } = await import("../logging/json-console-line.js");
    const counts = Object.entries(facts)
      .map(([key, value]) => ` ${key}=${value}`)
      .join("");
    const message = `[gateway] startup trace: ${name} ${(completedAt - startedAt).toFixed(1)}ms total=${completedAt.toFixed(1)}ms start=${startedAt.toFixed(1)}ms${counts}`;
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
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
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
  const emit = (name: string, durationMs: number, completedAt: number) => {
    if (!enabled) {
      return;
    }
    const startedAt = completedAt - durationMs;
    recordGatewayBootstrapStep(`${source}.${name}`, startedAt, completedAt);
    writeMessage(
      `[gateway] startup trace: ${source}.${name} ${durationMs.toFixed(1)}ms total=${completedAt.toFixed(1)}ms start=${startedAt.toFixed(1)}ms`,
    );
  };
  return {
    enabled,
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
      let bufferCompletedTimelineSpan = false;
      let completed = false;
      try {
        if (timelineModule && options.timeline !== false) {
          await flushPendingTimelineEvents();
          const module = await timelineModule;
          if (module && timelineActivation === "enabled") {
            await pendingTimelineWrites;
            return await module.measureDiagnosticsTimelineSpan(
              timelineName(name),
              () => Promise.resolve(run()),
              {
                phase: CLI_STARTUP_TIMELINE_PHASE,
                ...(timelineConfig ? { config: timelineConfig } : {}),
                env: process.env,
              },
            );
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
        emit(name, now - before, now);
        last = now;
      }
    },
  };
}

export async function configureGatewayStartupTraceConsoleFormatting(
  trace: ReturnType<typeof createGatewayDispatchStartupTrace>,
): Promise<void> {
  if (!trace.enabled) {
    return;
  }
  const { formatConsoleDiagnosticLine } = await import("../logging/json-console-line.js");
  trace.setLineFormatter((message) => formatConsoleDiagnosticLine({ level: "info", message }));
}
