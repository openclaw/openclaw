import { randomUUID } from "node:crypto";
import { resolveCurrentOpenClawCliInvocation } from "../infra/openclaw-cli-invocation.js";
import { getProcessSupervisor, type ManagedRun } from "../process/supervisor/index.js";

const MAX_JSON_CHARS = 32_768;
type ActiveLocalCliRun = { cancelled: boolean; run?: ManagedRun };

type LocalCliResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      reason: "busy" | "closed" | "cancelled" | "timeout" | "execution_failed" | "invalid_response";
    };

/** Fixed-command adapters own arguments and presentation; this owner never forwards raw output. */
export function createTuiLocalCliRunner() {
  const supervisor = getProcessSupervisor();
  const scopeKey = "tui-cli:" + randomUUID();
  const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
  let closed = false;
  let active: ActiveLocalCliRun | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const cancel = () => {
    if (!active) {
      return false;
    }
    active.cancelled = true;
    supervisor.cancelScope(scopeKey);
    return true;
  };

  const runJson = async (args: readonly string[]): Promise<LocalCliResult> => {
    if (closed) {
      return { ok: false, reason: "closed" };
    }
    if (active) {
      return { ok: false, reason: "busy" };
    }
    const owned: ActiveLocalCliRun = { cancelled: false };
    active = owned;
    let stdout = "";
    let overflow = false;
    try {
      const invocation = resolveCurrentOpenClawCliInvocation(args);
      owned.run = await supervisor.spawn({
        mode: "child",
        argv: [invocation.command, ...invocation.args],
        cwd: invocation.cwd,
        env: { ...process.env, ...invocation.env },
        scopeKey,
        stdinMode: "pipe-closed",
        timeoutMs: 120_000,
        captureOutput: false,
        assertCurrent: () => {
          if (closed || owned.cancelled) {
            throw new Error("Local CLI action cancelled");
          }
        },
        onStdout: (chunk) => {
          if (overflow) {
            return;
          }
          if (stdout.length + chunk.length > MAX_JSON_CHARS) {
            overflow = true;
            stdout = "";
            return;
          }
          stdout += chunk;
        },
      });
      if (closed || owned.cancelled) {
        owned.run.cancel();
      }
      const result = await owned.run.wait();
      if (owned.cancelled || closed || result.reason === "manual-cancel") {
        return { ok: false, reason: "cancelled" };
      }
      if (result.timedOut || result.noOutputTimedOut) {
        return { ok: false, reason: "timeout" };
      }
      if (result.exitCode !== 0 || result.exitSignal) {
        return { ok: false, reason: "execution_failed" };
      }
      if (overflow) {
        return { ok: false, reason: "invalid_response" };
      }
      try {
        return { ok: true, value: JSON.parse(stdout) as unknown };
      } catch {
        return { ok: false, reason: "invalid_response" };
      }
    } catch {
      return { ok: false, reason: owned.cancelled || closed ? "cancelled" : "execution_failed" };
    } finally {
      owned.run?.detachOutput?.();
      stdout = "";
      active = undefined;
    }
  };

  return {
    runJson,
    cancel,
    shutdown: () => {
      closed = true;
      cancel();
      return (shutdownPromise ??= cleanup());
    },
  };
}
