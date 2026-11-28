import { createAdmittedRunOperatorAuthority } from "../../../src/agents/admitted-run-context.js";

declare const client: { internal?: { operatorAccessAuthority?: { assertCurrent(): void } } };
type Authority = Parameters<typeof createAdmittedRunOperatorAuthority>[0];

// A started run that re-checks access and rebuilds its authority with its own revocation signal.
export function retain(authority: Authority, signal: AbortSignal) {
  client.internal?.operatorAccessAuthority?.assertCurrent();
  return createAdmittedRunOperatorAuthority({ ...authority, signal });
}
