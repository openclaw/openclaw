import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { ensureOpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db.js";
import {
  createSourceRuntime,
  runSourceRuntime,
} from "./doctor-config-preflight.process.test-support.js";
import { doctorConfigRuntimeEntrypoints } from "./doctor-config-runtime.test-support.js";

const STARTUP_REFUSAL =
  "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.";
const STARTUP_RECOVERY =
  'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.';
const tempDirs = createFixtureLifetime();
afterAll(() => tempDirs.cleanup());

function seedOwnerlessSchemaOnlyAgentDatabase(stateDir: string): string {
  const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    ensureOpenClawAgentDatabaseSchema(database, {
      agentId: "openclaw",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      path: databasePath,
      register: false,
    });
    database.prepare("UPDATE schema_meta SET agent_id = NULL WHERE meta_key = 'primary'").run();
  } finally {
    database.close();
  }
  return databasePath;
}

describe("startup legacy store classification", () => {
  it.each([
    { database: true, reason: "no agent owner" },
    { database: false, reason: "Deferred legacy agent/session migration: select an agent owner" },
  ])(
    "defers unused legacy state but refuses an unsafe required store (database=$database)",
    async ({ database, reason }) => {
      const root = fs.realpathSync(tempDirs.createTempDir("openclaw-legacy-owner-refusal-"));
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const config = {
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
        ? seedOwnerlessSchemaOnlyAgentDatabase(stateDir)
        : path.join(stateDir, "agent", "settings.json");
      if (!database) {
        fs.writeFileSync(legacyPath, '{"legacy":true}\n');
        fs.writeFileSync(
          path.join(stateDir, "exec-approvals.json"),
          JSON.stringify({ version: 1, defaults: {}, agents: {} }),
        );
      }
      const before = fs.readFileSync(legacyPath);
      const preflightUrl = resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.preflight).href;
      const cleanupUrl = resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.cleanup).href;
      const script = `
        const { runDoctorConfigPreflight } = await import(${JSON.stringify(preflightUrl)});
        try {
          const result = await runDoctorConfigPreflight({
            migrateLegacyConfig: false,
            invalidConfigNote: false,
            observe: false,
            requireStartupMigrationCheckpoint: true,
          });
          console.log("__RECEIPTS__" + JSON.stringify(result.stateMigrationStepReceipts));
          console.log("__READY__");
        } catch (error) {
          console.error("__REFUSED__", error instanceof Error ? error.message : String(error));
          process.exitCode = typeof error.code === "number" ? error.code : 1;
        } finally {
          const { cleanupSessionStateForTest } = await import(${JSON.stringify(cleanupUrl)});
          await cleanupSessionStateForTest({ stateDir: process.env.OPENCLAW_STATE_DIR });
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
        expect(output).toContain(STARTUP_REFUSAL);
      } else {
        expect(result.stdout, output).toContain("__READY__");
        expect(output).not.toContain("__REFUSED__");
        const receipts = result.stdout.split("\n").find((line) => line.startsWith("__RECEIPTS__"));
        expect(
          JSON.parse(
            expectDefined(receipts, "startup migration receipts").slice("__RECEIPTS__".length),
          ),
        ).toContainEqual(
          expect.objectContaining({
            id: "migration-detection",
            outcome: "deferred",
            warnings: [reason],
          }),
        );
        expect(output).toContain("Startup migration warnings; continuing with degraded state.");
        expect(fs.existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
        expect(fs.readdirSync(stateDir)).toContainEqual(
          expect.stringMatching(/^exec-approvals\.json\.migrated\./),
        );
      }
      expect(output).toContain(STARTUP_RECOVERY);
      expect(output).toContain(reason);
      expect(fs.readFileSync(legacyPath)).toEqual(before);
      expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    },
    75_000,
  );
});
