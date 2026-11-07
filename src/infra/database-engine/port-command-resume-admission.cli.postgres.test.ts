import "../../test-utils/prepare-compiled-subprocesses.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { cliRecoveryEntrypoints } from "../../cli/cli-entrypoint.test-support.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "../../commands/doctor-config-preflight.process.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { DatabasePortManifest } from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import { loadStatePortDescriptor } from "./state-port-descriptor.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const roots = useAutoCleanupTempDirTracker(afterAll);
const freshArgs = ["database", "port", "--family", "state", "--to", "postgres", "--json"];
const hash = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
const expectCleanOutput = (result: { stdout: string; stderr: string }) => {
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output).not.toContain(connection!);
  const password = new URL(connection!).password;
  if (password) {
    expect(output).not.toContain(decodeURIComponent(password));
  }
};
const recoveryFile = (stateDir: string, manifest: DatabasePortManifest, filename: string) =>
  path.join(stateDir, "recovery", "database-port", manifest.operationId, "0", filename);

describe.skipIf(!connection)("built CLI resumed staging admission", () => {
  const client = new Client({ connectionString: connection });
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  const createCase = async (contentVersion: number) => {
    const root = roots.make("port-resume-cli-");
    const runtimeRoot = createBuiltRuntime(
      root,
      path.dirname(fileURLToPath(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli))),
    );
    const stateDir = path.join(root, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const schemaPrefix = `prc_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_TEST_CLI_DSN: connection,
      OPENCLAW_NO_RESPAWN: "1",
      CI: "1",
      NO_COLOR: "1",
    };
    const sourcePath = resolveOpenClawStateSqlitePath(env);
    const descriptor = await loadStatePortDescriptor();
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    {
      using source = openNodeSqliteDatabase(sourcePath);
      source.exec(descriptor.sqlite);
      for (const fragment of descriptor.fragments ?? []) {
        source.exec(fragment.sqlite);
      }
      source.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
        INSERT INTO schema_meta VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);
        INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${contentVersion}', 1);
        INSERT INTO config_machine_state VALUES ('port.resume.fixture', '{"retained":true}', 1)`);
    }
    await fs.writeFile(
      configPath,
      JSON.stringify({
        database: {
          engine: "sqlite",
          postgres: {
            connection: { source: "env", provider: "default", id: "OPENCLAW_TEST_CLI_DSN" },
            schemaPrefix,
          },
        },
        gateway: { mode: "local" },
        plugins: { enabled: false },
      }),
    );
    const originalConfig = await fs.readFile(configPath, "utf8");
    const manifestPath = path.join(stateDir, "recovery", "database-port", "manifest.json");
    const readManifest = async (): Promise<DatabasePortManifest> =>
      JSON.parse(await fs.readFile(manifestPath, "utf8")) as DatabasePortManifest;
    const run = (args: string[]) => runBuiltRuntime(runtimeRoot, env, args, 300_000);
    const validated = await run(["config", "validate", "--json"]);
    expect(validated.code, `${validated.stdout}\n${validated.stderr}`).toBe(0);
    return { stateDir, configPath, schemaPrefix, originalConfig, manifestPath, readManifest, run };
  };
  const cleanup = async (schemaPrefix: string) => {
    const schemas = await client.query<{ schema_name: string }>(
      "SELECT schema_name FROM information_schema.schemata WHERE starts_with(schema_name, $1)",
      [schemaPrefix],
    );
    for (const { schema_name: schema } of schemas.rows) {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  };

  it(
    "refuses inadmissible resume without publication or anchor loss",
    { timeout: 600_000 },
    async () => {
      const fixture = await createCase(OPENCLAW_STATE_SCHEMA_VERSION - 1);
      try {
        const fresh = await fixture.run(freshArgs);
        expectCleanOutput(fresh);
        expect(fresh.code).not.toBe(0);
        const failed = await fixture.readManifest().catch((error: unknown) => {
          throw new Error(
            `Fresh CLI did not create a recovery manifest.\nstdout:\n${fresh.stdout}\nstderr:\n${fresh.stderr}`,
            { cause: error },
          );
        });
        expect(failed.targets[0]?.verification).toBeNull();
        const anchorPath = recoveryFile(fixture.stateDir, failed, "target.sqlite");
        const anchor = await hash(anchorPath);
        const originalCapture = failed.targets[0]!.originalCapture;
        expect(await hash(originalCapture.path)).toBe(originalCapture.sha256);
        expect(await fs.readFile(fixture.configPath, "utf8")).toBe(fixture.originalConfig);

        const resumed = await fixture.run([
          "database",
          "port",
          "--resume",
          fixture.manifestPath,
          "--json",
        ]);
        expectCleanOutput(resumed);
        expect(resumed.code).not.toBe(0);
        expect((await fixture.readManifest()).targets[0]?.verification).toBeNull();
        expect(await hash(anchorPath)).toBe(anchor);
        expect(await hash(originalCapture.path)).toBe(originalCapture.sha256);
        expect(await fs.readFile(fixture.configPath, "utf8")).toBe(fixture.originalConfig);
      } finally {
        await cleanup(fixture.schemaPrefix);
      }
    },
  );

  it(
    "resumes a valid anchor after a post-admission recording failure",
    { timeout: 600_000 },
    async () => {
      const fixture = await createCase(OPENCLAW_STATE_SCHEMA_VERSION);
      try {
        const injectRecordingFailure = async () => {
          for (let attempt = 0; attempt < 3_000; attempt++) {
            try {
              const preparing = await fixture.readManifest();
              const blocked = recoveryFile(fixture.stateDir, preparing, "verification.json");
              await fs.mkdir(blocked);
              return blocked;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
              }
              await delay(10);
            }
          }
          throw new Error("Timed out waiting for the private recovery operation directory");
        };
        const [fresh, blocked] = await Promise.all([
          fixture.run(freshArgs),
          injectRecordingFailure(),
        ]);
        expectCleanOutput(fresh);
        expect(fresh.code).not.toBe(0);
        const staged = await fixture.readManifest();
        expect(staged.targets[0]?.verification).toBeNull();
        const anchorPath = recoveryFile(fixture.stateDir, staged, "target.sqlite");
        const anchor = await hash(anchorPath);
        const originalCapture = staged.targets[0]!.originalCapture;
        expect(await hash(originalCapture.path)).toBe(originalCapture.sha256);
        expect(await fs.readFile(fixture.configPath, "utf8")).toBe(fixture.originalConfig);

        await fs.rmdir(blocked);
        const resumed = await fixture.run([
          "database",
          "port",
          "--resume",
          fixture.manifestPath,
          "--json",
        ]);
        expectCleanOutput(resumed);
        expect(resumed.code, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
        const completed = JSON.parse(
          await fs.readFile(
            path.join(path.dirname(fixture.manifestPath), staged.operationId, "manifest.json"),
            "utf8",
          ),
        ) as DatabasePortManifest;
        expect(completed).toMatchObject({ state: "complete", outcome: "ported" });
        expect(completed.targets[0]?.verification).toMatchObject({ ownerAdmitted: true });
        expect(await hash(anchorPath)).toBe(anchor);
        expect(await hash(originalCapture.path)).toBe(originalCapture.sha256);
        const published = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
        expect(published.database.families.state.engine).toBe("postgres");
        expect(published.gateway.mode).toBe("local");
        const intended = staged.targets[0]!.intended;
        if (intended.engine !== "postgres") {
          throw new Error("Expected a PostgreSQL staging target");
        }
        const stored = await client.query(
          `SELECT value_json FROM "${intended.namespace}".config_machine_state WHERE state_key = 'port.resume.fixture'`,
        );
        expect(stored.rows).toEqual([{ value_json: '{"retained":true}' }]);
      } finally {
        await cleanup(fixture.schemaPrefix);
      }
    },
  );
});
