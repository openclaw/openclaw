// Doctor-only migration for the retired CLI backend adapter config DSL.
import { getRecord, type LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import { deleteRetiredPath } from "./legacy-config-record-shared.js";

const CLI_BACKENDS_PLUGIN_GUIDE = "https://docs.openclaw.ai/plugins/cli-backend-plugins";

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLI_BACKENDS: LegacyConfigMigrationSpec[] = [
  {
    id: "agents.defaults.cliBackends-plugin-registration",
    legacyRules: [
      {
        path: ["agents", "defaults", "cliBackends"],
        message: `CLI backend adapters now register through plugins; see ${CLI_BACKENDS_PLUGIN_GUIDE}`,
      },
    ],
    apply: (raw, changes) => {
      if (deleteRetiredPath(getRecord(raw.agents)?.defaults, ["cliBackends"])) {
        // Adapter data is intentionally retired, not interpreted at runtime.
        // Arbitrary launch policy cannot be safely synthesized into executable plugin code.
        changes.push(
          `Removed agents.defaults.cliBackends; CLI backend adapters now register through plugins (${CLI_BACKENDS_PLUGIN_GUIDE}).`,
        );
      }
    },
  },
];
