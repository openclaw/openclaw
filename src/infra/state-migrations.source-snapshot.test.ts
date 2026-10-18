import fs from "node:fs";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as durability from "./directory-durability.js";
import { LegacyMigrationMoveUnavailableError } from "./state-migrations.no-replace-move.js";
import {
  assertLegacyMigrationSourceUnchanged as assertUnchanged,
  claimAndRemoveLegacyMigrationSource as claimAndRemove,
  claimLegacyMigrationSourceClaims as claimBatch,
  LegacyMigrationSourceClaim as SourceClaim,
  legacyMigrationSourceOrClaimMayExist as sourceOrClaimExists,
  legacyMigrationSourceSnapshotsMatch as snapshotsMatch,
  type LegacyMigrationSourceSnapshot as SourceSnapshot,
  readLegacyMigrationSourceSnapshot as readSnapshot,
  readLegacyMigrationSourceSnapshotSync as readSnapshotSync,
  resolveLegacyMigrationRelativePath as relativePath,
} from "./state-migrations.source-snapshot.js";

const sourceIdentityFixture = vi.hoisted(() => ({
  filePath: undefined as string | undefined,
  ino: 0n,
}));

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/advanced")>();
  return {
    ...actual,
    readRegularFileSync: (params: Parameters<typeof actual.readRegularFileSync>[0]) => {
      const result = actual.readRegularFileSync(params);
      if (params.filePath !== sourceIdentityFixture.filePath) {
        return result;
      }
      return {
        ...result,
        exactIdentity: { ...result.exactIdentity, ino: sourceIdentityFixture.ino },
      };
    },
  };
});

describe("doctor legacy migration source contract", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      configureFsSafeNative({ mode: "auto" });
      __setFsSafeTestHooksForTest(undefined);
      sourceIdentityFixture.filePath = undefined;
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
    const params = { stateRoot, stateDir, sourcePath, label: "test" };
    return new SourceClaim({
      ...params,
      readSnapshot: (candidatePath) =>
        readSnapshot({ ...params, sourcePath: candidatePath, maxBytes: 1024 }),
    });
  }

  async function createRootSource(options: Parameters<typeof root>[1] = {}) {
    const source = createSource();
    const stateRoot = await root(source.stateDir, {
      hardlinks: "reject",
      symlinks: "reject",
      ...options,
    });
    const claim = createClaim(stateRoot, source.stateDir, source.sourcePath);
    return { ...source, stateRoot, claim, snapshot: await claim.read() };
  }

  const stat = (filePath: string) => fs.statSync(filePath, { bigint: true });
  const claimOptions = (snapshot: SourceSnapshot) => ({
    snapshot,
    mismatchMessage: "source changed",
  });

  function expectSource(sourcePath: string, snapshot: SourceSnapshot) {
    expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
    expect(stat(sourcePath).ino).toBe(snapshot.ino);
  }

  function expectUnclaimed(claim: SourceClaim, snapshot: SourceSnapshot) {
    expectSource(claim.sourcePath, snapshot);
    expect(fs.existsSync(claim.claimPath)).toBe(false);
  }

  it("detects an interrupted claim without accepting absent source state", () => {
    const { sourcePath } = createSource();
    fs.renameSync(sourcePath, `${sourcePath}.doctor-importing`);
    expect(sourceOrClaimExists(sourcePath)).toBe(true);
    fs.unlinkSync(`${sourcePath}.doctor-importing`);
    expect(sourceOrClaimExists(sourcePath)).toBe(false);
  });

  it("rejects source paths outside the trusted migration root without exposing redacted paths", async () => {
    const { stateDir } = createSource();
    const outsidePath = path.join(stateDir, "..", "private-marker");
    expect(() => relativePath(stateDir, outsidePath, "test")).toThrow(
      "outside the state directory",
    );
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    expect(
      () =>
        new SourceClaim({
          stateRoot,
          stateDir,
          sourcePath: outsidePath,
          label: "test",
          includeFilePath: false,
          readSnapshot: () => Promise.reject(new Error("unreachable")),
        }),
    ).toThrowError(/^legacy test path is outside the state directory$/u);
  });

  it("accepts an unchanged large file identity and rejects a rounded-number collision", () => {
    const { sourcePath } = createSource();
    sourceIdentityFixture.filePath = sourcePath;
    sourceIdentityFixture.ino = 9_007_199_254_740_992n;
    const snapshot = readSnapshotSync({ sourcePath, label: "test" });
    expect(() => assertUnchanged({ sourcePath, snapshot, label: "test" })).not.toThrow();
    sourceIdentityFixture.ino += 1n;
    expect(() => assertUnchanged({ sourcePath, snapshot, label: "test" })).toThrow(
      "changed after doctor loaded it",
    );
  });

  it("restores the original source when verified claim cleanup fails", () => {
    const { sourcePath } = createSource();
    const snapshot = readSnapshotSync({ sourcePath, label: "test" });
    expect(() =>
      claimAndRemove({
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
    const { sourcePath, claim } = await createRootSource();
    fs.copyFileSync(sourcePath, claim.claimPath);

    await claim.recover("interrupted source conflicts with its replacement");

    expect(fs.readFileSync(sourcePath, "utf8")).toBe('{"version":1}\n');
    expect(fs.existsSync(claim.claimPath)).toBe(false);

    fs.renameSync(sourcePath, claim.claimPath);
    await claim.recover("interrupted source conflicts with its replacement");

    expect(fs.readFileSync(sourcePath, "utf8")).toBe('{"version":1}\n');
    expect(fs.existsSync(claim.claimPath)).toBe(false);
  });

  it("claims and restores the same inode with native off", async () => {
    const { sourcePath, claim } = await createRootSource();
    configureFsSafeNative({ mode: "off" });
    const snapshot = await claim.read();
    const claimed = await claim.claim(claimOptions(snapshot));
    expect(snapshotsMatch(claimed, snapshot)).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(stat(claim.claimPath).nlink).toBe(1n);
    expect(await claim.restore()).toBeNull();
    expectUnclaimed(claim, snapshot);
  });

  it.each(["required", "guarded", "unrelated-helper", "no-replace", "competing", "directory-sync"])(
    "preserves source on refused claim publication: %s",
    async (scenario) => {
      if (scenario === "directory-sync") {
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      }
      const { sourcePath, stateRoot, claim } = await createRootSource(
        scenario === "guarded" ? { assertBeforeMutation: () => {} } : {},
      );
      const refusal =
        scenario === "no-replace"
          ? new FsSafeError("helper-unavailable", "move capability unavailable", {
              cause: new Error("native move rejected"),
              details: {
                capability: "rename-noreplace",
                fallback: "link-unlink",
                fallbackCapability: "linkat",
              },
            })
          : new FsSafeError(
              "helper-unavailable",
              scenario === "unrelated-helper"
                ? "unrelated native operation failed"
                : "native fs-safe helper is unavailable",
            );
      const move = vi.spyOn(stateRoot, "move");
      if (scenario === "competing") {
        move.mockImplementationOnce(async () => {
          fs.writeFileSync(claim.claimPath, "another generation");
          throw refusal;
        });
      } else {
        move.mockRejectedValue(refusal);
      }
      const publish =
        scenario === "no-replace" ? vi.spyOn(durability, "publishFileExclusive") : undefined;
      if (scenario === "directory-sync") {
        const publishFile = durability.publishFileExclusive;
        vi.spyOn(durability, "publishFileExclusive").mockImplementation(async (params) => ({
          ...(await publishFile(params)),
          directorySync: { status: "unsupported", code: "ENOTSUP" },
        }));
      }
      if (scenario === "required") {
        configureFsSafeNative({ mode: "require" });
      }
      const snapshot = await claim.read();
      const attempt = expect(claim.claim(claimOptions(snapshot))).rejects;
      if (scenario === "no-replace") {
        await attempt.toBeInstanceOf(LegacyMigrationMoveUnavailableError);
        expect(publish).not.toHaveBeenCalled();
      } else if (scenario === "directory-sync") {
        await attempt.toThrow("crash-durable directory synchronization");
      } else if (scenario === "competing") {
        await attempt.toThrow();
      } else {
        await attempt.toBe(refusal);
      }
      if (scenario === "competing" || scenario === "directory-sync") {
        expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
        if (scenario === "competing") {
          expect(fs.readFileSync(claim.claimPath, "utf8")).toBe("another generation");
        } else {
          expect(stat(claim.claimPath).ino).toBe(snapshot.ino);
        }
      } else {
        expectUnclaimed(claim, snapshot);
      }
    },
  );

  it("preserves a partially published move for exact-pair recovery without retrying", async () => {
    const { sourcePath, stateRoot, claim, snapshot } = await createRootSource();
    const refusal = new FsSafeError("helper-failed", "source remains linked", {
      details: {
        operation: "move",
        fallback: "link-unlink",
        publication: "published",
        sourceRemoval: "still-linked",
      },
    });
    vi.spyOn(stateRoot, "move").mockImplementationOnce(async () => {
      fs.linkSync(sourcePath, claim.claimPath);
      throw refusal;
    });
    const publish = vi.spyOn(durability, "publishFileExclusive");
    await expect(claim.claim(claimOptions(snapshot))).rejects.toBe(refusal);
    expect(publish).not.toHaveBeenCalled();
    expect(stat(sourcePath)).toMatchObject({
      ino: snapshot.ino,
      nlink: 2n,
    });
    expect(stat(claim.claimPath).ino).toBe(snapshot.ino);
    await claim.recoverLinkedMove();
    expect(stat(sourcePath)).toMatchObject({
      ino: snapshot.ino,
      nlink: 1n,
    });
    expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
    expect(fs.existsSync(claim.claimPath)).toBe(false);
  });

  it.each(["claim", "recovery"] as const)(
    "preserves source state when the Root revokes %s authority",
    async (operation) => {
      const refusal = new Error("Migration authority was revoked.");
      const assertAuthority = vi.fn(() => {
        throw refusal;
      });
      const { sourcePath, claim, snapshot } = await createRootSource({
        assertBeforeMutation: assertAuthority,
      });
      if (operation === "recovery") {
        fs.linkSync(sourcePath, claim.claimPath);
      }

      await expect(
        operation === "claim" ? claim.claim(claimOptions(snapshot)) : claim.recoverLinkedMove(),
      ).rejects.toBe(refusal);

      expect(assertAuthority).toHaveBeenCalledOnce();
      expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
      expect(stat(sourcePath).nlink).toBe(operation === "recovery" ? 2n : 1n);
      if (operation === "recovery") {
        expect(stat(claim.claimPath).ino).toBe(snapshot.ino);
      } else {
        expect(fs.existsSync(claim.claimPath)).toBe(false);
      }
    },
  );

  it("preserves both generations if the migration root is rebound before source removal", async () => {
    const { stateDir, stateRoot, claim, snapshot } = await createRootSource();
    const moved = path.join(tempDirs.make("openclaw-moved-source-"), "original");
    const outside = tempDirs.make("openclaw-outside-source-");
    fs.writeFileSync(path.join(outside, "legacy.json"), "outside generation");
    vi.spyOn(stateRoot, "move").mockRejectedValue(
      new FsSafeError("helper-unavailable", "native fs-safe helper is unavailable"),
    );
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

    await expect(claim.claim(claimOptions(snapshot))).rejects.toThrow();

    expect(rebound).toBe(true);
    expect(fs.readFileSync(path.join(moved, "legacy.json"))).toEqual(snapshot.buffer);
    expect(fs.readFileSync(path.join(outside, "legacy.json"), "utf8")).toBe("outside generation");
  });

  it.each([false, true])(
    "recovers only the interrupted source/claim hardlink pair (extra alias=%s)",
    async (extraAlias) => {
      const { sourcePath, stateDir, claim, snapshot } = await createRootSource();
      fs.linkSync(sourcePath, claim.claimPath);
      if (extraAlias) {
        fs.linkSync(sourcePath, path.join(stateDir, "unrelated-alias"));
        await expect(claim.recover("conflicting source")).rejects.toThrow();
        expect(stat(claim.claimPath).nlink).toBe(3n);
      } else {
        await claim.recover("conflicting source");
        expect(fs.existsSync(claim.claimPath)).toBe(false);
        expect(stat(sourcePath).nlink).toBe(1n);
      }
      expectSource(sourcePath, snapshot);
    },
  );

  it.each(["claim", "batch"] as const)(
    "does not move a directory substituted at the %s mutation boundary",
    async (operation) => {
      const assertAuthority = vi.fn(() => {});
      const { sourcePath, claim, snapshot } = await createRootSource({
        assertBeforeMutation: assertAuthority,
      });
      const retainedPath = `${sourcePath}.retained`;
      let swapped = false;
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation: (kind) => {
          if (kind !== "move" || swapped) {
            return;
          }
          swapped = true;
          fs.renameSync(sourcePath, retainedPath);
          fs.mkdirSync(sourcePath);
          fs.writeFileSync(path.join(sourcePath, "nested.txt"), "operator directory contents");
        },
      });
      const attempt =
        operation === "claim"
          ? claim.claim(claimOptions(snapshot))
          : claimBatch([{ claim, snapshot }], {
              mismatchMessage: "source changed",
            });

      await expect(attempt).rejects.toMatchObject(
        operation === "claim" ? { code: "invalid-path" } : { cause: { code: "invalid-path" } },
      );
      expect(swapped).toBe(true);
      expect(assertAuthority).toHaveBeenCalledOnce();
      expect(fs.readFileSync(retainedPath)).toEqual(snapshot.buffer);
      expect(fs.readFileSync(path.join(sourcePath, "nested.txt"), "utf8")).toBe(
        "operator directory contents",
      );
      expect(fs.existsSync(claim.claimPath)).toBe(false);
      expect(await claim.restore()).toBeNull();
      expect(fs.existsSync(claim.claimPath)).toBe(false);
    },
  );

  it("rejects an inode replacement with matching bytes and restores its source", async () => {
    const { sourcePath, stateDir, claim, snapshot } = await createRootSource();
    const replacementPath = path.join(stateDir, "replacement.json");
    fs.writeFileSync(replacementPath, snapshot.buffer);
    const replacementInode = stat(replacementPath).ino;

    await expect(
      claim.claim({
        snapshot,
        mismatchMessage: "source inode changed before claim",
        beforeClaim: () => fs.renameSync(replacementPath, sourcePath),
      }),
    ).rejects.toThrow("source inode changed before claim");
    expect(await claim.restore()).toBeNull();

    expect(stat(sourcePath).ino).toBe(replacementInode);
    expect(stat(sourcePath).ino).not.toBe(snapshot.ino);
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
      claimBatch(
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
