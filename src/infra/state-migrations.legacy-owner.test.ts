import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { recordCompletedLegacyAgentDirMigration } from "./state-migrations.agent-dir-receipt.js";
import {
  detectLegacyStateMigrations,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";
import { createLegacyStateMigrationStepReceipt } from "./state-migrations.messages.js";
import { captureLegacyStateSnapshotIdentity } from "./state-migrations.plan.js";
import { migrationStepInput } from "./state-migrations.step.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(standalone = false) {
  const root = fs.realpathSync(tempDirs.make("openclaw-legacy-owner-"));
  const stateDir = path.join(root, standalone ? ".openclaw" : "state");
  const configPath = path.join(root, "openclaw.json");
  fs.mkdirSync(stateDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_AGENT_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
  };
  const detection = {
    env,
    homedir: () => root,
    doctorOnlyStateMigrations: true,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  };
  return { root, stateDir, configPath, env, detection };
}

it.each([false, true])(
  "uses Doctor's original data owner independently of runtime ownership (duplicate id: %s)",
  async (duplicate) => {
    const { root, stateDir, env, detection } = fixture();
    const sourcePath = path.join(stateDir, "agent", "settings.json");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    const bytes = '{"legacy":true}\n';
    fs.writeFileSync(sourcePath, bytes);
    const source: OpenClawConfigWithLegacyRoster = {
      plugins: { enabled: false },
      agents: {
        defaults: {
          systemAgent: { agentId: "runtime" },
          authInheritance: { agentId: "runtime" },
        },
        list: [
          ...(duplicate ? [{ id: "ops" }] : []),
          { id: "ops", default: true },
          { id: "runtime" },
        ],
      },
    };
    const migrated = migrateLegacyConfig(source, {
      sourceConfigBeforeMigrations: source,
      context: { authoredRaw: source, resolvedRaw: source, env, homedir: () => root },
      pluginContracts: false,
    });
    expect(migrated.partiallyValid).not.toBe(true);
    if (!migrated.config) {
      throw new Error("Doctor did not migrate the source roster");
    }
    const detected = await detectLegacyStateMigrations({
      ...detection,
      cfg: migrated.config,
      sourceConfigBeforeMigrations: source,
      pluginPlanning: "deferred",
      artifactPreservingReadOnly: true,
    });
    const owner = duplicate ? "ops-2" : "ops";
    expect(detected.targetAgentId).toBe(owner);
    expect(detected.agentDir.targetDir).toBe(path.join(stateDir, "agents", owner, "agent"));
    expect(migrated.config.agents?.defaults?.systemAgent?.agentId).toBe("runtime");
    expect(migrated.config.agents?.defaults?.authInheritance?.agentId).toBe("runtime");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(bytes);
  },
);

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
    const { root, stateDir, configPath, env, detection } = fixture(standalone);
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        ...(owner ? { defaults: { systemAgent: { agentId: "main" } } } : {}),
        entries: { main: {}, other: {} },
      },
    };
    const targetDir = path.join(stateDir, "agents", "main", "agent");
    Object.assign(env, {
      USERPROFILE: root,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_AGENT_DIR: selection === "override" ? targetDir : undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    });
    const source = path.join(
      stateDir,
      "agent",
      database ? "openclaw-agent.sqlite" : "settings.json",
    );
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    if (database) {
      // A retained legacy schema with no owner must be inspected without adopting it.
      using db = new DatabaseSync(source);
      db.exec(
        "CREATE TABLE retained_payload (value TEXT); INSERT INTO retained_payload VALUES ('retained')",
      );
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
      ...detection,
      cfg,
      legacySessionSurfaces: {
        ...EMPTY_LEGACY_SESSION_SURFACES,
        failures: requiredFailure ? [requiredWarning] : [],
      },
    });
    const receipt = createLegacyStateMigrationStepReceipt(
      migrationStepInput("migration-detection", "required", "not-applicable"),
      { ...detected, changes: [] },
    );
    expect(receipt.outcome).toBe(refused ? "refused" : "deferred");
    expect(receipt.warnings).toContainEqual(
      expect.stringContaining(database ? "ownership metadata is missing" : "select an agent owner"),
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
      expect(plan.warnings).toEqual(expect.arrayContaining(receipt.warnings));
      expect(plan.steps.find((step) => step.id === "migration-detection")?.refusal).toBeUndefined();
      expect(plan.refusal?.code).toBe("candidate-artifact-digest-required");
      expect(await captureLegacyStateSnapshotIdentity(snapshot)).toEqual(identityBefore);
    }
    expect(fs.readFileSync(source)).toEqual(before);
  },
);
