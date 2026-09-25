import { writeSync } from "node:fs";

let traceCleanup = 0;

function traceShutdown(phase: string, fixture: number, count: number) {
  if (!process.env.VITEST || process.env.OPENCLAW_GATEWAY_RESTART_TRACE !== "1") {
    return;
  }
  writeSync(
    2,
    `${JSON.stringify({ phase, fixture, count, pid: process.pid, time: Date.now() })}\n`,
  );
}

// Fixture cleanup must retain the synchronous owner even when startup rejects.
// Surface diagnostic errors without interpreting them as process liveness.
type StopOptions = { keepTemp?: boolean; preserveToDir?: string };

export async function runQaGatewayFixture<T>(
  body: () => Promise<T>,
  ...cleanups: Array<() => unknown>
): Promise<T> {
  const cleanup =
    process.env.VITEST && process.env.OPENCLAW_GATEWAY_RESTART_TRACE === "1" ? ++traceCleanup : 0;
  let phaseIndex = 0;
  const errors: unknown[] = [];
  const bodyResult = (async () => body())();
  // Keep cleanup phases ordered, but never let one failure skip later owners
  // or replace the startup/body error. Callers may settle a phase in parallel.
  for (const phase of [() => bodyResult, ...cleanups]) {
    traceShutdown("cleanup.phase.enter", cleanup, phaseIndex);
    try {
      await phase();
      traceShutdown("cleanup.phase.exit", cleanup, phaseIndex);
    } catch (error) {
      traceShutdown("cleanup.phase.reject", cleanup, phaseIndex);
      errors.push(error);
    }
    if (process.env.VITEST && process.env.OPENCLAW_GATEWAY_RESTART_TRACE === "1") {
      phaseIndex += 1;
    }
  }
  if (errors.length === 1 && errors[0] instanceof Error) {
    throw errors[0];
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "QA gateway fixture failed");
  }
  return bodyResult;
}

export async function stopQaGatewayFixture(
  owner: {
    stop(options?: StopOptions): Promise<{ errors: unknown[] }>;
  },
  options?: StopOptions,
): Promise<void> {
  const { errors } = await owner.stop(options);
  if (errors.length) {
    throw new AggregateError(errors, "QA gateway fixture cleanup failed");
  }
}
