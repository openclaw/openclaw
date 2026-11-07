import "../../test-utils/prepare-compiled-subprocesses.js";
import "./backup-worker.test-support.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { runDatabasePortTask } from "./port-command.worker.js";
import { loadStatePortDescriptor } from "./state-port-descriptor.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const hash = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

describe.skipIf(!connection)("resumed staging admission", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  beforeAll(() => client.connect());
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it.each([OPENCLAW_STATE_SCHEMA_VERSION - 1, OPENCLAW_STATE_SCHEMA_VERSION])(
    "requires descriptor admission after verified resume with content marker %s",
    { timeout: 120_000 },
    async (contentVersion) => {
      const admitted = contentVersion === OPENCLAW_STATE_SCHEMA_VERSION;
      const descriptor = await loadStatePortDescriptor();
      const directory = tempDirs.make("port-resume-admission-");
      const sourcePath = path.join(directory, "source.sqlite");
      const targetPath = path.join(directory, "target.sqlite");
      const storeId = randomUUID();
      const namespace = `port_resume_${storeId.replaceAll("-", "")}`;
      namespaces.add(namespace);
      {
        using source = openNodeSqliteDatabase(sourcePath);
        source.exec(descriptor.sqlite);
        for (const fragment of descriptor.fragments ?? []) {
          source.exec(fragment.sqlite);
        }
        source.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
          INSERT INTO schema_meta VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);
          INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${contentVersion}', 1)`);
        expect(descriptor.inspectSqliteSource!(source)).toMatchObject({
          version: OPENCLAW_STATE_SCHEMA_VERSION,
          migrationRequired: false,
        });
      }
      const config = { database: { engine: "postgres" as const, postgres: { connection } } };
      const stage = (resume: boolean) =>
        runDatabasePortTask(
          {
            operation: "stage",
            sourcePath,
            targetPath,
            to: "postgres",
            namespace,
            storeId,
            config,
            resume,
          },
          { assertCurrent() {} },
        );
      const freshAccepted = await stage(false).then(
        () => true,
        () => false,
      );
      expect(freshAccepted).toBe(admitted);
      const anchor = await hash(targetPath);

      const resumedAccepted = await stage(true).then(
        () => true,
        () => false,
      );
      expect(resumedAccepted).toBe(admitted);
      expect(await hash(targetPath)).toBe(anchor);
      const subsequentAdmission = descriptor.admit!(targetPath, {
        connection: connection!,
        schemaPrefix: "test",
      });
      if (admitted) {
        await expect(subsequentAdmission).resolves.toBeUndefined();
      } else {
        await expect(subsequentAdmission).rejects.toThrow();
      }
    },
  );
});
