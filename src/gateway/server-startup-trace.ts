import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { consumeGatewayBootstrapSteps } from "../cli/startup-trace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitDiagnosticsTimelineEvent,
  isDiagnosticsTimelineEnabled,
} from "../infra/diagnostics-timeline.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  isUpdateCanaryStartupMilestone,
  supportsUpdateCanaryProgress,
  UPDATE_CANARY_PROGRESS_PREFIX,
} from "../infra/update-candidate-canary-progress.js";
import { withDiagnosticPhase } from "../logging/diagnostic-phase.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { recordGatewayRestartTraceDetail, recordGatewayRestartTraceSpan } from "./restart-trace.js";

type GatewayLogger = ReturnType<typeof createSubsystemLogger>;
type Awaitable<T> = T | Promise<T>;
const TIMELINE_NAMES = new Map([
  ["config.snapshot", "config.load"],
  ["config.auth", "config.normalize"],
  ["runtime.config", "config.normalize"],
  ["plugins.bootstrap", "plugins.load"],
  ["runtime.post-attach", "gateway.ready"],
  ["ready", "gateway.ready"],
]);
const STARTUP_PROGRESS_PHASES = new Set([
  "process.bootstrap",
  "state.schema-preflight",
  "config.auth",
  "post-ready.startup-maintenance",
  "startup.maintenance.channels",
  "startup.maintenance.plugin-registry",
  "state.desktop-approval-admission",
  "sessions.admission",
  "startup.maintenance.sessions",
  "startup.maintenance.session-orphans",
  "startup.maintenance.session-transcripts",
  "startup.maintenance.pairing",
  "http.bound",
  "runtime.early",
  "runtime.early.discovery",
  "runtime.early.lazy-runtime-imports",
  "runtime.early.skills-listener",
  "post-attach.system-ca",
  "plugins.runtime-post-bind",
  "plugins.runtime-attach",
  "sidecars.worker-environments",
  "sidecars.internal-hooks",
  "sidecars.main-session-recovery",
  "sidecars.model-runtime",
  "sidecars.reply-runtime",
  "sidecars.chat-metadata",
  "sidecars.channels",
  "sidecars.plugin-services",
  "sidecars.subagent-recovery",
  "runtime.worker-pool-metrics",
  "ready",
]);

export type GatewayStartupTrace = {
  detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  mark: (name: string) => void;
  measure: <T>(name: string, run: () => Awaitable<T>) => Promise<T>;
};

export async function measureStartup<T>(
  startupTrace: GatewayStartupTrace | undefined,
  name: string,
  run: () => Awaitable<T>,
): Promise<T> {
  return startupTrace ? startupTrace.measure(name, run) : await run();
}

export function createGatewayStartupTrace(
  log: GatewayLogger,
  startedAt = performance.now(),
  updateCanary = false,
) {
  const progressEnabled = updateCanary && supportsUpdateCanaryProgress(process.argv);
  const logEnabled = isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE);
  let timelineConfig: OpenClawConfig | undefined;
  let eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | undefined;
  let closed = false;
  const timelineOptions = () => ({
    ...(timelineConfig ? { config: timelineConfig } : {}),
    env: process.env,
  });
  const eventLoopTimelineEnabled = () =>
    isDiagnosticsTimelineEnabled(timelineOptions()) &&
    isTruthyEnvValue(process.env.OPENCLAW_DIAGNOSTICS_EVENT_LOOP);
  const ensureEventLoopDelay = () => {
    if (closed || eventLoopDelay || (!logEnabled && !eventLoopTimelineEnabled())) {
      return;
    }
    eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    eventLoopDelay.enable();
  };
  ensureEventLoopDelay();
  const close = () => {
    eventLoopDelay?.disable();
    eventLoopDelay = undefined;
    closed = true;
  };
  const started = startedAt;
  let last = started;
  let spanSequence = 0;
  let bootstrapSummary = "";
  const reportProgress = (name: string) => {
    if (progressEnabled && !closed && isUpdateCanaryStartupMilestone(name)) {
      process.stderr.write(`${UPDATE_CANARY_PROGRESS_PREFIX}${name}\n`);
    }
  };
  const formatMetric = (key: string, value: number | string) =>
    `${key}=${typeof value === "number" ? value.toFixed(1) : value}`;
  const mapTimelineName = (name: string) => TIMELINE_NAMES.get(name) ?? name;
  const takeEventLoopSample = () => {
    if (!eventLoopDelay) {
      return undefined;
    }
    const sample = {
      p50Ms: eventLoopDelay.percentile(50) / 1_000_000,
      p95Ms: eventLoopDelay.percentile(95) / 1_000_000,
      p99Ms: eventLoopDelay.percentile(99) / 1_000_000,
      maxMs: eventLoopDelay.max / 1_000_000,
    };
    eventLoopDelay.reset();
    return sample;
  };
  const emitEventLoopTimelineSample = (
    activeSpanName: string,
    sample: ReturnType<typeof takeEventLoopSample>,
  ) => {
    if (!eventLoopTimelineEnabled() || !sample) {
      return;
    }
    emitDiagnosticsTimelineEvent(
      {
        type: "eventLoop.sample",
        name: "eventLoop",
        phase: "startup",
        activeSpanName: mapTimelineName(activeSpanName),
        attributes:
          activeSpanName === mapTimelineName(activeSpanName)
            ? undefined
            : { traceName: activeSpanName },
        ...sample,
      },
      timelineOptions(),
    );
  };
  const emit = (
    name: string,
    durationMs: number,
    totalMs: number,
    eventLoopSample: ReturnType<typeof takeEventLoopSample>,
    extras: ReadonlyArray<readonly [string, number | string]> = [],
  ) => {
    const metrics = [
      ["eventLoopMax", `${(eventLoopSample?.maxMs ?? 0).toFixed(1)}ms`] as const,
      ...extras,
    ];
    recordGatewayRestartTraceSpan(`restart.ready.${name}`, durationMs, totalMs, metrics);
    if (logEnabled) {
      log.info(
        `startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms ${metrics.map(([key, value]) => formatMetric(key, value)).join(" ")}`,
      );
    } else if (STARTUP_PROGRESS_PHASES.has(name)) {
      log.info(`startup phase: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`);
    }
  };
  return {
    close,
    setConfig(config: OpenClawConfig) {
      timelineConfig = config;
      ensureEventLoopDelay();
    },
    mark(name: string) {
      reportProgress(name);
      const now = performance.now();
      const eventLoopSample = takeEventLoopSample();
      if (name === "process.bootstrap") {
        const steps = consumeGatewayBootstrapSteps();
        bootstrapSummary = steps
          .map((step) => `${step.name}:${step.durationMs.toFixed(1)}ms/${step.calls}`)
          .join(",");
        for (const step of steps) {
          emit(`process.bootstrap.${step.name}`, step.durationMs, step.completedAt, undefined, [
            ["start", `${step.startedAt.toFixed(1)}ms`],
            ["calls", step.calls],
            ...Object.entries(step.metrics),
          ]);
        }
      }
      emit(
        name,
        now - last,
        now - started,
        eventLoopSample,
        bootstrapSummary && (name === "process.bootstrap" || name === "ready")
          ? [["bootstrapSteps", bootstrapSummary]]
          : [],
      );
      emitDiagnosticsTimelineEvent(
        {
          type: "mark",
          name: mapTimelineName(name),
          phase: "startup",
          durationMs: now - started,
          attributes: name === mapTimelineName(name) ? undefined : { traceName: name },
        },
        timelineOptions(),
      );
      emitEventLoopTimelineSample(name, eventLoopSample);
      last = now;
      if (name === "ready") {
        close();
      }
    },
    detail(name: string, metrics: ReadonlyArray<readonly [string, number | string]>) {
      const attributes = Object.fromEntries(metrics);
      recordGatewayRestartTraceDetail(`restart.ready.${name}`, metrics);
      if (logEnabled) {
        log.info(
          `startup trace: ${name} ${metrics.map(([key, value]) => formatMetric(key, value)).join(" ")}`,
        );
      }
      emitDiagnosticsTimelineEvent(
        {
          type: "mark",
          name: mapTimelineName(name),
          phase: "startup",
          attributes: { traceName: name, ...attributes },
        },
        timelineOptions(),
      );
    },
    async measure<T>(
      name: string,
      run: () => Promise<T> | T,
      options: { omitErrorMessage?: boolean } = {},
    ): Promise<T> {
      const before = performance.now();
      if (STARTUP_PROGRESS_PHASES.has(name)) {
        log.info(`startup phase: ${name} starting total=${(before - started).toFixed(1)}ms`);
      }
      const mappedName = mapTimelineName(name);
      const span = {
        name: mappedName,
        phase: "startup" as const,
        spanId: `gateway-startup-${++spanSequence}`,
        attributes: name === mappedName ? undefined : { traceName: name },
      };
      emitDiagnosticsTimelineEvent({ ...span, type: "span.start" }, timelineOptions());
      try {
        const result = await withDiagnosticPhase(mappedName, run, { traceName: name });
        reportProgress(name);
        const now = performance.now();
        emitDiagnosticsTimelineEvent(
          {
            ...span,
            type: "span.end",
            durationMs: now - before,
          },
          timelineOptions(),
        );
        return result;
      } catch (error) {
        const now = performance.now();
        emitDiagnosticsTimelineEvent(
          {
            ...span,
            type: "span.error",
            durationMs: now - before,
            errorName: error instanceof Error ? error.name : typeof error,
            ...(options.omitErrorMessage
              ? {}
              : { errorMessage: error instanceof Error ? error.message : String(error) }),
          },
          timelineOptions(),
        );
        throw error;
      } finally {
        const now = performance.now();
        const eventLoopSample = takeEventLoopSample();
        emit(name, now - before, now - started, eventLoopSample);
        emitEventLoopTimelineSample(name, eventLoopSample);
        last = now;
      }
    },
  };
}
