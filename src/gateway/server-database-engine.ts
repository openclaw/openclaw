import { readConfigFileSnapshot } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import {
  getDatabaseEngineSelection,
  installDatabaseEngineSelection,
  type DatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { assertDatabasePortStartupAllowed } from "../infra/database-port-recovery.js";
import {
  GATEWAY_CRASH_LOOP_BREAKER_REASON,
  GATEWAY_CRASH_LOOP_RECOVERED_REASON,
  inspectGatewayCrashLoopBreaker,
  recordGatewayBootStart,
} from "../infra/gateway-boot-lifecycle.js";

export function recordGatewayDatabaseBoot(env: NodeJS.ProcessEnv, startedAtMs: number) {
  const decision = withEngineStoreAdmission(() => inspectGatewayCrashLoopBreaker(env, startedAtMs));
  const reason = decision.tripped
    ? decision.shouldWriteStabilityBundle
      ? GATEWAY_CRASH_LOOP_BREAKER_REASON
      : undefined
    : decision.recovered
      ? GATEWAY_CRASH_LOOP_RECOVERED_REASON
      : undefined;
  // Shared-state schema failures make this write fail open, so no lifecycle
  // row exists for Doctor to reconcile after it repairs the schema.
  const id = withEngineStoreAdmission(() => recordGatewayBootStart(env, startedAtMs, reason));
  return { decision, id };
}

/** Direct servers and embedded kernels enter before locks, state reads, or plugin config. */
export async function installGatewayDatabaseEngine(
  snapshot?: ConfigFileSnapshot,
  selection?: DatabaseEngineSelection,
): Promise<void> {
  assertDatabasePortStartupAllowed(resolveStateDir(process.env));
  if (selection) {
    installDatabaseEngineSelection(selection);
    return;
  }
  if (getDatabaseEngineSelection()) {
    return;
  }
  const selected =
    snapshot ??
    (await readConfigFileSnapshot({
      observe: false,
      isolateEnv: true,
      pluginValidation: "core-only",
    }));
  installDatabaseEngineSelection(await resolveDatabaseEngineSelection(selected.config));
}
