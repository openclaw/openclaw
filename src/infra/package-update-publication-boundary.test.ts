import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as nodeSqlite from "./node-sqlite.js";
import {
  openPackageActivationJournal,
  packageActivationIdentity,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import {
  readPackageReverseSymlink,
  renamePackageReverseResource,
} from "./package-update-activation-symlink.js";
import * as packageFilesystem from "./package-update-filesystem.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as snapshot from "./sqlite-snapshot.js";

const fixtures = createPackageActivationLifetimeFixture();
let root: string;
beforeEach(() => {
  ({ root } = fixtures.setup());
  const state = path.join(root, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(state, "openclaw.json"));
});
afterEach(async () => {
  try {
    await fixtures.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it.skipIf(process.platform === "win32").each(["owned", "replacement"] as const)(
  "completes real launcher publication and binds retirement to its %s directory",
  (retirement) =>
    fixtures.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        let transaction: PackageUpdateTransaction | undefined;
        const result = await swapStagedPackageInstall({
          ...f.params,
          activation: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
          onTransaction: (issued) => {
            transaction = issued;
          },
        });
        expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
        expect(
          JSON.parse(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).version,
        ).toBe("2.0.0");
        const anchor = resolvePackageActivationAnchor(f.packageRoot);
        const record = openPackageActivationJournal(anchor).read();
        expect(record.phase).toBe("publication-complete");
        expect(record.publications).toEqual([
          { name: "openclaw", identity: packageActivationIdentity(f.launcher, "launcher") },
        ]);
        expect(transaction).toBeDefined();
        if (retirement === "replacement") {
          const obsolete = path.join(anchor, "previous");
          const retained = path.join(root, "retained-previous");
          const remove = packageFilesystem.removePackagePath;
          vi.spyOn(packageFilesystem, "removePackagePath").mockImplementation(
            async (target, assertion) => {
              if (target === obsolete) {
                fs.renameSync(target, retained);
                fs.mkdirSync(target);
                fs.writeFileSync(path.join(target, "successor.txt"), "foreign retirement owner");
              }
              return remove(target, assertion);
            },
          );
          await expect(
            transaction!.complete({ activationVerified: true }, fence.assertCurrent),
          ).rejects.toThrow("Retirement target changed");
          expect(fs.readFileSync(path.join(obsolete, "successor.txt"), "utf8")).toBe(
            "foreign retirement owner",
          );
          expect(
            JSON.parse(fs.readFileSync(path.join(retained, "package.json"), "utf8")).version,
          ).toBe("1.0.0");
          expect(openPackageActivationJournal(anchor).read().intent).toMatchObject({
            kind: "remove",
            name: "previous",
          });
        } else {
          await transaction!.complete({ activationVerified: true }, fence.assertCurrent);
          expect(fs.existsSync(anchor)).toBe(false);
        }
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
      });
    }),
);

it.skipIf(process.platform === "win32")(
  "retires an untouched publication after its first package rename is refused",
  () =>
    fixtures.lifetime.run(async () => {
      const f = await createPackageSwapFixture(root);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        const anchor = resolvePackageActivationAnchor(f.packageRoot);
        const rename = fsp.rename.bind(fsp);
        let refused = false;
        vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
          if (!refused && from === f.packageRoot && to === path.join(anchor, "previous")) {
            refused = true;
            throw new Error("package displacement refused");
          }
          return rename(from, to);
        });
        let transaction: PackageUpdateTransaction | undefined;
        const result = await swapStagedPackageInstall({
          ...f.params,
          activation: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
          onTransaction: (issued) => {
            transaction = issued;
          },
        });
        expect(result.status).toBe("failed");
        expect(refused).toBe(true);
        expect(openPackageActivationJournal(anchor).read().phase).toBe("publishing");
        if (!transaction) {
          throw new Error("Failed publication did not retain its package transaction.");
        }
        await expect(transaction.rollback(fence.assertCurrent)).resolves.toMatchObject({
          exitCode: 0,
        });
        expect(openPackageActivationJournal(anchor).read().phase).toBe("aborted");
        await transaction.complete({ activationVerified: true }, fence.assertCurrent);
        expect(fs.existsSync(anchor)).toBe(false);
        expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
          '"version":"1.0.0"',
        );
      });
    }),
);

it("reads and revalidates a normal Linux npm symlink launcher", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const link = path.join(root, "openclaw");
  fs.symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", link);
  const captured = fs.lstatSync(link, { bigint: true });
  expect(readPackageReverseSymlink(link, captured)).toBe(
    "../lib/node_modules/openclaw/openclaw.mjs",
  );
  fs.unlinkSync(link);
  fs.symlinkSync("../lib/node_modules/other/openclaw.mjs", link);
  expect(() => readPackageReverseSymlink(link, captured)).toThrow("captured inode");
});

it.skipIf(process.platform === "win32").each(["directory", "parent"] as const)(
  "preserves replacement %s contents when recovery snapshot transport fails",
  (replacement) =>
    fixtures.lifetime.run(async () => {
      const f = await fixtures.prepare();
      const journalPath = resolvePackageActivationJournalPath(f.anchor);
      const before = fs.readFileSync(journalPath);
      const open = nodeSqlite.openNodeSqliteDatabase;
      let hot = false;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((file, ...args) => {
        if (!hot && file.includes("operation.sqlite")) {
          hot = true;
          throw Object.assign(new Error("read-only hot journal"), { errcode: 776 });
        }
        return open(file, ...args);
      });
      let successor = "";
      const retained = path.join(root, "retained-snapshot-owner");
      const interrupted = new Error("snapshot transport interrupted");
      const copy = vi
        .spyOn(snapshot, "createVerifiedSqliteSnapshot")
        .mockImplementation(async ({ targetPath }) => {
          const directory = path.dirname(targetPath);
          await Promise.resolve();
          const replaced =
            replacement === "directory" ? directory : resolvePackageActivationControl(f.anchor);
          fs.renameSync(replaced, retained);
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          successor = path.join(directory, "successor.txt");
          fs.writeFileSync(successor, "foreign snapshot owner");
          throw interrupted;
        });
      await expect(openPackageActivationJournal(f.anchor).readForRecovery()).rejects.toMatchObject({
        cause: interrupted,
      });
      expect(hot).toBe(true);
      expect(copy).toHaveBeenCalledOnce();
      expect(fs.readFileSync(successor, "utf8")).toBe("foreign snapshot owner");
      expect(
        fs.readFileSync(
          replacement === "parent" ? path.join(retained, "operation.sqlite") : journalPath,
        ),
      ).toEqual(before);
      expect(fs.existsSync(retained)).toBe(true);
    }),
);

it.each(["publish", "destination", "source", "parent", "revoked"] as const)(
  "binds a reverse rename to its original slots and authority: %s",
  (change) =>
    fixtures.lifetime.run(async () => {
      const directory = path.join(root, "reverse-slots");
      fs.mkdirSync(directory, { mode: 0o700 });
      const from = path.join(directory, "staged");
      const to = path.join(directory, "live");
      const retained = path.join(root, "retained");
      fs.writeFileSync(from, "prepared original");
      const sourceIdentity = packageActivationIdentity(from, false);
      const parentIdentity = packageActivationIdentity(directory, true);
      // A caller has completed an awaited inspection. Replace a recorded slot
      // before the effect; only the original identities may authorize the rename.
      await Promise.resolve();
      if (change === "destination") {
        fs.writeFileSync(to, "newer destination");
      }
      if (change === "source") {
        fs.renameSync(from, retained);
        fs.writeFileSync(from, "foreign staged source");
      }
      if (change === "parent") {
        fs.renameSync(directory, retained);
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.renameSync(path.join(retained, "staged"), from);
      }
      const assertBeforeRename = vi.fn(() => {
        if (change === "revoked") {
          throw new Error("original scope closed");
        }
        if (packageActivationIdentity(directory, true) !== parentIdentity) {
          throw new Error("original parent replaced");
        }
      });
      const result = renamePackageReverseResource(from, to, { sourceIdentity, assertBeforeRename });
      if (change === "publish") {
        await expect(result).resolves.toBeUndefined();
        expect(fs.readFileSync(to, "utf8")).toBe("prepared original");
        expect(fs.existsSync(from)).toBe(false);
      } else {
        await expect(result).rejects.toThrow();
        expect(fs.readFileSync(from, "utf8")).toBe(
          change === "source" ? "foreign staged source" : "prepared original",
        );
        if (change === "destination") {
          expect(fs.readFileSync(to, "utf8")).toBe("newer destination");
        } else {
          expect(fs.existsSync(to)).toBe(false);
        }
      }
      if (change === "source") {
        expect(fs.readFileSync(retained, "utf8")).toBe("prepared original");
      }
    }),
);
