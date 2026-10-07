import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { LegacyConfigMigrationSpec, LegacyConfigRule } from "../../../config/legacy.shared.js";
import { selectLegacyHeartbeatVisibility } from "../../doctor-heartbeat-visibility.js";
import { LEGACY_CONFIG_MIGRATIONS_AUDIO } from "./legacy-config-migrations.audio.js";
import { LEGACY_CONFIG_MIGRATIONS_CHANNELS } from "./legacy-config-migrations.channels.js";
import { LEGACY_CONFIG_MIGRATIONS_QQBOT } from "./legacy-config-migrations.qqbot.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME } from "./legacy-config-migrations.runtime.js";
import { LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH } from "./legacy-config-migrations.web-search.js";
import { hasLegacyContextBudgetConfig } from "./legacy-context-budget.js";
import { removeLegacyCopilotDiscovery } from "./legacy-copilot-discovery.js";
import { LEGACY_CONFIG_MIGRATION_TOOLS_BY_SENDER } from "./legacy-tools-by-sender.js";

export const LEGACY_CONFIG_MIGRATIONS: LegacyConfigMigrationSpec[] = [
  ...LEGACY_CONFIG_MIGRATIONS_CHANNELS,
  ...LEGACY_CONFIG_MIGRATIONS_QQBOT,
  ...LEGACY_CONFIG_MIGRATIONS_AUDIO,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME,
  ...LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH,
  LEGACY_CONFIG_MIGRATION_TOOLS_BY_SENDER,
];

// Only the durable Doctor cutover may remove these supported legacy inputs.
const LEGACY_HEARTBEAT_CONFIG_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "heartbeat"],
    message:
      'Heartbeat configuration retired; run "openclaw doctor --fix" to preserve it as an editable automation.',
  },
  {
    path: ["agents", "entries"],
    match: (value) =>
      isRecord(value) &&
      Object.values(value).some((entry) => isRecord(entry) && entry.heartbeat !== undefined),
    message: 'Per-agent heartbeat configuration requires "openclaw doctor --fix" before startup.',
  },
  {
    path: ["agents", "list"],
    match: (value) =>
      Array.isArray(value) &&
      value.some((entry) => isRecord(entry) && entry.heartbeat !== undefined),
    message: 'Per-agent heartbeat configuration requires "openclaw doctor --fix" before startup.',
  },
  {
    path: ["channels"],
    match: (value) =>
      isRecord(value) &&
      Object.entries(value).some(([id, channel]) => {
        const hasVisibility = (owner: unknown, allowEmpty = false): boolean =>
          isRecord(owner) &&
          (selectLegacyHeartbeatVisibility(id, owner) !== undefined ||
            (isRecord(owner.heartbeat) &&
              (allowEmpty || Object.keys(owner.heartbeat).length > 0) &&
              Object.keys(owner.heartbeat).every((key) =>
                ["showOk", "showAlerts", "useIndicator"].includes(key),
              )));
        return (
          hasVisibility(channel, id === "defaults") ||
          (isRecord(channel) &&
            isRecord(channel.accounts) &&
            Object.values(channel.accounts).some((account) => hasVisibility(account)))
        );
      }),
    message:
      'Channel heartbeat visibility requires "openclaw doctor --fix" before startup; transport heartbeat settings are not retired.',
  },
];

/** Aggregated legacy config rules used for doctor preview issue detection. */
export const LEGACY_CONFIG_MIGRATION_RULES: LegacyConfigRule[] = [
  ...LEGACY_HEARTBEAT_CONFIG_RULES,
  ...LEGACY_CONFIG_MIGRATIONS.flatMap((migration) => migration.legacyRules ?? []),
  {
    path: [],
    message:
      'Context budgets use models.providers.<provider>.models[].contextTokens; run "openclaw doctor --fix" to migrate retired provider and agent keys.',
    match: hasLegacyContextBudgetConfig,
  },
  {
    path: ["plugins", "entries", "github-copilot", "config", "discovery"],
    message: 'The GitHub Copilot discovery switch was retired; run "openclaw doctor --fix".',
    match: (_value, root) => removeLegacyCopilotDiscovery(root) !== root,
  },
];
