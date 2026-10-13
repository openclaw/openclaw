import { CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION } from "./provenance-agent-origin.js";

const LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v1" as const;
export const CLAW_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v2" as const;
export type ClawInstallRecordSchemaVersion =
  | typeof LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION
  | typeof CLAW_INSTALL_RECORD_SCHEMA_VERSION
  | typeof CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION;

export function parseClawInstallRecordSchemaVersion(value: string): ClawInstallRecordSchemaVersion {
  if (
    value === LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION ||
    value === CLAW_INSTALL_RECORD_SCHEMA_VERSION ||
    value === CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION
  ) {
    return value;
  }
  throw new Error(`Unsupported Claw install record schema ${JSON.stringify(value)}.`);
}
