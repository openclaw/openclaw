import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";

/** Home belongs to full operators; shared-session visibility never grants it. */
export function canAccessHomeSession(snapshot: Pick<ApplicationGatewaySnapshot, "hello">): boolean {
  const auth = snapshot.hello?.auth;
  return Boolean(
    snapshot.hello && (hasOperatorReadAccess(auth ?? null) || auth?.sessionCap === "write"),
  );
}
