// Gateway startup-migration readiness refusals shared by doctor config preflight.
import { ExitError } from "../runtime.js";

export function throwStartupMigrationRefusal(message: string, cause?: unknown): never {
  // ExitError bypasses entry.ts's generic failure formatter, so report the owned reason here.
  console.error(message);
  throw Object.assign(new ExitError(78, message), { cause });
}

export function throwStartupMigrationGuardRejected(): never {
  throw new Error(
    "OpenClaw startup migrations were skipped because the selected config changed during startup; refusing to report the gateway ready. Retry startup so the new config can be validated.",
  );
}

export function throwStartupMigrationIdentityChanged(reason?: string): never {
  throwStartupMigrationRefusal(
    `OpenClaw migration inputs changed during startup${reason ? ` (${reason})` : ""}; refusing to report the gateway ready. Restart OpenClaw so state migrations run against the final config and plugin inventory.`,
  );
}

// Refuse before any startup writes. This probe borrows no ownership from the
// runtime lock, which remains with the Gateway run loop's restart lifecycle.
export async function refuseStartupMigrationsForLiveGatewayOwner(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (env.VITEST || env.NODE_ENV === "test") {
    return;
  }
  const { readActiveGatewayLockIdentity } = await import("../infra/gateway-lock.js");
  const activeGateway = await readActiveGatewayLockIdentity({ env });
  if (activeGateway) {
    throwStartupMigrationRefusal(
      `Another gateway (pid ${activeGateway.pid}) already owns this state directory; refusing to run automatic startup migrations or report the gateway ready. Stop it with "openclaw gateway stop" (or select a different OPENCLAW_STATE_DIR), then retry startup.`,
    );
  }
}
