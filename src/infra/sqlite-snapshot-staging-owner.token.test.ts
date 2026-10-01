import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { startTokenAdmission } from "./sqlite-snapshot-staging-owner.token.js";
import { sqliteSnapshotStagingEntrypoints } from "./sqlite-snapshot-staging-runtime.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it("rejects inconsistent directory facts before creating a token or capturing a native owner", () => {
  const directory = directories.make("staging-directory-facts-");
  const original = fs.lstatSync(directory, { bigint: true });
  let captures = 0;
  expect(() =>
    startTokenAdmission(
      () => {
        captures += 1;
        throw new Error("Native owner must not be captured for inconsistent directory facts");
      },
      directory,
      "create",
      {
        expectedDirectoryIdentity: {
          dev: String(original.dev),
          ino: String(original.ino + 1n),
        },
      },
    ),
  ).toThrow("SQLite staging directory ownership changed before token creation");
  expect(captures).toBe(0);
  expect(fs.readdirSync(directory)).toEqual([]);
});

// Fresh child processes isolate token ownership from the parent test runtime setup.
async function runNativeTokenCase(name: string, body: string): Promise<void> {
  const root = directories.make(`staging-native-token-${name}-`);
  const ownerUrl = resolveRuntimeWorkerUrl(sqliteSnapshotStagingEntrypoints.owner);
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    import { startWorkerOwnedSqliteStagingToken } from ${JSON.stringify(ownerUrl.href)};
    const root = ${JSON.stringify(root)};
    const directory = path.join(root, 'owned');
    fs.mkdirSync(directory, { mode: 0o700 });
    const location = path.join(directory, 'owner.sqlite');
    const sentinel = path.join(directory, 'payload.txt');
    fs.writeFileSync(sentinel, 'caller-owned payload');
    const admissions = [];
    const begin = (mode) => {
      const admission = startWorkerOwnedSqliteStagingToken(directory, mode);
      admissions.push(admission);
      return admission;
    };
    const identity = (pathname) => {
      const stat = fs.lstatSync(pathname, { bigint: true });
      return { dev: String(stat.dev), ino: String(stat.ino) };
    };
    const version = (pathname = location) => {
      const database = new DatabaseSync(pathname, { readOnly: true, timeout: 0 });
      try { return database.prepare('PRAGMA user_version').get().user_version; }
      finally { database.close(); }
    };
    const assertLocked = () => {
      let probe;
      try {
        assert.throws(() => {
          probe = new DatabaseSync(location, { timeout: 0 });
          probe.exec('BEGIN IMMEDIATE');
        }, /locked|busy/i);
      } finally {
        if (probe?.isTransaction) probe.exec('ROLLBACK');
        probe?.close();
      }
    };
    try {
      ${body}
    } finally {
      const released = await Promise.allSettled(
        admissions.toReversed().map((admission) => admission.startRelease().result),
      );
      for (const release of released) assert.equal(release.status, 'fulfilled');
    }
    console.log(JSON.stringify({ case: ${JSON.stringify(name)}, complete: true }));
  `;
  const result = await runCommandWithTimeout(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(ownerUrl).slice(0, -1),
      "--input-type=module",
      "-e",
      script,
    ],
    {
      timeoutMs: 30_000,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
    },
  );
  expect(result.termination).toBe("exit");
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stdout.trim() === JSON.stringify({ case: name, complete: true })).toBe(true);
}

it("creates and reclaims actual native tokens with distinct close and retirement authority", async () => {
  await runNativeTokenCase(
    "create-reclaim",
    `
    const created = begin('create');
    assert.deepEqual(created.identity, {
      directory: identity(directory), token: identity(location),
    });
    const originalIdentity = created.identity;
    const token = await created.result;
    assert.deepEqual(token.identity, originalIdentity);
    assert.equal(token.isCurrent(), true);
    assertLocked();
    const originalBytes = fs.readFileSync(location);
    assert.throws(() => startWorkerOwnedSqliteStagingToken(directory, 'create'), { code: 'EEXIST' });
    assert.deepEqual(fs.readFileSync(location), originalBytes);
    assert.equal(token.isCurrent(), true);
    await token.close();
    await created.startRelease().result;
    assert.equal(token.isCurrent(), false);
    assert.equal(version(), 0);
    await assert.rejects(token.retire(), /closed without retirement/);
    assert.equal(version(), 0);

    const reclaim = begin('reclaim');
    assert.deepEqual(reclaim.identity, originalIdentity);
    const reclaimed = await reclaim.result;
    assert.equal(reclaimed.isCurrent(), true);
    assertLocked();
    await reclaim.startClose().result;
    assert.equal(reclaimed.isCurrent(), false);
    assert.equal(version(), 0, 'reclaim close does not grant destructive retirement');
    await assert.rejects(reclaimed.retire(), /closed without retirement/);

    const finalAdmission = begin('reclaim');
    const finalToken = await finalAdmission.result;
    assert.deepEqual(finalToken.identity, originalIdentity);
    await finalToken.retire();
    assert.equal(finalToken.isCurrent(), false);
    assert.equal(version(), 1);
    assert.deepEqual(identity(location), originalIdentity.token);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'caller-owned payload');
    assert.equal(fs.existsSync(directory), true, 'token retirement itself never deletes caller bytes');
  `,
  );
});

it("refuses a locked reclaim and joins non-destructive cleanup before later native admission", async () => {
  await runNativeTokenCase(
    "locked-reclaim",
    `
    const original = begin('create');
    await (await original.result).close();
    const blocker = new DatabaseSync(location, { timeout: 0 });
    let held = true;
    try {
      blocker.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('preserved');");
      // A separate descriptor close would cancel this process's SQLite POSIX lock.
      const bytes = fs.readFileSync(location);
      blocker.exec('BEGIN');
      assert.equal(blocker.prepare('SELECT value FROM marker').get().value, 'preserved');
      const refused = begin('reclaim');
      assert.deepEqual(refused.identity, original.identity);
      let refusal;
      await assert.rejects(refused.result, (error) => {
        refusal = error;
        assert.match(error.message, /locked|busy/i);
        return true;
      });
      await refused.startRelease().result;
      assert.equal(refused.read().status, 'rejected');
      assert.equal(refused.read().error, refusal);
      assert.equal(blocker.prepare('PRAGMA user_version').get().user_version, 0);
      blocker.exec('ROLLBACK'); blocker.close(); held = false;
      assert.deepEqual(fs.readFileSync(location), bytes);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'caller-owned payload');
      const admitted = begin('reclaim');
      const token = await admitted.result;
      assert.equal(token.isCurrent(), true);
      await token.retire();
      assert.equal(version(), 1);
    } finally {
      if (held) { if (blocker.isTransaction) blocker.exec('ROLLBACK'); blocker.close(); }
    }
  `,
  );
});

it.skipIf(process.platform === "win32").each(["token", "directory"] as const)(
  "refuses retirement after the captured %s inode changes without damaging its replacement",
  async (replaced) => {
    await runNativeTokenCase(
      `stale-${replaced}`,
      `
      const admission = begin('create');
      const token = await admission.result;
      assert.equal(token.isCurrent(), true);
      assertLocked();
      const originalIdentity = admission.identity;
      const saved = path.join(root, 'original');
      let originalToken;
      if (${JSON.stringify(replaced)} === 'directory') {
        fs.renameSync(directory, saved);
        fs.mkdirSync(directory, { mode: 0o700 });
        originalToken = path.join(saved, 'owner.sqlite');
      } else {
        fs.renameSync(location, saved);
        originalToken = saved;
      }
      const replacement = new DatabaseSync(location);
      replacement.exec('PRAGMA user_version=0'); replacement.close();
      fs.writeFileSync(sentinel, 'replacement payload');
      const replacementIdentity = { directory: identity(directory), token: identity(location) };
      assert.notDeepEqual(replacementIdentity, originalIdentity);
      const bytes = fs.readFileSync(location);
      const messages = (error) => [
        error?.message ?? '',
        ...(error?.cause ? messages(error.cause) : []),
        ...(error instanceof AggregateError ? error.errors.flatMap(messages) : []),
      ];
      await assert.rejects(token.retire(), (error) => {
        assert.match(messages(error).join(' | '), /ownership changed/);
        return true;
      });
      assert.equal(token.isCurrent(), false);
      assert.deepEqual(identity(location), replacementIdentity.token);
      assert.deepEqual(fs.readFileSync(location), bytes);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'replacement payload');
      await token.close();
      await admission.startRelease().result;
      assert.deepEqual(fs.readFileSync(location), bytes);
      assert.equal(version(), 0);
      assert.equal(version(originalToken), 0);
    `,
    );
  },
);
