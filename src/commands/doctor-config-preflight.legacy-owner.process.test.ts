import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { ensureOpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createSourceRuntime,
  runSourceRuntime,
} from "./doctor-config-preflight.process.test-support.js";
import { doctorConfigRuntimeEntrypoints } from "./doctor-config-runtime.test-support.js";

const STARTUP_RECOVERY = "openclaw doctor --fix";
const tempDirs = createFixtureLifetime();
afterAll(() => tempDirs.cleanup());

function seedMalformedDatabase(stateDir: string, mutation: string, shared = false): string {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  // Exercise the migration refusal with known shared history, rather than a lost journal.
  const statePath = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  const databasePath = shared
    ? statePath
    : path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    if (!shared) {
      ensureOpenClawAgentDatabaseSchema(database, {
        agentId: "main",
        env,
        path: databasePath,
        register: false,
      });
    }
    database.exec(mutation);
  } finally {
    database.close();
  }
  return databasePath;
}

describe("startup legacy store classification", () => {
  it.each([
    {
      database: true,
      reason: "no agent owner",
      mutation: "UPDATE schema_meta SET agent_id = NULL WHERE meta_key = 'primary'",
      shared: false,
    },
    {
      database: true,
      reason: "schema_meta is missing required columns",
      mutation: "ALTER TABLE schema_meta RENAME COLUMN agent_id TO retired_agent_id",
      shared: false,
    },
    {
      database: true,
      reason: "schema_meta is missing required columns",
      mutation: "ALTER TABLE schema_meta RENAME COLUMN role TO retired_role",
      shared: true,
    },
    {
      database: true,
      reason: "metadata schema version 0",
      mutation: "UPDATE schema_meta SET schema_version = 0 WHERE meta_key = 'primary'",
      shared: false,
    },
    {
      database: true,
      reason: "column definitions differ for worktrees",
      mutation:
        "ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json; ALTER TABLE worktrees ADD COLUMN run_end_cleanup_json INTEGER;",
      shared: true,
    },
    {
      database: true,
      reason: "schema role agent; expected global",
      mutation: "UPDATE schema_meta SET role = 'agent' WHERE meta_key = 'primary'",
      shared: true,
    },
    {
      database: false,
      reason: "Deferred legacy agent/session migration: select an agent owner",
      mutation: "",
      shared: false,
    },
    {
      database: true,
      reason: "ownership metadata is invalid",
      mutation:
        "INSERT OR REPLACE INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES ('gateway.supervision', '\"invalid\"', 1)",
      shared: true,
      recovery: "openclaw database ownership claim",
    },
  ])(
    "preserves unused legacy state but refuses an unsafe required store ($reason, shared=$shared)",
    async ({ database, reason, mutation, shared, recovery = STARTUP_RECOVERY }) => {
      const root = fs.realpathSync(tempDirs.createTempDir("openclaw-legacy-owner-refusal-"));
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const config = {
        meta: { migrations: { webhookListeners: true } },
        gateway: { mode: "local", auth: { mode: "none" } },
        agents: {
          ownership: "explicit",
          ...(database ? { defaults: { systemAgent: { agentId: "main" } } } : {}),
          entries: { main: {}, blocker: {}, digest: {} },
        },
      } satisfies OpenClawConfig;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_FAST: "1",
        NO_COLOR: "1",
      };
      delete env.NODE_ENV;
      delete env.OPENCLAW_HOME;
      delete env.VITEST;

      fs.mkdirSync(path.join(stateDir, "agent"), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config));
      const legacyPath = database
        ? seedMalformedDatabase(stateDir, mutation, shared)
        : path.join(stateDir, "agent", "settings.json");
      if (!database) {
        fs.writeFileSync(legacyPath, '{"legacy":true}\n');
        fs.writeFileSync(
          path.join(stateDir, "exec-approvals.json"),
          JSON.stringify({ version: 1, defaults: {}, agents: {} }),
        );
      }
      const before = fs.readFileSync(legacyPath);
      const configBefore = fs.readFileSync(configPath);
      const preflightUrl = resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.startup).href;
      const script = `
        const { runStartupConfigPreflight } = await import(${JSON.stringify(preflightUrl)});
        try {
          await runStartupConfigPreflight({
            gateway: true,
          });
          console.log("__READY__");
        } catch (error) {
          console.error("__REFUSED__", error instanceof Error ? error.stack : String(error));
          process.exitCode = typeof error.code === "number" ? error.code : 1;
        }
      `;
      const result = await tempDirs.track(
        runSourceRuntime(
          createSourceRuntime(root),
          env,
          ["--input-type=module", "--eval", script],
          60_000,
        ),
      );
      const output = `${result.stderr}\n${result.stdout}`;

      expect(result.code, output).toBe(database ? 78 : 0);
      expect(result.signal, output).toBeNull();
      if (database) {
        expect(result.stdout, output).not.toContain("__READY__");
        expect(result.stderr, output).toContain("__REFUSED__");
        expect(output).toContain(recovery);
        expect(output).toContain(reason);
      } else {
        expect(result.stdout, output).toContain("__READY__");
        expect(output).not.toContain("__REFUSED__");
        expect(fs.readFileSync(path.join(stateDir, "exec-approvals.json"), "utf8")).toBe(
          JSON.stringify({ version: 1, defaults: {}, agents: {} }),
        );
        expect(fs.readdirSync(stateDir)).not.toContainEqual(
          expect.stringMatching(/^exec-approvals\.json\.migrated\./),
        );
      }
      expect(fs.readFileSync(legacyPath)).toEqual(before);
      expect(fs.readFileSync(configPath)).toEqual(configBefore);
      expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    },
    75_000,
  );
});
