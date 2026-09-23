import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { recordCompletedLegacyAgentDirMigration } from "./state-migrations.agent-dir-receipt.js";
import {
  detectLegacyStateMigrations,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";
import { createLegacyStateMigrationStepReceipt } from "./state-migrations.messages.js";
import { captureLegacyStateSnapshotIdentity } from "./state-migrations.plan.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("legacy owner advisories", () => {
  it.each([
    ["settings", "none", false],
    ["loose-db", "none", false],
    ["loose-db", "main", false],
    ["settings", "none", true],
    ["standalone-db", "none", false],
    ["standalone-db", "main", false],
    ["standalone-db", "override", false],
    ["standalone-db", "retired", false],
  ] as const)(
    "preserves %s with %s selection and required failure=%s",
    async (sourceKind, selection, requiredFailure) => {
      const database = sourceKind !== "settings";
      const standalone = sourceKind === "standalone-db";
      const owner = selection !== "none";
      const refused =
        requiredFailure || (standalone && (selection === "none" || selection === "main"));
      const root = fs.realpathSync(tempDirs.make("openclaw-legacy-owner-"));
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir);
      const configPath = path.join(root, "openclaw.json");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          ...(owner ? { defaults: { systemAgent: { agentId: "main" } } } : {}),
          entries: { main: {}, other: {} },
        },
      };
      const targetDir = path.join(stateDir, "agents", "main", "agent");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_HOME: root,
        OPENCLAW_AGENT_DIR: selection === "override" ? targetDir : undefined,
        PI_CODING_AGENT_DIR: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      const source = path.join(
        standalone ? path.join(root, ".openclaw") : stateDir,
        "agent",
        database ? "openclaw-agent.sqlite" : "settings.json",
      );
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(cfg));
      if (database) {
        // A retained legacy schema with no owner must be inspected without adopting it.
        const db = new DatabaseSync(source);
        try {
          db.exec(
            "CREATE TABLE retained_payload (value TEXT); INSERT INTO retained_payload VALUES ('retained')",
          );
        } finally {
          db.close();
        }
      } else {
        fs.writeFileSync(source, '{"legacy":true}\n');
      }
      if (selection === "retired") {
        fs.mkdirSync(targetDir, { recursive: true });
        recordCompletedLegacyAgentDirMigration(path.dirname(source), targetDir);
      }
      const before = fs.readFileSync(source);
      const requiredWarning = "Cannot resolve the required plugin session store";
      const detected = await detectLegacyStateMigrations({
        cfg,
        env,
        homedir: () => root,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: {
          ...EMPTY_LEGACY_SESSION_SURFACES,
          failures: requiredFailure ? [requiredWarning] : [],
        },
      });
      const receipt = createLegacyStateMigrationStepReceipt(
        {
          id: "migration-detection",
          phase: "shared",
          source: [],
          target: [],
          requiredness: "required",
          reversibility: "not-applicable",
        },
        { ...detected, changes: [] },
      );
      expect(receipt.outcome).toBe(refused ? "refused" : "deferred");
      expect(receipt.warnings).toContainEqual(
        expect.stringContaining(
          database ? "ownership metadata is missing" : "select an agent owner",
        ),
      );
      if (refused) {
        expect(receipt.refusal?.message).toContain(
          requiredFailure ? requiredWarning : "ownership metadata is missing",
        );
      } else {
        expect(receipt.refusal).toBeUndefined();
        const snapshot = { homeDir: root, stateDir, configPath };
        const identityBefore = await captureLegacyStateSnapshotIdentity(snapshot);
        const plan = await planLegacyStateMigrationsReadOnly({
          mode: "doctor",
          candidate: { root, version: "test" },
          snapshot,
          env,
        });
        expect(plan.warnings).toEqual(
          expect.arrayContaining(
            standalone
              ? [expect.stringContaining("outside the copied state snapshot")]
              : receipt.warnings,
          ),
        );
        expect(
          plan.steps.find((step) => step.id === "migration-detection")?.refusal,
        ).toBeUndefined();
        expect(plan.refusal?.code).toBe("candidate-artifact-digest-required");
        expect(await captureLegacyStateSnapshotIdentity(snapshot)).toEqual(identityBefore);
      }
      expect(fs.readFileSync(source)).toEqual(before);
    },
  );
});
