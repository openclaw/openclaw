import { homedir } from "node:os";
import {
  appendConfigAuditRecord,
  type ConfigExternalChangeAuditRecord,
} from "../config/io.audit.js";

type ExternalConfigChange = Omit<
  ConfigExternalChangeAuditRecord,
  "ts" | "source" | "event" | "configPath"
>;

/** Journals config changes the reloader observed for one watched path. */
export function createExternalConfigAudit(configPath: string) {
  return async (record: ExternalConfigChange): Promise<void> => {
    await appendConfigAuditRecord({
      env: process.env,
      homedir,
      record: {
        ts: new Date().toISOString(),
        source: "config-io",
        event: "config.external",
        configPath,
        ...record,
      },
    });
  };
}
