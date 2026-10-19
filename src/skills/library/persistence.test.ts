import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  assertPersistenceBundle as assertBundle,
  assertPersistenceFiles as assertFiles,
  assertPersistenceSelection as assertSelection,
  persistenceRevisionDir as revisionDir,
  readPersistenceDisk as readDisk,
  runPersistenceChild as runChild,
  withPersistenceChild as withChild,
} from "./persistence.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const makeRoot = () => fs.realpath(tempDirs.make("skill-library-persistence-"));

async function fixture(signal: AbortSignal) {
  const root = await makeRoot();
  const run = (command: Parameters<typeof runChild>[1]) => runChild(root, command, signal);
  expect((await run({ action: "seed" })).kind).toBe("seeded");
  const before = readDisk(root);
  return {
    root,
    run,
    before,
    pin: before.pins[0]!,
    hold: (command: Parameters<typeof withChild>[1], use: Parameters<typeof withChild>[3]) =>
      withChild(root, command, signal, use),
    async assertReopened() {
      assertSelection(root, await run({ action: "read" }), before.pins);
    },
  };
}

describe("skill library persistence across process lifetimes", () => {
  it("reopens personal and team pins with complete original bytes after revision replacement, rename, and removal", async ({
    signal,
  }) => {
    const { root, run, before } = await fixture(signal);
    expect(before.pins).toHaveLength(2);
    expect(before.pins.filter((pin) => pin.ownerProfileId === null)).toHaveLength(1);
    expect(before.pins.filter((pin) => pin.ownerProfileId !== null)).toHaveLength(1);
    for (const pin of before.pins) {
      await assertBundle(root, pin, "old");
    }

    // Both writes happen after the creating process has closed, and neither process
    // survives to supply an in-memory catalog or pin cache to the final reader.
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

  // Windows does not expose POSIX SIGKILL exit semantics or portable directory fsync.
  // Restart/byte persistence above still runs there; these two tests prove the POSIX crash path.
  it.runIf(process.platform !== "win32")(
    "keeps the original pointer and pin when a publisher is killed after all filesystem publication syncs",
    async ({ signal }) => {
      const { root, run, before, pin, hold, assertReopened } = await fixture(signal);
      let orphanRevision = "";
      await hold({ action: "publish-hold", pin, version: "orphan" }, async (reply, child) => {
        expect(reply.kind).toBe("published");
        if (reply.kind !== "published") {
          throw new Error("Publisher missed the real publication barrier");
        }
        orphanRevision = path.basename(reply.directory);
        expect(reply.directory).toBe(revisionDir(root, { ...pin, revision: orphanRevision }));
        await assertBundle(root, { ...pin, revision: orphanRevision }, "orphan", false);
        // Observe committed SQLite through a second native connection while the publisher
        // is held, then again after SIGKILL; no receipt is used as commit evidence.
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
        if (live.kind !== "staged") {
          throw new Error("Expected a real live publisher stage");
        }
        await fs.utimes(live.directory, oldTime, oldTime);
        let deadStage = "";
        let deadPid = 0;
        await hold({ action: "stage-hold", pin, version: "orphan" }, async (dead, child) => {
          if (dead.kind !== "staged") {
            throw new Error("Expected a real abandoned publisher stage");
          }
          deadStage = dead.directory;
          deadPid = child.pid;
          await child.kill();
        });
        expect(() => process.kill(deadPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        await fs.utimes(deadStage, oldTime, oldTime);
        const preserved = [
          { name: `.staging-${deadPid}-recent`, old: false },
          { name: ".staging-unknown-owner", old: true },
          { name: ".staging-9007199254740992-ambiguous", old: true },
        ];
        for (const stage of preserved) {
          const directory = path.join(parent, stage.name);
          await fs.mkdir(directory);
          await fs.writeFile(path.join(directory, "sentinel"), stage.name);
          if (stage.old) {
            await fs.utimes(directory, oldTime, oldTime);
          }
        }
        const foreign = path.join(root, "foreign-content");
        await fs.mkdir(foreign);
        await fs.writeFile(path.join(foreign, "sentinel"), "not owned by the publisher");
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
        for (const stage of preserved) {
          expect(await fs.readFile(path.join(parent, stage.name, "sentinel"), "utf8")).toBe(
            stage.name,
          );
        }
        expect(await fs.readlink(linked)).toBe(foreign);
        expect(await fs.readFile(path.join(foreign, "sentinel"), "utf8")).toBe(
          "not owned by the publisher",
        );
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
});
