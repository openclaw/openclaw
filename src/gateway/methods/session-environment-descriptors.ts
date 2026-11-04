import { CONTROL_PLANE_WRITE } from "./core-descriptor-options.js";
import type { CoreGatewayMethodSpecRow } from "./core-descriptor-types.js";

/** Session-owned machine methods share conversation authority, not administrator identity. */
export const SESSION_ENVIRONMENT_METHOD_SPECS = [
  ["environments.session.status", "environments", "operator.read", "2026.9"],
  [
    "environments.session.create",
    "environments",
    "operator.sessions.write",
    "2026.9",
    CONTROL_PLANE_WRITE,
  ],
  [
    "environments.session.destroy",
    "environments",
    "operator.sessions.write",
    "2026.9",
    CONTROL_PLANE_WRITE,
  ],
  ["environments.session.exec", "environments", "operator.sessions.write", "2026.9"],
  ["environments.session.invoke", "environments", "operator.sessions.write", "2026.10"],
] as const satisfies readonly CoreGatewayMethodSpecRow[];
