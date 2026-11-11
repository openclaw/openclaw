import path from "node:path";
import { CronStreamPolicyDeniedError } from "../cron/stream-exec-authority.js";
import { resolveCommandResolutionFromArgv } from "../infra/exec-command-resolution.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import {
  prepareSystemRunMutableFileBinding,
  revalidateSystemRunMutableFileBindingSync,
} from "../infra/system-run-approval-binding.js";
import {
  APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
  captureApprovedCwdSnapshotSync,
  revalidateApprovedCwdSnapshot,
} from "../infra/system-run-cwd-binding.js";

/** Pins the proposal through approval and save; the committed watcher keeps its path-based lifecycle. */
export async function prepareCronStreamExecutionBinding(params: {
  argv: readonly string[];
  cwd?: string;
}): Promise<{ assertCurrent: () => void }> {
  const argv = [...params.argv];
  const requestedCwd = path.resolve(params.cwd ?? process.cwd());
  const capturedCwd = captureApprovedCwdSnapshotSync(requestedCwd);
  if (!capturedCwd.ok) {
    throw new Error(capturedCwd.message);
  }
  const cwd = capturedCwd.snapshot.cwd;
  const env = { ...process.env };
  const resolution = resolveCommandResolutionFromArgv(argv, cwd, env, process.platform, {
    useCache: false,
  });
  if (!resolution?.execution.resolvedPath && !resolution?.execution.resolvedRealPath) {
    throw new Error("SYSTEM_RUN_DENIED: approval requires a resolved executable");
  }
  const prepared = await prepareSystemRunMutableFileBinding({
    command: {
      kind: "segments",
      segments: [{ raw: argv.join(" "), argv, sourceArgv: argv, resolution }],
      shellCommand: false,
    },
    cwd,
    env,
  });
  if (!prepared.ok) {
    throw new Error(prepared.message);
  }
  return {
    assertCurrent() {
      if (
        path.resolve(params.cwd ?? process.cwd()) !== requestedCwd ||
        !revalidateApprovedCwdSnapshot(capturedCwd.snapshot)
      ) {
        throw new CronStreamPolicyDeniedError(APPROVAL_CWD_DRIFT_DENIED_MESSAGE);
      }
      if (
        resolveEnvironmentValue(process.env, "PATH") !== resolveEnvironmentValue(env, "PATH") ||
        resolveEnvironmentValue(process.env, "PATHEXT") !== resolveEnvironmentValue(env, "PATHEXT")
      ) {
        throw new CronStreamPolicyDeniedError(
          "SYSTEM_RUN_DENIED: approval executable search environment changed",
        );
      }
      const current = revalidateSystemRunMutableFileBindingSync({ binding: prepared.binding, cwd });
      if (!current.ok) {
        throw new CronStreamPolicyDeniedError(current.message);
      }
    },
  };
}
