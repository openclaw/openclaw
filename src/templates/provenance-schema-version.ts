import { TEMPLATE_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION } from "./provenance-agent-origin.js";

const LEGACY_TEMPLATE_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.templateInstallRecord.v1" as const;
export const TEMPLATE_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.templateInstallRecord.v2" as const;
export type TemplateInstallRecordSchemaVersion =
  | typeof LEGACY_TEMPLATE_INSTALL_RECORD_SCHEMA_VERSION
  | typeof TEMPLATE_INSTALL_RECORD_SCHEMA_VERSION
  | typeof TEMPLATE_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION;

export function parseTemplateInstallRecordSchemaVersion(
  value: string,
): TemplateInstallRecordSchemaVersion {
  if (
    value === LEGACY_TEMPLATE_INSTALL_RECORD_SCHEMA_VERSION ||
    value === TEMPLATE_INSTALL_RECORD_SCHEMA_VERSION ||
    value === TEMPLATE_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION
  ) {
    return value;
  }
  throw new Error(`Unsupported Template install record schema ${JSON.stringify(value)}.`);
}
