import { existsSync } from "node:fs";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const LEGACY_ONBOARDING_RECOMMENDATIONS_KEY = "primary";

type OnboardingRecommendationsMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "onboarding_recommendations"
>;

/** Move the shipped singleton row into the default workspace during doctor repair. */
export function migrateLegacyOnboardingRecommendationsScope(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): MigrationMessages {
  const env = params.env ?? process.env;
  if (!existsSync(resolveOpenClawStateSqlitePath(env))) {
    return { changes: [], warnings: [] };
  }

  try {
    const { db: database } = openOpenClawStateDatabase({ env });
    const db = getNodeSqliteKysely<OnboardingRecommendationsMigrationDatabase>(database);
    const legacy = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("onboarding_recommendations")
        .select("config_key")
        .where("config_key", "=", LEGACY_ONBOARDING_RECOMMENDATIONS_KEY),
    );
    if (!legacy) {
      return { changes: [], warnings: [] };
    }
    const migrationAgentId = tryResolveLegacyCompatibilityAgentId(params.cfg);
    if (!migrationAgentId) {
      return {
        changes: [],
        warnings: [
          "Deferred legacy onboarding recommendation workspace migration because the fleet has no migration owner",
        ],
      };
    }
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, migrationAgentId, env);
    const workspaceKey = resolveWorkspaceStateIdentity(workspaceDir).workspaceKey;
    const outcome = runOpenClawStateWriteTransaction(
      ({ db: writeDatabase }) => {
        const writeDb =
          getNodeSqliteKysely<OnboardingRecommendationsMigrationDatabase>(writeDatabase);
        const legacyAtCommit = executeSqliteQueryTakeFirstSync(
          writeDatabase,
          writeDb
            .selectFrom("onboarding_recommendations")
            .select("config_key")
            .where("config_key", "=", LEGACY_ONBOARDING_RECOMMENDATIONS_KEY),
        );
        if (!legacyAtCommit) {
          return "unchanged" as const;
        }
        const scoped = executeSqliteQueryTakeFirstSync(
          writeDatabase,
          writeDb
            .selectFrom("onboarding_recommendations")
            .select("config_key")
            .where("config_key", "=", workspaceKey),
        );
        if (scoped) {
          executeSqliteQuerySync(
            writeDatabase,
            writeDb
              .deleteFrom("onboarding_recommendations")
              .where("config_key", "=", LEGACY_ONBOARDING_RECOMMENDATIONS_KEY),
          );
          return "removed-legacy" as const;
        }
        executeSqliteQuerySync(
          writeDatabase,
          writeDb
            .updateTable("onboarding_recommendations")
            .set({ config_key: workspaceKey })
            .where("config_key", "=", LEGACY_ONBOARDING_RECOMMENDATIONS_KEY),
        );
        return "migrated" as const;
      },
      { env },
      { operationLabel: "onboarding.recommendations.migrate-scope" },
    );

    if (outcome === "migrated") {
      return {
        changes: ["Migrated onboarding recommendation state to the legacy owner workspace scope."],
        warnings: [],
      };
    }
    if (outcome === "removed-legacy") {
      return {
        changes: [
          "Removed ambiguous legacy onboarding recommendation state; kept the legacy owner workspace record.",
        ],
        warnings: [],
      };
    }
    return { changes: [], warnings: [] };
  } catch (err) {
    return {
      changes: [],
      warnings: [`Failed migrating onboarding recommendation workspace scope: ${String(err)}`],
    };
  }
}
