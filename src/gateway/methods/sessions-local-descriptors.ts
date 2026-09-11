// Live local session methods (see src/gateway/server-methods/sessions-local.ts).
import type { CoreGatewayMethodSpecRow } from "./core-descriptors.js";

export const SESSIONS_LOCAL_METHOD_SPECS = [
  ["sessions.local.sources", "sessions-local", "operator.read", "2026.9"],
  ["sessions.local.enrollments", "sessions-local", "operator.read", "2026.9"],
  ["sessions.local.enroll", "sessions-local", "operator.write", "2026.9"],
  ["sessions.local.revoke", "sessions-local", "operator.write", "2026.9"],
  ["sessions.local.unshare", "sessions-local", "operator.write", "2026.9"],
  ["sessions.local.connectCode", "sessions-local", "operator.write", "2026.9"],
] as const satisfies readonly CoreGatewayMethodSpecRow[];
