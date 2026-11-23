import { CONTROL_PLANE_WRITE, OWN_SESSION_WRITE } from "./core-descriptor-options.js";
import type { CoreGatewayMethodSpecRow } from "./core-descriptor-types.js";

// New core method rows go here: core-descriptors.ts reached its line cap. Its table
// spreads these at the end, so the combined table stays append-only.
export const CORE_GATEWAY_METHOD_SPECS_APPENDED = [
  ["openclawId.status", "openclaw-id", "operator.read", "2026.11"],
  ["openclawId.people", "openclaw-id", "operator.admin", "2026.11"],
  ["openclawId.authority", "openclaw-id", "operator.admin", "2026.11", CONTROL_PLANE_WRITE],
  ["openclawId.account", "openclaw-id", "operator.read", "2026.11"],
  ["chat.steerNow", "chat", "operator.write", "2026.11", OWN_SESSION_WRITE],
  ["toolUsage.status", "tool-usage", "operator.admin", "2026.11"],
  ["toolUsage.import", "tool-usage", "operator.admin", "2026.11", CONTROL_PLANE_WRITE],
  ["toolUsage.reset", "tool-usage", "operator.admin", "2026.11", CONTROL_PLANE_WRITE],
  ["sessions.steerTarget", "sessions-messaging", "operator.write", "2026.11", OWN_SESSION_WRITE],
  ["sessions.steerActive", "sessions-messaging", "operator.write", "2026.11", OWN_SESSION_WRITE],
  ["openclaw.setup.options", "system-agent", "operator.admin", "2026.11"],
  ["sessions.files.stat", "sessions-files", "operator.read", "2026.11"],
  ["skills.categories", "skills", "operator.read", "2026.11"],
  [
    "projects.moveSessionOptions",
    "projects-session-move",
    "operator.write",
    "2026.11",
    OWN_SESSION_WRITE,
  ],
  ["projects.moveSession", "projects-session-move", "operator.write", "2026.11", OWN_SESSION_WRITE],
  ["cron.acknowledgeFailure", "cron", "operator.read", "2026.11"],
] as const satisfies readonly CoreGatewayMethodSpecRow[];
