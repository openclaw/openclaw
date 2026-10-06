import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { createScopedSqliteReadOnlyWorker } from "./sqlite-readonly-worker.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform !== "win32")(
  "reports the real SQLite write errcode across the isolated worker boundary",
  () => {
    const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-worker-full-");
    const sqlite = requireNodeSqlite();
    const databasePath = path.join(tempDirs.make("openclaw-sqlite-diagnostics-"), "state.sqlite");
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE probe (payload BLOB); INSERT INTO probe VALUES (zeroblob(8192));");
    database.close();
    const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
    const extension = workerUrl.pathname.endsWith(".ts") ? ".ts" : ".js";
    const moduleUrl = new URL(`./sqlite-snapshot-source${extension}`, workerUrl).href;
    const script = `
      const { prepareSqliteReadOnlyLocation } = await import(${JSON.stringify(moduleUrl)});
      try {
        await prepareSqliteReadOnlyLocation(${JSON.stringify(databasePath)});
        process.exitCode = 24;
      } catch (error) {
        console.log(JSON.stringify({ message: error.message }));
      }
    `;
    const child = spawnSync(
      "/bin/sh",
      [
        "-c",
        'ulimit -f 1; exec "$@"',
        "openclaw-sqlite-snapshot-quota",
        process.execPath,
        ...resolveRuntimeWorkerArgv(workerUrl).slice(0, -1),
        "--input-type=module",
        "-e",
        script,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      },
    );

    expect(child.status, child.stderr).toBe(0);
    const reported = JSON.parse(child.stdout) as { message: string };
    expect(reported.message).toContain(cacheRoot);
    expect(reported.message).toContain("check filesystem health and write permissions");
    expect(reported.message).not.toContain("free disk space/quota");
    expect(reported.message).toContain("(code=ERR_SQLITE_ERROR, errcode=778)");
  },
);

it("distinguishes actual worker startup from serialized directory creation failures", async () => {
  const root = tempDirs.make("openclaw-sqlite-worker-diagnostics-");
  const notDirectory = path.join(root, "file");
  fs.writeFileSync(notDirectory, "preserved");
  const allocationError = await createSqliteSnapshotStagingDirectory(
    notDirectory,
    false,
    undefined,
    true,
  ).catch((error: unknown) => error);
  expect(allocationError).toBeInstanceOf(Error);
  expect((allocationError as Error).message).toContain(`snapshot staging root ${notDirectory}`);
  expect((allocationError as Error).message).toContain("XDG_CACHE_HOME");
  expect((allocationError as Error).message).not.toContain("free disk space/quota");
  expect((allocationError as Error).message.match(/snapshot staging root/gu)).toHaveLength(1);
  expect(fs.readFileSync(notDirectory, "utf8")).toBe("preserved");

  const cwd = path.join(root, "missing-cwd");
  const worker = createScopedSqliteReadOnlyWorker({
    cwd,
    env: { ...process.env },
    transport: { kind: "native" },
    retainLifetime: false,
  });
  try {
    const startupError = await worker
      .run(root, { mode: "staging-create" })
      .catch((error: unknown) => error);
    expect(startupError).toMatchObject({ code: "ENOENT", cause: { code: "ENOENT" } });
    expect((startupError as Error).message).toContain(process.execPath);
    expect((startupError as Error).message).toContain(cwd);
    expect((startupError as Error).message).not.toContain("XDG_CACHE_HOME");
  } finally {
    await worker.close();
  }
});
