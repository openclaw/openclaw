import { availableParallelism, cpus } from "node:os";
import { threadId } from "node:worker_threads";
import { afterAll, beforeAll } from "vitest";

type DiagnosticFile =
  | "src/gateway/server-agent-database-startup.test.ts"
  | "src/gateway/server-aux-methods.test.ts"
  | "src/gateway/server-chat.agent-events.test.ts"
  | "src/gateway/server-close.model-acquisition.test.ts"
  | "src/gateway/server-run-shutdown.recovery.test.ts";

// Temporary diagnosis: keep the original five-file worker envelope observable.
export function registerStartupHttpDiagnostic(file: DiagnosticFile) {
  const stamp = (phase: "suite-start-hook" | "suite-end-hook") => {
    try {
      console.error(
        "[startup-http-worker]",
        JSON.stringify({
          phase,
          file,
          pid: process.pid,
          threadId,
          workerId: /^\d+$/.test(process.env.VITEST_WORKER_ID ?? "")
            ? Number(process.env.VITEST_WORKER_ID)
            : null,
          poolId: /^\d+$/.test(process.env.VITEST_POOL_ID ?? "")
            ? Number(process.env.VITEST_POOL_ID)
            : null,
          timeMs: Date.now(),
        }),
      );
    } catch {
      // Diagnostic output cannot replace a suite's original result.
    }
  };
  beforeAll(() => {
    const runtime = {
      node: process.versions.node,
      cpus: cpus().length,
      availableParallelism: availableParallelism(),
    };
    try {
      console.error("[startup-http-runtime]", JSON.stringify({ file, ...runtime }));
    } catch {
      // Admission still checks the observed values when logging is unavailable.
    }
    if (runtime.node !== "24.21.0" || runtime.cpus !== 4 || runtime.availableParallelism !== 4) {
      throw new Error(
        "HTTP_DIAG_RUNTIME_MISMATCH requires Node 24.21.0 and actual CPU counts of 4",
      );
    }
    stamp("suite-start-hook");
  });
  // This hook marks ordering only; other teardown hooks may still own cleanup.
  afterAll(() => stamp("suite-end-hook"));
}
