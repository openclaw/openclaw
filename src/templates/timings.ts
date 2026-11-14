import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/templates-add/timing");
const timingContext = new AsyncLocalStorage<{
  requestId: string;
  started: number;
  sequence: number;
}>();

/** Correlate measured work without logging prompts, tool contents, credentials or paths. */
export async function withTemplateAddTimings<T>(
  requestId: string,
  run: () => Promise<T>,
): Promise<T> {
  return await timingContext.run({ requestId, started: performance.now(), sequence: 0 }, () =>
    measureTemplateAddStage("add.total", run),
  );
}

export function startTemplateAddStage(stage: string, counts: Record<string, number> = {}) {
  const context = timingContext.getStore();
  const started = performance.now();
  const spanId = context ? ++context.sequence : 0;
  let ended = false;
  const record = (phase: string, outcome?: "ok" | "error") => {
    if (!context) {
      return;
    }
    log.debug("Template Add timing", {
      requestId: context.requestId,
      spanId,
      stage,
      phase,
      elapsedMs: Math.round((performance.now() - context.started) * 100) / 100,
      ...(outcome
        ? { outcome, durationMs: Math.round((performance.now() - started) * 100) / 100 }
        : {}),
      ...counts,
    });
  };
  record("start");
  const end = (outcome: "ok" | "error") => {
    if (!ended) {
      ended = true;
      record("end", outcome);
    }
  };
  return { end, [Symbol.dispose]: () => end("error") };
}

export async function measureTemplateAddStage<T>(
  stage: string,
  run: () => Promise<T>,
  counts?: Record<string, number>,
): Promise<T> {
  using timing = startTemplateAddStage(stage, counts);
  const result = await run();
  timing.end("ok");
  return result;
}
