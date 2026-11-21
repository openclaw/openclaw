/** Resolves whether the metadata-only audit ledger records new events. */
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type AuditMessageMode = "off" | "direct" | "all";

/**
 * The ledger is on by default: an audit trail enabled only after an incident
 * cannot explain the incident. Disabling collection stops new events; accepted
 * writes drain and queries still serve retained rows until they expire.
 */
export function isAuditLedgerEnabled(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.logging?.audit?.enabled !== false;
}

/** Execution identity is retained only after an explicit opt-in at run admission. */
export function isExecutionIdentityCollectionEnabled(cfg: OpenClawConfig | undefined): boolean {
  return isAuditLedgerEnabled(cfg) && cfg?.logging?.audit?.executionIdentity === true;
}

/** Message metadata remains an explicit opt-in inside the default-on ledger. */
export function resolveAuditMessageMode(cfg: OpenClawConfig | undefined): AuditMessageMode {
  return cfg?.logging?.audit?.messages ?? "off";
}
