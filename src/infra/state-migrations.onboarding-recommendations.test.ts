import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { createOnboardingRecommendationsStore } from "../state/onboarding-recommendations.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { migrateLegacyOnboardingRecommendationsScope } from "./state-migrations.onboarding-recommendations.js";

type OnboardingRecommendationsMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "onboarding_recommendations"
>;

function insertRecommendationRow(params: {
  database: { env: NodeJS.ProcessEnv };
  configKey: string;
  inventoryHash: string;
}): void {
  runOpenClawStateWriteTransaction(({ db: sqlite }) => {
    const db = getNodeSqliteKysely<OnboardingRecommendationsMigrationDatabase>(sqlite);
    executeSqliteQuerySync(
      sqlite,
      db.insertInto("onboarding_recommendations").values({
        config_key: params.configKey,
        inventory_hash: params.inventoryHash,
        matches_json: "[]",
        offered_at_ms: 1_000,
        accepted_at_ms: 2_000,
        updated_at_ms: 2_000,
      }),
    );
  }, params.database);
}

function readRecommendationKey(
  database: { env: NodeJS.ProcessEnv },
  configKey: string,
): { config_key: string } | undefined {
  return runOpenClawStateWriteTransaction(({ db: sqlite }) => {
    const db = getNodeSqliteKysely<OnboardingRecommendationsMigrationDatabase>(sqlite);
    return executeSqliteQueryTakeFirstSync(
      sqlite,
      db
        .selectFrom("onboarding_recommendations")
        .select("config_key")
        .where("config_key", "=", configKey),
    );
  }, database);
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("onboarding recommendations scope migration", () => {
  it("does not warn about a missing owner when no legacy row exists", async () => {
    await withOpenClawTestState(
      { label: "onboarding-recommendations-no-legacy-row" },
      async (state) => {
        const database = { env: state.env };
        createOnboardingRecommendationsStore({
          workspaceDir: state.workspaceDir,
          database,
        }).read();

        expect(
          migrateLegacyOnboardingRecommendationsScope({
            cfg: {
              agents: {
                ownership: "explicit",
                entries: { ops: {}, research: {} },
              },
            },
            env: state.env,
          }),
        ).toEqual({ changes: [], warnings: [] });
      },
    );
  });

  it("moves the legacy singleton row to the retained owner workspace", async () => {
    await withOpenClawTestState(
      { label: "onboarding-recommendations-migration" },
      async (state) => {
        const database = { env: state.env };
        insertRecommendationRow({
          database,
          configKey: "primary",
          inventoryHash: "legacy-inventory",
        });

        const result = migrateLegacyOnboardingRecommendationsScope({
          cfg: retainLegacyDefaultAgentId(
            {
              agents: {
                defaults: { workspace: state.workspaceDir },
                entries: { main: { workspace: state.workspaceDir }, research: {} },
              },
            } as OpenClawConfig,
            "main",
          ),
          env: state.env,
        });

        expect(result).toEqual({
          changes: [
            "Migrated onboarding recommendation state to the legacy owner workspace scope.",
          ],
          warnings: [],
        });
        expect(
          createOnboardingRecommendationsStore({
            workspaceDir: state.workspaceDir,
            database,
          }).read(),
        ).toEqual({
          inventoryHash: "legacy-inventory",
          matches: [],
          offeredAt: 1_000,
          acceptedAt: 2_000,
          updatedAt: 2_000,
        });
        expect(readRecommendationKey(database, "primary")).toBeUndefined();
      },
    );
  });

  it("uses the sole live workspace when the retained owner departed", async () => {
    await withOpenClawTestState(
      { label: "onboarding-recommendations-departed-owner" },
      async (state) => {
        const database = { env: state.env };
        insertRecommendationRow({
          database,
          configKey: "primary",
          inventoryHash: "legacy-inventory",
        });
        const cfg = retainLegacyDefaultAgentId(
          {
            agents: {
              entries: { research: { workspace: state.workspaceDir } },
            },
          } as OpenClawConfig,
          "ops",
        );

        expect(migrateLegacyOnboardingRecommendationsScope({ cfg, env: state.env })).toEqual({
          changes: [
            "Migrated onboarding recommendation state to the legacy owner workspace scope.",
          ],
          warnings: [],
        });
        expect(
          createOnboardingRecommendationsStore({
            workspaceDir: state.workspaceDir,
            database,
          }).read(),
        ).toMatchObject({ inventoryHash: "legacy-inventory" });
        expect(readRecommendationKey(database, "primary")).toBeUndefined();
      },
    );
  });

  it("keeps an existing scoped row when legacy state is also present", async () => {
    await withOpenClawTestState(
      { label: "onboarding-recommendations-migration-conflict" },
      async (state) => {
        const database = { env: state.env };
        const store = createOnboardingRecommendationsStore({
          workspaceDir: state.workspaceDir,
          database,
        });
        const scoped = store.writeOffer({
          inventory: [{ label: "Scoped" }],
          matches: [],
          answered: false,
          nowMs: 3_000,
        });
        insertRecommendationRow({
          database,
          configKey: "primary",
          inventoryHash: "legacy-inventory",
        });

        const result = migrateLegacyOnboardingRecommendationsScope({
          cfg: retainLegacyDefaultAgentId(
            {
              agents: {
                defaults: { workspace: state.workspaceDir },
                entries: { main: { workspace: state.workspaceDir }, research: {} },
              },
            } as OpenClawConfig,
            "main",
          ),
          env: state.env,
        });

        expect(result).toEqual({
          changes: [
            "Removed ambiguous legacy onboarding recommendation state; kept the legacy owner workspace record.",
          ],
          warnings: [],
        });
        expect(store.read()).toEqual(scoped);
        expect(readRecommendationKey(database, "primary")).toBeUndefined();
      },
    );
  });
});
