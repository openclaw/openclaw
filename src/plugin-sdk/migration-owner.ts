import { resolveStateDir } from "../config/paths.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { MigrationProviderContext } from "./plugin-entry.js";

/** Native lifecycle effects belong to the admitted final target, never onboarding staging. */
export function captureMigrationOwner(ctx: MigrationProviderContext): { assertCurrent(): void } {
  const stateDir = resolveIdentityPathViaExistingAncestorSync(resolveStateDir());
  if (resolveIdentityPathViaExistingAncestorSync(ctx.stateDir) !== stateDir) {
    throw new Error("Native migration effects must run after onboarding promotion.");
  }
  const owner = captureGatewayStateOwner(resolveOpenClawStateSqlitePath());
  if (!owner || owner.role !== "agent-embedded") {
    throw new Error("Native migration effects require the current offline migration owner.");
  }
  const assertCurrent = () => {
    ctx.signal?.throwIfAborted();
    owner.assertCurrent();
  };
  assertCurrent();
  return { assertCurrent };
}
