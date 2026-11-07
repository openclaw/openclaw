import "../../test-utils/prepare-compiled-subprocesses.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "../../commands/doctor-config-preflight.process.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { DatabasePortManifest } from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { loadStatePortDescriptor } from "./state-port-descriptor.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const roots = useAutoCleanupTempDirTracker(afterAll);
const hash = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

describe.skipIf(!connection)("built CLI resumed staging admission", () => {
  const client = new Client({ connectionString: connection });
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  it(
    "refuses inadmissible resume without publication or anchor loss",
    {
      timeout: 600_000,
    },
    async () => {
      const root = roots.make("port-resume-cli-");
      const runtimeRoot = createBuiltRuntime(root);
      const stateDir = path.join(root, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const schemaPrefix = `port_resume_cli_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
        INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${OPENCLAW_STATE_SCHEMA_VERSION - 1}', 1)`);
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
      const expectCleanOutput = (result: { stdout: string; stderr: string }) => {
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).not.toContain(connection!);
        const password = new URL(connection!).password;
        if (password) {
          expect(output).not.toContain(decodeURIComponent(password));
        }
      };
      try {
        const fresh = await run([
          "database",
          "port",
          "--family",
          "state",
          "--to",
          "postgres",
          "--json",
        ]);
        expectCleanOutput(fresh);
        expect(fresh.code).not.toBe(0);
        const failed = await readManifest();
        expect(failed.targets[0]?.verification).toBeNull();
        const anchorPath = path.join(
          stateDir,
          "recovery",
          "database-port",
          failed.operationId,
          "0",
          "target.sqlite",
        );
        const anchor = await hash(anchorPath);
        const originalCapture = failed.targets[0]!.originalCapture;
        expect(await hash(originalCapture.path)).toBe(originalCapture.sha256);
        expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);

        const resumed = await run(["database", "port", "--resume", manifestPath, "--json"]);
        expectCleanOutput(resumed);
        expect(resumed.code).not.toBe(0);
        expect((await readManifest()).targets[0]?.verification).toBeNull();
        expect(await hash(anchorPath)).toBe(anchor);
        expect(await hash(originalCapture.path)).toBe(originalCapture.sha256);
        expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
      } finally {
        const schemas = await client.query<{ schema_name: string }>(
          "SELECT schema_name FROM information_schema.schemata WHERE starts_with(schema_name, $1)",
          [schemaPrefix],
        );
        for (const { schema_name: schema } of schemas.rows) {
          await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
      }
    },
  );
});
