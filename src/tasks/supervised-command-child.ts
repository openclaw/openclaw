import { getProcessSupervisor } from "../process/supervisor/index.js";

/** Trusted wrappers use the same required-all transport as the payload. A
 * wrapper's exit is not proof that its descendants have stopped. */
export async function runSupervisedCommandChild(params: {
  id: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  assertCurrent: () => void;
  keepInputOpen?: boolean;
  outputLimit?: number;
  onTransportExtinct?: () => void;
}) {
  const supervisor = getProcessSupervisor();
  const cleanup = supervisor.acquireScopeCleanup(params.id, { processTree: "required-all" });
  let open = true;
  const assertCurrent = () => {
    if (!open) {
      throw new Error("Command child custody closed");
    }
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  try {
    assertCurrent();
    const run = await supervisor.spawn({
      mode: "child",
      runId: params.id,
      scopeKey: params.id,
      argv: params.argv,
      cwd: params.cwd,
      env: params.env,
      exactEnv: true,
      stdinMode: params.keepInputOpen ? "pipe-open" : "pipe-closed",
      timeoutMs: params.timeoutMs,
      maxCapturedOutputChars: params.outputLimit ?? 6000,
      assertCurrent,
    });
    const cancel = () => run.cancel("manual-cancel");
    params.signal.addEventListener("abort", cancel, { once: true });
    if (params.signal.aborted) {
      cancel();
    }
    try {
      const result = await run.wait();
      if (!run.waitForExtinction) {
        throw new Error("Command transport lacks extinction proof");
      }
      await run.waitForExtinction();
      return result;
    } finally {
      params.signal.removeEventListener("abort", cancel);
    }
  } finally {
    open = false;
    await cleanup();
    params.onTransportExtinct?.();
  }
}
