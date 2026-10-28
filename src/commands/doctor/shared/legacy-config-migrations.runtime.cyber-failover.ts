import { getRecord, type LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";

export const LEGACY_CONFIG_MIGRATION_RUNTIME_CYBER_FAILOVER: LegacyConfigMigrationSpec = {
  id: "agents.defaults.embeddedAgent.cyberFailover.model-removed",
  legacyRules: [
    {
      path: ["agents", "defaults", "embeddedAgent", "cyberFailover"],
      message:
        'agents.defaults.embeddedAgent.cyberFailover.model is retired; automatic cyber-policy retries use the active model through approved Daybreak access. Run "openclaw doctor --fix" to remove it.',
      match: (value) => Object.hasOwn(getRecord(value) ?? {}, "model"),
    },
  ],
  apply: (raw, changes) => {
    const defaults = getRecord(getRecord(raw.agents)?.defaults);
    const cyberFailover = getRecord(getRecord(defaults?.embeddedAgent)?.cyberFailover);
    if (!cyberFailover || !Object.hasOwn(cyberFailover, "model")) {
      return;
    }
    delete cyberFailover.model;
    changes.push(
      "Removed retired agents.defaults.embeddedAgent.cyberFailover.model; automatic cyber-policy retries use the active model through approved Daybreak access. Existing mode and cooloffMs settings were not changed.",
    );
  },
};
