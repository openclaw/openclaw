import { isTruthyEnvValue } from "../../infra/env.js";
import { withDiagnosticPhase } from "../../logging/diagnostic-phase.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { recordGatewayBootstrapStep } from "../startup-trace.js";

type Awaitable<T> = T | Promise<T>;

export function createGatewayCliStartupTrace(log: Pick<SubsystemLogger, "info">) {
  const enabled = isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE);
  const started = performance.now();
  let last = started;
  const emit = (name: string, durationMs: number, completedAt: number) => {
    if (enabled) {
      const startedAt = completedAt - durationMs;
      recordGatewayBootstrapStep(name, startedAt, completedAt);
      log.info(
        `startup trace: ${name} ${durationMs.toFixed(1)}ms total=${completedAt.toFixed(1)}ms start=${startedAt.toFixed(1)}ms`,
      );
    }
  };
  const startMeasure = <T>(name: string, run: () => Awaitable<T>) => {
    const before = performance.now();
    let completedAt = before;
    let emitted = false;
    const result = withDiagnosticPhase(name, run).finally(() => {
      completedAt = performance.now();
    });
    // Attach both outcomes immediately so callers can finish terminal UI before
    // consuming or rethrowing the measured result without an unhandled rejection.
    const settled = result.then(
      () => {},
      () => {},
    );
    return {
      result,
      settled,
      emit() {
        if (emitted) {
          return;
        }
        emitted = true;
        emit(name, completedAt - before, completedAt);
        last = completedAt;
      },
    };
  };
  return {
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now);
      last = now;
    },
    startMeasure,
    async measure<T>(name: string, run: () => Awaitable<T>): Promise<T> {
      const measurement = startMeasure(name, run);
      try {
        return await measurement.result;
      } finally {
        await measurement.settled;
        measurement.emit();
      }
    },
  };
}
