import { copyFileSync, renameSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { inspectCliGatewayServiceInstallation } from "../cli/run-main-service-installation.js";
import { captureConfigHealthStateStore } from "../config/io.health-state.js";
import { buildLaunchAgentPlist } from "../daemon/launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "../daemon/launchd-plist.test-support.js";
import { resolveLaunchAgentPlistPath } from "../daemon/launchd-service-files.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import * as processExec from "../process/exec.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  }),
);

function readPersistedSchema(pathname: string) {
  const db = new DatabaseSync(pathname, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get(),
      metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
      content: db.prepare("SELECT * FROM config_machine_state").all(),
      schema: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(),
    };
  } finally {
    db.close();
  }
}

function createExistingState(mutate: (db: DatabaseSync) => void) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("service-state-") };
  const pathname = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabase();
  const db = new DatabaseSync(pathname);
  try {
    mutate(db);
  } finally {
    db.close();
  }
  // Model a previous process's physical database, not a stale admitted inode.
  copyFileSync(pathname, pathname + ".fixture");
  renameSync(pathname + ".fixture", pathname);
  return { options: { env, path: pathname } };
}

async function writeHealth(env: { OPENCLAW_STATE_DIR: string }) {
  const health = captureConfigHealthStateStore(
    { env, homedir: () => env.OPENCLAW_STATE_DIR, logger: console },
    path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
  );
  try {
    await health.update({ lastObservedSuspiciousSignature: "skew" }, { state: {}, basis: null });
  } finally {
    health[Symbol.dispose]();
  }
}

describe("installed service migration fence", () => {
  it("refuses ordinary config health worker migration without changing persisted schema", async () => {
    const { options } = createExistingState((db) => {
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
        UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}
          WHERE meta_key = 'primary';`);
    });
    const home = tempDirs.make("older-installed-service-");
    const root = path.join(home, "package");
    await fs.mkdir(root);
    await fs.writeFile(
      path.join(root, "package.json"),
      '{"name":"openclaw","version":"2026.10.3"}',
    );
    const entry = path.join(root, "openclaw.mjs");
    await fs.writeFile(entry, "");
    const env = {
      ...options.env,
      HOME: home,
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.migration-test",
    };
    const plist = resolveLaunchAgentPlistPath(env);
    await fs.mkdir(path.dirname(plist), { recursive: true });
    await fs.writeFile(
      plist,
      buildLaunchAgentPlist({
        programArguments: [process.execPath, entry, "gateway"],
        environment: env,
        label: env.OPENCLAW_LAUNCHD_LABEL,
        stdoutPath: path.join(home, "stdout.log"),
        stderrPath: path.join(home, "stderr.log"),
      }),
    );
    const plutil =
      process.platform === "darwin"
        ? undefined
        : vi
            .spyOn(processExec, "runExec")
            .mockImplementation(async (file, args, commandOptions) => {
              if (
                file !== "/usr/bin/plutil" ||
                typeof commandOptions !== "object" ||
                !commandOptions.input
              ) {
                throw new Error("Unexpected native command");
              }
              return decodeLaunchAgentPlistFixture(commandOptions.input, args[1]);
            });
    const installation = await withMockedPlatform("darwin", () =>
      inspectCliGatewayServiceInstallation(env),
    );
    plutil?.mockRestore();
    expect(installation?.databasePath).toBe(options.path);
    const before = readPersistedSchema(options.path);
    const context = { environment: options.env, gatewayServiceInstallation: installation };
    const operation = runWithSqliteWorkerStateContext(context, () => writeHealth(options.env));
    const refusal: unknown = await operation.catch((error: unknown) => error);
    expect(readPersistedSchema(options.path)).toEqual(before);
    expect(refusal).toMatchObject({
      message: expect.stringMatching(/Gateway service runs 2026\.10\.3/u),
    });
  });
});

it.each(["different", "new"] as const)(
  "allows ordinary state initialization for a %s database",
  async (mode) => {
    const options =
      mode === "different"
        ? createExistingState((db) => {
            const version = OPENCLAW_STATE_SCHEMA_VERSION - 1;
            db.exec(
              "PRAGMA user_version = " +
                version +
                "; UPDATE schema_meta SET schema_version = " +
                version +
                " WHERE meta_key = 'primary'",
            );
          }).options
        : (() => {
            const env = { OPENCLAW_STATE_DIR: tempDirs.make("new-service-state-") };
            return { env, path: path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite") };
          })();
    await runWithSqliteWorkerStateContext(
      {
        environment: options.env,
        gatewayServiceInstallation: {
          root: "/old",
          version: "2026.10.3",
          cliVersion: "2026.11.4",
          databasePath:
            mode === "different"
              ? path.join(tempDirs.make("other-service-"), "openclaw.sqlite")
              : options.path,
        },
      },
      () => {
        // The existing-database control targets migration admission, not health publication.
        // A newly created database also exercises the ordinary health worker end to end.
        return mode === "different" ? openOpenClawStateDatabase(options) : writeHealth(options.env);
      },
    );
    expect(readPersistedSchema(options.path).version).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  },
);
