import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  assertPersistenceBundle as assertBundle,
  assertPersistenceFiles as assertFiles,
  assertPersistenceSelection as assertSelection,
  persistenceRevisionDir as revisionDir,
  readPersistenceDisk as readDisk,
  withPersistenceChild as withChild,
} from "./persistence.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(signal: AbortSignal) {
  const root = await fs.realpath(tempDirs.make("skill-library-persistence-"));
  const run = (command: Parameters<typeof withChild>[1]) => withChild(root, command, signal);
  expect((await run({ action: "seed" })).kind).toBe("seeded");
  const before = readDisk(root);
  return {
    root,
    run,
    before,
    pin: before.pins[0]!,
    hold: (command: Parameters<typeof withChild>[1], use: Parameters<typeof withChild>[3]) =>
      withChild(root, command, signal, use),
    assertReopened: async () => assertSelection(root, await run({ action: "read" }), before.pins),
  };
}

it("reopens original pins after replacement, rename, and removal", async ({ signal }) => {
  const { root, run, before } = await fixture(signal);
  const owners = before.pins
    .map((pin) => pin.ownerProfileId === null)
    .toSorted((a, b) => Number(a) - Number(b));
  expect(owners).toEqual([false, true]);
  for (const pin of before.pins) {
    await assertBundle(root, pin, "old");
  }

  // Every operation runs in a new process, ruling out in-memory pin/catalog reuse.
  await run({ action: "update-remove" });
  const removed = readDisk(root);
  expect(removed.pins).toEqual(before.pins);
  expect(removed.revisions).toHaveLength(4);
  for (const pin of before.pins) {
    const current = removed.entries.find((row) => row.skill_id === pin.skillId)!;
    expect(current).toMatchObject({ removed: 1, slug: "renamed-procedure" });
    expect(current.current_revision).not.toBe(pin.revision);
    await assertBundle(root, { ...pin, revision: String(current.current_revision) }, "new");
    await assertBundle(root, pin, "old");
  }
  const reopened = await run({ action: "read" });
  assertSelection(root, reopened, before.pins);
  expect(reopened).toMatchObject({ kind: "selected", available: [] });
  expect(readDisk(root)).toEqual(removed);
});

// POSIX crash semantics; restart/byte persistence above also runs on Windows.
it.runIf(process.platform !== "win32")(
  "keeps the original pointer and pin when a publisher is killed after all filesystem publication syncs",
  async ({ signal }) => {
    const { root, run, before, pin, hold, assertReopened } = await fixture(signal);
    let orphanRevision = "";
    await hold({ action: "publish-hold", pin, version: "orphan" }, async (reply, child) => {
      assert.equal(reply.kind, "published", "Publisher missed the real publication barrier");
      orphanRevision = path.basename(reply.directory);
      expect(reply.directory).toBe(revisionDir(root, { ...pin, revision: orphanRevision }));
      await assertBundle(root, { ...pin, revision: orphanRevision }, "orphan", false);
      // Read committed SQLite independently before and after SIGKILL, not the receipt.
      expect(readDisk(root)).toEqual(before);
      await child.kill();
    });
    expect(readDisk(root)).toEqual(before);
    await assertReopened();
    for (const selected of before.pins) {
      await assertBundle(root, selected, "old");
    }

    await run({ action: "save", pin, version: "new" });
    const recovered = readDisk(root);
    expect(recovered.revisions.some((row) => row.revision === orphanRevision)).toBe(false);
    expect(recovered.events.some((row) => row.revision === orphanRevision)).toBe(false);
    expect(recovered.pins).toEqual(before.pins);
    const recoveredRevision = String(
      recovered.entries.find((row) => row.skill_id === pin.skillId)?.current_revision,
    );
    expect(recoveredRevision).not.toBe(pin.revision);
    await assertBundle(root, { ...pin, revision: recoveredRevision }, "new");
    await assertBundle(root, { ...pin, revision: orphanRevision }, "orphan", false);
    await assertReopened();
  },
);

it.runIf(process.platform !== "win32")(
  "cleans only an aged owned dead-publisher stage while retaining live, recent, ambiguous, linked, and published content",
  async ({ signal }) => {
    const { root, run, before, pin, hold, assertReopened } = await fixture(signal);
    const oldTime = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const parent = path.dirname(revisionDir(root, pin));

    await hold({ action: "stage-hold", pin, version: "new" }, async (live, liveChild) => {
      assert.equal(live.kind, "staged", "Expected a real live publisher stage");
      await fs.utimes(live.directory, oldTime, oldTime);
      let deadStage = "";
      let deadPid = 0;
      await hold({ action: "stage-hold", pin, version: "orphan" }, async (dead, child) => {
        assert.equal(dead.kind, "staged", "Expected a real abandoned publisher stage");
        deadStage = dead.directory;
        deadPid = child.pid;
        await child.kill();
      });
      expect(() => process.kill(deadPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      await fs.utimes(deadStage, oldTime, oldTime);
      const preserved = [
        [`.staging-${deadPid}-recent`, false],
        [".staging-unknown-owner", true],
        [".staging-9007199254740992-ambiguous", true],
      ] as const;
      for (const [name, old] of preserved) {
        const directory = path.join(parent, name);
        await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, "sentinel"), name);
        if (old) {
          await fs.utimes(directory, oldTime, oldTime);
        }
      }
      const foreign = path.join(root, "foreign-content");
      await fs.mkdir(foreign);
      await fs.writeFile(path.join(foreign, "sentinel"), "foreign");
      const linked = path.join(parent, `.staging-${deadPid}-linked`);
      await fs.symlink(foreign, linked);
      await fs.lutimes(linked, oldTime, oldTime);
      const ordinaryFile = path.join(parent, `.staging-${deadPid}-file`);
      await fs.writeFile(ordinaryFile, "not a staging directory");
      await fs.utimes(ordinaryFile, oldTime, oldTime);

      await run({ action: "save", pin, version: "new" });
      await expect(fs.lstat(deadStage)).rejects.toMatchObject({ code: "ENOENT" });
      expect(process.kill(liveChild.pid, 0)).toBe(true);
      await assertFiles(live.directory, "new");
      for (const [name] of preserved) {
        expect(await fs.readFile(path.join(parent, name, "sentinel"), "utf8")).toBe(name);
      }
      expect(await fs.readlink(linked)).toBe(foreign);
      expect(await fs.readFile(path.join(foreign, "sentinel"), "utf8")).toBe("foreign");
      expect(await fs.readFile(ordinaryFile, "utf8")).toBe("not a staging directory");
      expect(readDisk(root).pins).toEqual(before.pins);
      for (const selected of before.pins) {
        await assertBundle(root, selected, "old");
      }
      await assertReopened();
      await liveChild.kill();
    });
  },
);
