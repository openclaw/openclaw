import fs from "node:fs";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as durability from "./directory-durability.js";
import {
  assertLegacyMigrationSourceUnchanged,
  claimAndRemoveLegacyMigrationSource,
  claimLegacyMigrationSourceClaims,
  LegacyMigrationSourceClaim,
  legacyMigrationSourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  readLegacyMigrationSourceSnapshotSync,
  resolveLegacyMigrationRelativePath,
} from "./state-migrations.source-snapshot.js";

describe("doctor legacy migration source contract", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      configureFsSafeNative({ mode: "auto" });
      __setFsSafeTestHooksForTest(undefined);
      vi.restoreAllMocks();
      cleanup();
    });
  });

  function createSource(content = '{"version":1}\n') {
    const stateDir = tempDirs.make("openclaw-migration-source-");
    const sourcePath = path.join(stateDir, "legacy.json");
    fs.writeFileSync(sourcePath, content, "utf8");
    return { sourcePath, stateDir };
  }

  function createClaim(stateRoot: Root, stateDir: string, sourcePath: string) {
    return new LegacyMigrationSourceClaim({
      stateRoot,
      stateDir,
      sourcePath,
      label: "test",
      readSnapshot: (candidatePath) =>
        readLegacyMigrationSourceSnapshot({
          stateRoot,
          stateDir,
          sourcePath: candidatePath,
          maxBytes: 1024,
          label: "test",
        }),
    });
  }

  it("detects an interrupted claim without accepting absent source state", () => {
    const { sourcePath } = createSource();
    fs.renameSync(sourcePath, `${sourcePath}.doctor-importing`);
    expect(legacyMigrationSourceOrClaimMayExist(sourcePath)).toBe(true);
    fs.unlinkSync(`${sourcePath}.doctor-importing`);
    expect(legacyMigrationSourceOrClaimMayExist(sourcePath)).toBe(false);
  });

  it("rejects source paths outside the trusted migration root without exposing redacted paths", async () => {
    const { stateDir } = createSource();
    const outsidePath = path.join(stateDir, "..", "private-marker");
    expect(() => resolveLegacyMigrationRelativePath(stateDir, outsidePath, "test")).toThrow(
      "outside the state directory",
    );
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    expect(
      () =>
        new LegacyMigrationSourceClaim({
          stateRoot,
          stateDir,
          sourcePath: outsidePath,
          label: "test",
          includeFilePath: false,
          readSnapshot: () => Promise.reject(new Error("unreachable")),
        }),
    ).toThrowError(/^legacy test path is outside the state directory$/u);
  });

  it("shares the same pinned source identity across root-bound and sync readers", async () => {
    const { sourcePath, stateDir } = createSource();
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    const bounded = await readLegacyMigrationSourceSnapshot({
      stateRoot,
      stateDir,
      sourcePath,
      maxBytes: 1024,
      label: "test",
    });
    const sync = readLegacyMigrationSourceSnapshotSync({ sourcePath, label: "test" });
    expect(legacyMigrationSourceSnapshotsMatch(bounded, sync)).toBe(true);
    fs.writeFileSync(sourcePath, '{"version":2}\n', "utf8");
    expect(() =>
      assertLegacyMigrationSourceUnchanged({ sourcePath, snapshot: sync, label: "test" }),
    ).toThrow("changed after doctor loaded it");
  });

  it("restores the original source when verified claim cleanup fails", () => {
    const { sourcePath } = createSource();
    const snapshot = readLegacyMigrationSourceSnapshotSync({ sourcePath, label: "test" });
    expect(() =>
      claimAndRemoveLegacyMigrationSource({
        sourcePath,
        snapshot,
        label: "test",
        removeSource: () => {
          throw new Error("simulated cleanup failure");
        },
      }),
    ).toThrow("simulated cleanup failure");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(snapshot.raw);
    expect(fs.readdirSync(path.dirname(sourcePath))).toEqual(["legacy.json"]);
  });

  it("recovers interrupted claims without discarding a matching active source", async () => {
    const { sourcePath, stateDir } = createSource();
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    const claim = createClaim(stateRoot, stateDir, sourcePath);
    fs.copyFileSync(sourcePath, claim.claimPath);

    await claim.recover("interrupted source conflicts with its replacement");

    expect(fs.readFileSync(sourcePath, "utf8")).toBe('{"version":1}\n');
    expect(fs.existsSync(claim.claimPath)).toBe(false);

    fs.renameSync(sourcePath, claim.claimPath);
    await claim.recover("interrupted source conflicts with its replacement");

    expect(fs.readFileSync(sourcePath, "utf8")).toBe('{"version":1}\n');
    expect(fs.existsSync(claim.claimPath)).toBe(false);
  });

  it.each(["EINVAL", "ENOTSUP"])(
    "claims and restores the same inode when native no-replace rename returns %s",
    async (code) => {
      const { sourcePath, stateDir } = createSource();
      const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
      vi.spyOn(stateRoot, "move").mockRejectedValue(
        new FsSafeError("helper-unavailable", "native no-replace move is unavailable", {
          cause: Object.assign(new Error("unsupported rename flags"), { code }),
        }),
      );
      const claim = createClaim(stateRoot, stateDir, sourcePath);
      const snapshot = await claim.read();

      const claimed = await claim.claim({ snapshot, mismatchMessage: "source changed" });

      expect(legacyMigrationSourceSnapshotsMatch(claimed, snapshot)).toBe(true);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.statSync(claim.claimPath).nlink).toBe(1);
      expect(await claim.restore()).toBeNull();
      expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
      expect(fs.statSync(sourcePath).ino).toBe(snapshot.ino);
      expect(fs.existsSync(claim.claimPath)).toBe(false);
    },
  );

  it("claims and restores the same inode when native helper is unavailable without cause", async () => {
    const { sourcePath, stateDir } = createSource();
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    vi.spyOn(stateRoot, "move").mockRejectedValue(
      new FsSafeError("helper-unavailable", "native no-replace move is unavailable"),
    );
    const claim = createClaim(stateRoot, stateDir, sourcePath);
    const snapshot = await claim.read();

    const claimed = await claim.claim({ snapshot, mismatchMessage: "source changed" });

    expect(legacyMigrationSourceSnapshotsMatch(claimed, snapshot)).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.statSync(claim.claimPath).nlink).toBe(1);
    expect(await claim.restore()).toBeNull();
    expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
    expect(fs.statSync(sourcePath).ino).toBe(snapshot.ino);
    expect(fs.existsSync(claim.claimPath)).toBe(false);
  });

  it("refuses portable publication and leaves source untouched when native mode is require", async () => {
    const { sourcePath, stateDir } = createSource();
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    vi.spyOn(stateRoot, "move").mockRejectedValue(
      new FsSafeError("helper-unavailable", "native no-replace move is unavailable"),
    );
    configureFsSafeNative({ mode: "require" });
    try {
      const claim = createClaim(stateRoot, stateDir, sourcePath);
      const snapshot = await claim.read();

      await expect(claim.claim({ snapshot, mismatchMessage: "source changed" })).rejects.toThrow(
        "native no-replace move is unavailable",
      );

      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
      expect(fs.existsSync(claim.claimPath)).toBe(false);
    } finally {
      configureFsSafeNative({ mode: "auto" });
    }
  });

  it("preserves a competing claim created before portable publication", async () => {
    const { sourcePath, stateDir } = createSource();
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    const claim = createClaim(stateRoot, stateDir, sourcePath);
    const snapshot = await claim.read();
    vi.spyOn(stateRoot, "move").mockImplementationOnce(async () => {
      fs.writeFileSync(claim.claimPath, "another generation");
      throw new FsSafeError("helper-unavailable", "native no-replace move is unavailable", {
        cause: Object.assign(new Error("unsupported rename flags"), { code: "EINVAL" }),
      });
    });

    await expect(claim.claim({ snapshot, mismatchMessage: "source changed" })).rejects.toThrow();

    expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
    expect(fs.readFileSync(claim.claimPath, "utf8")).toBe("another generation");
  });

  it("retains the source when portable publication cannot sync its directory", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const { sourcePath, stateDir } = createSource();
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    vi.spyOn(stateRoot, "move").mockRejectedValue(
      new FsSafeError("helper-unavailable", "unsupported rename", {
        cause: Object.assign(new Error("unsupported rename flags"), { code: "EINVAL" }),
      }),
    );
    const publish = durability.publishFileExclusive;
    vi.spyOn(durability, "publishFileExclusive").mockImplementation(async (params) => ({
      ...(await publish(params)),
      directorySync: { status: "unsupported", code: "ENOTSUP" },
    }));
    const claim = createClaim(stateRoot, stateDir, sourcePath);
    const snapshot = await claim.read();

    await expect(claim.claim({ snapshot, mismatchMessage: "source changed" })).rejects.toThrow(
      "crash-durable directory synchronization",
    );

    expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
    expect(fs.statSync(claim.claimPath).ino).toBe(snapshot.ino);
  });

  it("keeps a Root's mutation authority instead of bypassing it with portable publication", async () => {
    const { sourcePath, stateDir } = createSource();
    const stateRoot = await root(stateDir, {
      hardlinks: "reject",
      symlinks: "reject",
      assertBeforeMutation: () => {},
    });
    const refusal = new FsSafeError("helper-unavailable", "unsupported rename", {
      cause: Object.assign(new Error("unsupported rename flags"), { code: "EINVAL" }),
    });
    vi.spyOn(stateRoot, "move").mockRejectedValue(refusal);
    const claim = createClaim(stateRoot, stateDir, sourcePath);
    const snapshot = await claim.read();

    await expect(claim.claim({ snapshot, mismatchMessage: "source changed" })).rejects.toBe(
      refusal,
    );

    expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
    expect(fs.existsSync(claim.claimPath)).toBe(false);
  });

  it("preserves a linked claim when the Root revokes recovery authority", async () => {
    const { sourcePath, stateDir } = createSource();
    const refusal = new Error("Migration authority was revoked.");
    const stateRoot = await root(stateDir, {
      hardlinks: "reject",
      symlinks: "reject",
      assertBeforeMutation: () => {
        throw refusal;
      },
    });
    const claim = createClaim(stateRoot, stateDir, sourcePath);
    const snapshot = await claim.read();
    fs.linkSync(sourcePath, claim.claimPath);

    await expect(claim.recoverLinkedMove()).rejects.toBe(refusal);

    expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
    expect(fs.statSync(sourcePath).nlink).toBe(2);
    expect(fs.statSync(claim.claimPath).ino).toBe(snapshot.ino);
  });

  it("preserves both generations if the migration root is rebound before source removal", async () => {
    const { sourcePath, stateDir } = createSource();
    const moved = path.join(tempDirs.make("openclaw-moved-source-"), "original");
    const outside = tempDirs.make("openclaw-outside-source-");
    fs.writeFileSync(path.join(outside, "legacy.json"), "outside generation");
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    vi.spyOn(stateRoot, "move").mockRejectedValue(
      new FsSafeError("helper-unavailable", "unsupported rename", {
        cause: Object.assign(new Error("unsupported rename flags"), { code: "EINVAL" }),
      }),
    );
    const claim = createClaim(stateRoot, stateDir, sourcePath);
    const snapshot = await claim.read();
    let rebound = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: (operation) => {
        if (operation === "remove" && !rebound) {
          rebound = true;
          fs.renameSync(stateDir, moved);
          fs.symlinkSync(outside, stateDir, process.platform === "win32" ? "junction" : "dir");
        }
      },
    });

    await expect(claim.claim({ snapshot, mismatchMessage: "source changed" })).rejects.toThrow();

    expect(rebound).toBe(true);
    expect(fs.readFileSync(path.join(moved, "legacy.json"))).toEqual(snapshot.buffer);
    expect(fs.readFileSync(path.join(outside, "legacy.json"), "utf8")).toBe("outside generation");
  });

  it.each([false, true])(
    "recovers only the interrupted source/claim hardlink pair (extra alias=%s)",
    async (extraAlias) => {
      const { sourcePath, stateDir } = createSource();
      const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
      const claim = createClaim(stateRoot, stateDir, sourcePath);
      const snapshot = await claim.read();
      fs.linkSync(sourcePath, claim.claimPath);
      if (extraAlias) {
        fs.linkSync(sourcePath, path.join(stateDir, "unrelated-alias"));
        await expect(claim.recover("conflicting source")).rejects.toThrow();
        expect(fs.statSync(claim.claimPath).nlink).toBe(3);
      } else {
        await claim.recover("conflicting source");
        expect(fs.existsSync(claim.claimPath)).toBe(false);
        expect(fs.statSync(sourcePath).nlink).toBe(1);
      }
      expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
      expect(fs.statSync(sourcePath).ino).toBe(snapshot.ino);
    },
  );

  it("rejects an inode replacement with matching bytes and restores its source", async () => {
    const { sourcePath, stateDir } = createSource();
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    const claim = createClaim(stateRoot, stateDir, sourcePath);
    const snapshot = await claim.read();
    const replacementPath = path.join(stateDir, "replacement.json");
    fs.writeFileSync(replacementPath, snapshot.buffer);
    const replacementInode = fs.statSync(replacementPath).ino;

    await expect(
      claim.claim({
        snapshot,
        mismatchMessage: "source inode changed before claim",
        beforeClaim: () => fs.renameSync(replacementPath, sourcePath),
      }),
    ).rejects.toThrow("source inode changed before claim");
    expect(await claim.restore()).toBeNull();

    expect(fs.statSync(sourcePath).ino).toBe(replacementInode);
    expect(fs.statSync(sourcePath).ino).not.toBe(snapshot.ino);
    expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
    expect(fs.existsSync(claim.claimPath)).toBe(false);
  });

  it("restores every claimed source when a later multi-file claim changes", async () => {
    const { sourcePath, stateDir } = createSource();
    const secondPath = path.join(stateDir, "second.json");
    fs.writeFileSync(secondPath, '{"version":2}\n', "utf8");
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    const firstClaim = createClaim(stateRoot, stateDir, sourcePath);
    const secondClaim = createClaim(stateRoot, stateDir, secondPath);
    const firstSnapshot = await firstClaim.read();
    const secondSnapshot = await secondClaim.read();
    const replacementPath = path.join(stateDir, "replacement.json");
    fs.writeFileSync(replacementPath, secondSnapshot.buffer);

    await expect(
      claimLegacyMigrationSourceClaims(
        [
          { claim: firstClaim, snapshot: firstSnapshot },
          { claim: secondClaim, snapshot: secondSnapshot },
        ],
        {
          beforeClaim: () => fs.renameSync(replacementPath, secondPath),
          mismatchMessage: "batch source changed before claim",
        },
      ),
    ).rejects.toThrow("batch source changed before claim");

    expect(fs.readFileSync(sourcePath)).toEqual(firstSnapshot.buffer);
    expect(fs.readFileSync(secondPath)).toEqual(secondSnapshot.buffer);
    expect(fs.readdirSync(stateDir).toSorted()).toEqual(["legacy.json", "second.json"]);
  });
});
