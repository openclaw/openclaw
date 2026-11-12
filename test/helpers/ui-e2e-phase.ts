import { mkdirSync, mkdtempSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

type UiE2ePhase =
  | "suite-setup"
  | "suite-cleanup"
  | "context-setup"
  | "context-cleanup"
  | "test-callback"
  | "scenario-cleanup"
  | "gateway-start-queue"
  | "gateway-start"
  | "gateway-readiness"
  | "gateway-stop"
  | "gateway-cleanup";

const noTiming = () => {};

/** Completed worker-local intervals; nested phases must not be summed. */
export function beginUiE2ePhase(phase: UiE2ePhase | undefined): () => void {
  if (!phase || !process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR?.trim()) {
    return noTiming;
  }
  const startMs = performance.timeOrigin + performance.now();
  return () => {
    const endMs = performance.timeOrigin + performance.now();
    try {
      writeSync(
        2,
        `[control-ui-e2e-phase] ${JSON.stringify({ phase, pid: process.pid, startMs, endMs })}\n`,
      );
    } catch {
      // Diagnostics must preserve the operation's result, including cleanup failures.
    }
  };
}

export type UiE2eSetupStage =
  | "server-start"
  | "ui-assets"
  | "test-state-import"
  | "test-state"
  | "http-import"
  | "http-ready"
  | "browser-launch";
export type UiE2eSetupObserver = {
  run: <T>(
    stage: UiE2eSetupStage,
    run: () => Promise<T>,
    facts?: { prebuiltAssets?: boolean },
  ) => Promise<T>;
  report: () => void;
};

/** Static test-source stages only; never application content, human identities or raw errors. */
export function createUiE2eSetupObserver(source: string): UiE2eSetupObserver {
  const root = process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR?.trim();
  if (!root) {
    return { run: (_stage, run) => run(), report: noTiming };
  }
  const events: Array<{
    stage: UiE2eSetupStage;
    edge: "enter" | "exit";
    atMs: number;
    prebuiltAssets?: boolean;
  }> = [];
  let artifact: string | undefined;
  const emit = (reason: "transition" | "teardown" | "process-exit") => {
    if (!events.length) {
      return;
    }
    const workers = Number(process.env.OPENCLAW_VITEST_MAX_WORKERS);
    const revision = process.env.GITHUB_SHA;
    const receipt = {
      kind: "ui-e2e-setup",
      source,
      reason,
      pid: process.pid,
      runtime: process.versions.bun ? "bun" : "node",
      version: process.versions.bun ?? process.version,
      revision: revision && /^[0-9a-f]{40}$/u.test(revision) ? revision : undefined,
      maxWorkers: Number.isInteger(workers) && workers > 0 ? workers : undefined,
      workerCache: process.env.OPENCLAW_VITEST_WORKER_CACHE === "1",
      events,
    };
    try {
      writeSync(2, "[control-ui-e2e-setup] " + JSON.stringify(receipt) + "\n");
      if (!artifact) {
        mkdirSync(root, { recursive: true });
        artifact = path.join(mkdtempSync(path.join(root, "failure-setup-")), "failure.public.json");
      }
      writeFileSync(artifact, JSON.stringify(receipt) + "\n");
    } catch {
      // Diagnostics cannot replace an acquisition or cleanup result.
    }
  };
  const record = (stage: UiE2eSetupStage, edge: "enter" | "exit", prebuiltAssets?: boolean) => {
    events.push({ stage, edge, atMs: performance.timeOrigin + performance.now(), prebuiltAssets });
    if (events.length > 24) {
      events.shift();
    }
    emit("transition");
  };
  // A timed-out setup may have no page or test callback. Keep its last stage in the final job tail.
  const onExit = () => emit("process-exit");
  process.once("exit", onExit);
  return {
    run: async (stage, run, facts) => {
      record(stage, "enter", facts?.prebuiltAssets);
      try {
        return await run();
      } finally {
        record(stage, "exit");
      }
    },
    report: () => {
      process.off("exit", onExit);
      emit("teardown");
    },
  };
}
