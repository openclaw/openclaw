import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as scratch from "../infra/backup-scratch.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { encodeTarEntry } from "./backup-tar.test-support.js";
import { verifyBackupArchive } from "./backup-verify.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function createArchive(directory: string) {
  const sqlitePath = path.join(directory, "fixture.sqlite");
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT NOT NULL);
      INSERT INTO schema_meta VALUES ('primary', 'global');
      CREATE TABLE agent_databases (agent_id TEXT NOT NULL, path TEXT NOT NULL);
    `);
  } finally {
    database.close();
  }
  const payload = "backup/payload/posix/fixture/state";
  const bytes = await fs.readFile(sqlitePath);
  await fs.rm(sqlitePath);
  const archive = path.join(directory, "archive.tar.gz");
  await fs.writeFile(
    archive,
    gzipSync(
      Buffer.concat([
        encodeTarEntry({ path: `${payload}/state/openclaw.sqlite`, contents: bytes }),
        encodeTarEntry({ path: `${payload}/opaque.sqlite`, contents: bytes }),
        encodeTarEntry({
          path: "backup/manifest.json",
          contents: JSON.stringify({
            schemaVersion: 1,
            archiveRoot: "backup",
            createdAt: "2026-03-09T00:00:00.000Z",
            runtimeVersion: "test",
            platform: "linux",
            nodeVersion: process.version,
            paths: { stateDir: "/fixture/state" },
            assets: [{ kind: "state", sourcePath: "/fixture/state", archivePath: payload }],
          }),
        }),
        Buffer.alloc(1024),
      ]),
    ),
  );
  return archive;
}

function pausedVerifier(archive: string, temporaryRoot: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
      "--input-type=module",
      "--eval",
      `
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import { once } from 'node:events';
        import { verifyBackupArchive } from './src/commands/backup-verify.ts';
        const rename = fs.rename;
        let paused = false;
        fs.rename = async (source, destination) => {
          await rename(source, destination);
          if (!paused && /^candidate-\\d+$/.test(path.basename(source))) {
            paused = true;
            const resumed = once(process, 'message');
            process.send(path.dirname(source));
            await resumed;
          }
        };
        const result = await verifyBackupArchive(process.argv[1]);
        if (!result.ok) throw new Error('verification failed');
        process.disconnect();
      `,
      archive,
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = once(child, "close").then(([code, signal]) => ({ code, signal, stderr }));
  const directory = awaitGateBeforeSettlement(
    once(child, "message").then(([message]) => {
      if (typeof message !== "string") {
        throw new Error("Verifier did not identify its materialized scratch");
      }
      return message;
    }),
    closed.then((result) => {
      throw new Error(`Verifier exited before materialization: ${JSON.stringify(result)}`);
    }),
    "Verifier exited before materialization",
  );
  return { child, closed, directory };
}

it("reclaims a killed verifier without deleting a live verifier or its archive", async ({
  signal,
}) => {
  const root = dirs.make("backup-verifier-lifetime-");
  const temporaryRoot = path.join(root, "tmp");
  await fs.mkdir(temporaryRoot);
  const archive = await createArchive(root);
  const identity = await fs.stat(archive, { bigint: true });
  const digest = createHash("sha256")
    .update(await fs.readFile(archive))
    .digest("hex");
  const legacy = path.join(temporaryRoot, "openclaw-backup-verify-Legacy");
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, "candidate-0"), "unclaimed legacy content");
  const killed = pausedVerifier(archive, temporaryRoot);
  const live = pausedVerifier(archive, temporaryRoot);
  try {
    const [abandoned, active] = await withinTest(
      Promise.all([killed.directory, live.directory]),
      signal,
    );
    killed.child.kill("SIGKILL");
    await withinTest(killed.closed, signal);
    const report = await scratch.maintainBackupScratch({ roots: [temporaryRoot], repair: true });
    expect(report).toMatchObject({ reclaimed: [abandoned], active: [active], warnings: [] });
    await expect(fs.stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(active)).resolves.toContain("payload");
    await expect(fs.readFile(path.join(legacy, "candidate-0"), "utf8")).resolves.toBe(
      "unclaimed legacy content",
    );
    live.child.send("resume");
    const result = await withinTest(live.closed, signal);
    expect(result.code, result.stderr).toBe(0);
    await expect(fs.stat(active)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.stat(archive, { bigint: true })).toMatchObject({
      dev: identity.dev,
      ino: identity.ino,
    });
    expect(
      createHash("sha256")
        .update(await fs.readFile(archive))
        .digest("hex"),
    ).toBe(digest);
  } finally {
    killed.child.kill("SIGKILL");
    live.child.kill("SIGKILL");
    await Promise.all([killed.closed, live.closed]);
  }
});

it("verifies an archive inside released scratch without reclaiming the selected input", async () => {
  const root = dirs.make("backup-verifier-selected-");
  const owner = await scratch.createBackupScratchDirectory(root);
  const archive = await createArchive(owner.directory);
  const identity = await fs.stat(archive, { bigint: true });
  owner.release();
  vi.spyOn(os, "tmpdir").mockReturnValue(root);
  await expect(verifyBackupArchive(archive)).resolves.toMatchObject({ ok: true });
  expect(await fs.stat(archive, { bigint: true })).toMatchObject({
    dev: identity.dev,
    ino: identity.ino,
  });
  await expect(fs.readdir(root)).resolves.toEqual([path.basename(owner.directory)]);
});

it("rejects verification when scratch retirement fails", async () => {
  const root = dirs.make("backup-verifier-retirement-");
  const archive = await createArchive(root);
  const finish = scratch.finishBackupScratch;
  vi.spyOn(scratch, "finishBackupScratch").mockImplementation(async (...args) => {
    await finish(...args);
    return "Backup scratch retirement failed: synthetic cleanup refusal";
  });
  await expect(verifyBackupArchive(archive)).rejects.toThrow("synthetic cleanup refusal");
  await expect(fs.stat(archive)).resolves.toBeDefined();
});
