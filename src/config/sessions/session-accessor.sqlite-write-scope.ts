import { isMainThread } from "node:worker_threads";
import { runOpenClawAgentPathWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import {
  resolveSqliteWriteAdmissionScope,
  withPreparedSqliteScope,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";

/** Direct writes reserve shared paths before discovery; multi-phase writers own their phases. */
export function withPreparedSqliteWriteScope<T>(
  scope: Parameters<typeof withPreparedSqliteScope>[0],
  run: (resolved: ResolvedSqliteScope, sharedWriteReserved: boolean) => T | Promise<T>,
): T | Promise<T> {
  const admission = isMainThread ? resolveSqliteWriteAdmissionScope(scope) : undefined;
  if (!admission?.shared) {
    return withPreparedSqliteScope(scope, (resolved) => run(resolved, false));
  }
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const captured = { ...scope, env };
  return runOpenClawAgentPathWriteAdmission(
    admission.path,
    (_identity, assertCurrent) =>
      withPreparedSqliteScope(captured, (resolved) => {
        assertCurrent();
        return run(resolved, true);
      }),
    true,
  );
}
