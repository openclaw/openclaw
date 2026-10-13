// Covers git root and HEAD path discovery.
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  findGitRoot,
  readGitHead,
  readGitMetadataDirectories,
  readGitMetadataPrefix,
  readGitObjectStorageDependencies,
  readGitWorktreeAdministrations,
} from "./git-root.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.replace(/[\r\n]+$/u, "");
}

async function expectGitRootResolution(params: {
  label: string;
  setup: (
    temp: string,
  ) => Promise<{ startPath: string; expectedRoot: string | null; expectedHead: string | null }>;
}): Promise<void> {
  await withTestDir({ prefix: `openclaw-${params.label}-` }, async (temp) => {
    const { startPath, expectedRoot, expectedHead } = await params.setup(temp);
    if (expectedHead) {
      await fs.writeFile(expectedHead, `${"a".repeat(40)}\n`);
    }
    // Include the fixture root, but never inspect host-owned ancestors above it.
    const maxDepth = path.relative(temp, startPath).split(path.sep).filter(Boolean).length + 1;
    expect(findGitRoot(startPath, { maxDepth })).toBe(expectedRoot);
    expect(readGitHead(startPath, { maxDepth })?.headPath ?? null).toBe(expectedHead);
  });
}

describe("git-root", () => {
  it("keeps short-read retries within the bounded metadata window", async () => {
    await withTestDir({ prefix: "openclaw-git-bounded-ref-" }, async (root) => {
      const ref = path.join(root, "main");
      await fs.writeFile(ref, `${"x".repeat(256)}abcdef0123456789`);
      const realReadSync = fsSync.readSync.bind(fsSync);
      let totalBytesRead = 0;
      const read = vi.spyOn(fsSync, "readSync").mockImplementation(((
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        const bytesRead = realReadSync(fd, buffer, offset, Math.min(length, 4), position);
        totalBytesRead += bytesRead;
        return bytesRead;
      }) as typeof fsSync.readSync);
      try {
        expect(readGitMetadataPrefix(ref)).toBe("x".repeat(256));
        expect(totalBytesRead).toBe(256);
      } finally {
        read.mockRestore();
      }
    });
  });

  it.skipIf(process.platform === "win32").each(["HEAD", "refs/heads/main", "packed-refs"])(
    "refuses a FIFO %s instead of consuming ref bytes from a writer",
    async (name) => {
      await withTestDir({ prefix: "openclaw-git-fifo-" }, async (root) => {
        const directory = path.join(root, ".git");
        await fs.mkdir(path.join(directory, "refs", "heads"), { recursive: true });
        if (name !== "HEAD") {
          await fs.writeFile(path.join(directory, "HEAD"), "ref: refs/heads/main\n");
        }
        const fifo = path.join(directory, name);
        await execFileAsync("mkfifo", [fifo]);
        const contents = `${"a".repeat(40)}${name === "packed-refs" ? " refs/heads/main" : ""}\n`;
        // A writer lets the old blocking reader finish too, without a timer or a hung worker.
        const writer = execFileAsync(process.execPath, [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
          fifo,
          contents,
        ]);
        const settled = writer.catch(() => undefined);
        try {
          expect(() => readGitHead(root, { maxDepth: 1 })).toThrow("regular file");
        } finally {
          writer.child.kill();
          await settled;
        }
      });
    },
  );

  it.each([
    {
      name: ".git is a gitdir pointer file",
      label: "git-root-file",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const workspace = path.join(repoRoot, "nested", "workspace");
        const gitDir = path.join(repoRoot, ".actual-git");
        await fs.mkdir(workspace, { recursive: true });
        await fs.mkdir(gitDir, { recursive: true });
        await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: .actual-git\n", "utf-8");
        return {
          startPath: workspace,
          expectedRoot: repoRoot,
          expectedHead: path.join(gitDir, "HEAD"),
        };
      },
    },
    {
      name: "invalid gitdir content without a parent repo",
      label: "git-root-invalid-only",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const nested = path.join(repoRoot, "nested");
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(repoRoot, ".git"), "not-a-gitdir-pointer\n", "utf-8");
        return {
          startPath: nested,
          expectedRoot: repoRoot,
          expectedHead: null,
        };
      },
    },
  ])("resolves git roots when $name", async ({ label, setup }) => {
    await expectGitRootResolution({ label, setup });
  });

  it("matches native Git storage across normal, bare, and relocated linked layouts", async () => {
    await withTestDir({ prefix: "openclaw-git-storage-" }, async (root) => {
      const source = path.join(root, "source");
      const bare = path.join(
        root,
        process.platform === "win32" ? "common store" : " common store ",
      );
      const checkout = path.join(root, "checkout");
      await git(root, "init", "--template=", "-b", "main", source);
      await git(
        source,
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=openclaw-test@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--allow-empty",
        "-m",
        "source",
      );
      await git(root, "clone", "--bare", source, bare);
      await git(bare, "worktree", "add", "-b", "linked", checkout);
      const originalAdmin = await fs.realpath(
        await git(checkout, "rev-parse", "--absolute-git-dir"),
      );
      const admin = path.join(root, "storage", "private admin");
      const redirect = path.join(root, "redirect");
      const redirected = path.join(root, "storage", "nested");
      await fs.mkdir(redirected, { recursive: true });
      await fs.symlink(redirected, redirect, process.platform === "win32" ? "junction" : "dir");
      await fs.rename(originalAdmin, admin);
      await fs.symlink(admin, originalAdmin, process.platform === "win32" ? "junction" : "dir");
      // Long native pointers must be read completely, including meaningful trailing spaces.
      await fs.writeFile(
        path.join(checkout, ".git"),
        `gitdir: ../redirect/../${"./".repeat(140)}private admin\r\n`,
      );
      const commonAlias = path.join(
        root,
        process.platform === "win32" ? "common alias" : " common alias ",
      );
      const commonMiddle = path.join(root, "common-middle");
      await fs.symlink(bare, commonMiddle, "junction");
      await fs.symlink(commonMiddle, commonAlias, "junction");
      await fs.writeFile(
        path.join(admin, "commondir"),
        `../../${"./".repeat(140)}${path.basename(commonAlias)}\r\n`,
      );
      const controlPaths = [path.join(root, "checkout-pointer"), path.join(root, "common-pointer")];
      const controlAliases = [
        path.join(root, "checkout-control-alias"),
        path.join(root, "common-control-alias"),
      ];
      if (process.platform !== "win32") {
        for (const [index, marker] of [
          path.join(checkout, ".git"),
          path.join(admin, "commondir"),
        ].entries()) {
          await fs.rename(marker, controlPaths[index]!);
          await fs.symlink(controlPaths[index]!, controlAliases[index]!, "file");
          await fs.symlink(controlAliases[index]!, marker, "file");
        }
      }
      const alias = path.join(root, "source-alias");
      await fs.mkdir(alias);
      await fs.symlink(
        path.join(source, ".git"),
        path.join(alias, ".git"),
        process.platform === "win32" ? "junction" : "dir",
      );
      for (const repository of [source, bare, checkout, alias]) {
        const nativeGitDir = await fs.realpath(
          await git(repository, "rev-parse", "--absolute-git-dir"),
        );
        const commonPointer = await git(repository, "rev-parse", "--git-common-dir");
        const nativeCommonDir = await fs.realpath(
          path.isAbsolute(commonPointer)
            ? commonPointer
            : `${repository}${path.sep}${commonPointer}`,
        );
        expect(readGitMetadataDirectories(repository)).toMatchObject({
          gitDir: nativeGitDir,
          commonDir: nativeCommonDir,
        });
      }
      expect(readGitHead(checkout, { maxDepth: 1 })?.value).toBe(
        await git(checkout, "rev-parse", "HEAD"),
      );
      expect(readGitMetadataDirectories(checkout)?.paths).toEqual(
        expect.arrayContaining([redirect, commonAlias, commonMiddle]),
      );
      const budgetFailure = new Error("metadata lookup budget exhausted");
      expect(() =>
        readGitMetadataDirectories(checkout, () => {
          throw budgetFailure;
        }),
      ).toThrow(budgetFailure);
      if (process.platform !== "win32") {
        expect(readGitMetadataDirectories(checkout)?.paths).toEqual(
          expect.arrayContaining([...controlPaths, ...controlAliases]),
        );
      }
      const nested = path.join(checkout, "nested");
      await fs.mkdir(nested);
      expect(readGitMetadataDirectories(nested)).toBeUndefined();
    });
  });

  it.each([
    "malformed gitfile",
    "oversized gitfile",
    "empty commondir",
    "oversized commondir",
    "non-file commondir",
    "dangling commondir",
  ] as const)("keeps %s storage unresolved", async (kind) => {
    await withTestDir({ prefix: "openclaw-git-storage-invalid-" }, async (root) => {
      const checkout = path.join(root, "checkout");
      const admin = path.join(root, "admin");
      const common = path.join(root, "common");
      await fs.mkdir(checkout);
      await fs.mkdir(admin);
      await fs.mkdir(common);
      const marker = path.join(checkout, ".git");
      const commonMarker = path.join(admin, "commondir");
      await fs.writeFile(marker, "gitdir: ../admin\n");
      await fs.writeFile(commonMarker, "../common\n");
      if (kind === "malformed gitfile") {
        await fs.writeFile(marker, "not-a-gitfile\ngitdir: ../admin\n");
      } else if (kind === "oversized gitfile") {
        await fs.appendFile(marker, "\n".repeat(1024 * 1024));
      } else if (kind === "empty commondir") {
        await fs.writeFile(commonMarker, "");
      } else if (kind === "oversized commondir") {
        await fs.appendFile(commonMarker, "\n".repeat(1024 * 1024));
      } else {
        await fs.unlink(commonMarker);
        if (kind === "non-file commondir") {
          await fs.mkdir(commonMarker);
        } else {
          await fs.symlink(path.join(root, "missing"), commonMarker);
        }
      }
      expect(readGitMetadataDirectories(checkout)).toBeUndefined();
    });
  });
});

describe("Git worktree administration", () => {
  it.for(["absolute", "relative"] as const)(
    "retains native %s registration and symlink deletion roots independently of checkout markers",
    async (layout, context) => {
      await withTestDir({ prefix: "openclaw-git-admin-" }, async (root) => {
        const repo = path.join(root, "repo");
        const checkout = path.join(root, "checkout");
        await git(root, "init", "--template=", "-b", "main", repo);
        await git(
          repo,
          "-c",
          "user.name=OpenClaw Test",
          "-c",
          "user.email=git@example.invalid",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "--allow-empty",
          "-m",
          "source",
        );
        await git(
          repo,
          "-c",
          "worktree.useRelativePaths=false",
          "worktree",
          "add",
          "--detach",
          checkout,
          "HEAD",
        );
        const common = path.join(repo, ".git");
        const admin = await fs.realpath(await git(checkout, "rev-parse", "--absolute-git-dir"));
        const readAdministrations = () => {
          const inventory = readGitWorktreeAdministrations(common, () => {});
          for (const entry of inventory.entries) {
            entry.checkoutPath = path.resolve(entry.checkoutPath);
          }
          return inventory;
        };
        if (layout === "relative") {
          try {
            await git(repo, "worktree", "repair", "--relative-paths", checkout);
          } catch (error) {
            if (error instanceof Error && /unknown option.*relative-paths/u.test(error.message)) {
              context.skip("Installed Git does not support relative worktree registrations");
            }
            throw error;
          }
          expect(
            path.isAbsolute((await fs.readFile(path.join(admin, "gitdir"), "utf8")).trim()),
          ).toBe(false);
        }
        const expected = {
          entries: [{ checkoutPath: checkout, adminPath: admin, physicalAdminPath: admin }],
          complete: true,
        };
        expect(await git(repo, "worktree", "list", "--porcelain", "-z")).toContain(
          `worktree ${checkout}\0`,
        );
        expect(readAdministrations()).toEqual(expected);
        const marker = path.join(checkout, ".git");
        const pointer = await fs.readFile(marker);
        await fs.unlink(marker);
        expect(readAdministrations()).toEqual(expected);
        await fs.writeFile(marker, "unrelated replacement metadata\n");
        expect(readAdministrations()).toEqual(expected);
        await fs.writeFile(marker, pointer);

        const relocated = path.join(root, "relocated-admin");
        await fs.rename(admin, relocated);
        await fs.symlink(relocated, admin, "junction");
        await fs.writeFile(path.join(relocated, "commondir"), `${common}\n`);
        await fs.writeFile(path.join(relocated, "gitdir"), `${checkout}/.git\n`);
        await fs.writeFile(marker, `gitdir: ${relocated}\n`);
        const collateral = path.join(relocated, "collateral.txt");
        await fs.writeFile(collateral, "native administrative deletion reaches these bytes\n");
        expect(readAdministrations()).toEqual({
          entries: [{ checkoutPath: checkout, adminPath: admin, physicalAdminPath: relocated }],
          complete: true,
        });
        await git(repo, "worktree", "remove", "--force", "--force", checkout);
        await expect(fs.stat(collateral)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.lstat(admin)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("retains known registrations on bounded metadata failures and propagates the budget", async () => {
    await withTestDir({ prefix: "openclaw-git-admin-partial-" }, async (common) => {
      const admin = path.join(common, "worktrees", "known");
      const oversized = path.join(common, "worktrees", "oversized");
      const checkout = path.join(common, "missing-checkout");
      await fs.mkdir(admin, { recursive: true });
      await fs.mkdir(oversized);
      await fs.writeFile(path.join(admin, "gitdir"), `${checkout}/.git\n`);
      await fs.writeFile(path.join(oversized, "gitdir"), Buffer.alloc(1024 * 1024 + 1, 10));
      expect(readGitWorktreeAdministrations(common, () => {})).toEqual({
        entries: [{ checkoutPath: checkout, adminPath: admin, physicalAdminPath: admin }],
        complete: false,
      });
      const stopped = new Error("administrative census exhausted");
      expect(() =>
        readGitWorktreeAdministrations(common, () => {
          throw stopped;
        }),
      ).toThrow(stopped);
    });
  });
});

describe("Git object storage dependencies", () => {
  it("follows native recursive alternates and physical control files without retaining old paths", async () => {
    await withTestDir({ prefix: "openclaw-git-object-storage-" }, async (root) => {
      const primary = path.join(root, "primary");
      const donor = path.join(root, "donor");
      await git(root, "init", "--bare", "--template=", primary);
      await git(root, "init", "--bare", "--template=", donor);
      const blobFile = path.join(root, "borrowed.txt");
      await fs.writeFile(blobFile, "borrowed object\n");
      const blob = await git(donor, "hash-object", "-w", blobFile);
      const objects = path.join(root, "primary-objects");
      await fs.rename(path.join(primary, "objects"), objects);
      await fs.symlink(objects, path.join(primary, "objects"), "junction");
      const control = path.join(root, "control-info");
      await fs.rename(path.join(objects, "info"), control);
      await fs.symlink(control, path.join(objects, "info"), "junction");
      const relay = path.join(root, "relay-objects");
      await fs.mkdir(path.join(relay, "info"), { recursive: true });
      const marker = path.join(control, "alternates");
      const relayMarker = path.join(relay, "info", "alternates");
      await fs.writeFile(marker, '# ignored\n"../relay-objects"\n../donor/objects\n');
      await fs.writeFile(relayMarker, "../donor/objects\n../primary-objects\n");

      expect(await git(primary, "cat-file", "-p", blob)).toBe("borrowed object");
      const dependencies = readGitObjectStorageDependencies(primary, () => {});
      expect(dependencies.complete).toBe(true);
      expect(dependencies.paths).toEqual(
        expect.arrayContaining([
          objects,
          marker,
          relay,
          relayMarker,
          path.join(donor, "objects"),
          path.join(primary, "objects"),
          path.join(objects, "info"),
        ]),
      );
      const stopped = new Error("census budget exhausted");
      let checkpoints = 0;
      expect(() =>
        readGitObjectStorageDependencies(primary, () => {
          if (++checkpoints === 3) {
            throw stopped;
          }
        }),
      ).toThrow(stopped);

      await fs.writeFile(marker, "");
      const refreshed = readGitObjectStorageDependencies(primary, () => {});
      expect(refreshed.complete).toBe(true);
      expect(refreshed.paths).toEqual(expect.arrayContaining([objects, marker]));
      expect(refreshed.paths).not.toContain(relay);
      expect(refreshed.paths).not.toContain(path.join(donor, "objects"));
      await expect(git(primary, "cat-file", "-p", blob)).rejects.toThrow();
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves native C quoting, literal fallback, and whitespace in alternate paths",
    async () => {
      await withTestDir({ prefix: "openclaw-git-object-quotes-" }, async (root) => {
        const primary = path.join(root, "primary");
        const donor = path.join(root, "donor");
        await git(root, "init", "--bare", "--template=", primary);
        await git(root, "init", "--bare", "--template=", donor);
        const blobFile = path.join(root, "object.txt");
        await fs.writeFile(blobFile, "quoted object\n");
        const blob = await git(donor, "hash-object", "-w", blobFile);
        const objects = path.join(primary, "objects");
        const donorObjects = path.join(donor, "objects");
        const marker = path.join(objects, "info", "alternates");
        const cases = [
          {
            name: 'escaped"\\\u0007\b\f\n\r\t\v-é',
            pointer: '"escaped\\\"\\\\\\a\\b\\f\\n\\r\\t\\v-\\303\\251"',
          },
          { name: "line\nbreak", pointer: '"line\nbreak"' },
          { name: " spaced\r", pointer: " spaced\r" },
          { name: " # literal", pointer: " # literal" },
          { name: '"literal\\q', pointer: '"literal\\q' },
        ];
        for (const { name, pointer } of cases) {
          await fs.symlink(donorObjects, path.join(objects, name), "dir");
          await fs.writeFile(marker, `${pointer}\n`);
          expect(await git(primary, "cat-file", "-p", blob)).toBe("quoted object");
          expect(readGitObjectStorageDependencies(primary, () => {})).toEqual({
            paths: expect.arrayContaining([
              objects,
              marker,
              donorObjects,
              path.join(objects, name),
            ]),
            complete: true,
          });
        }
      });
    },
  );

  it("matches Git's six-store alternate depth limit", async () => {
    await withTestDir({ prefix: "openclaw-git-object-depth-" }, async (root) => {
      const primary = path.join(root, "primary");
      await git(root, "init", "--bare", "--template=", primary);
      const stores = [
        path.join(primary, "objects"),
        ...Array.from({ length: 7 }, (_, i) => path.join(root, `objects-${i}`)),
      ];
      for (const [index, store] of stores.entries()) {
        await fs.mkdir(path.join(store, "info"), { recursive: true });
        const next = stores[index + 1];
        if (next) {
          await fs.writeFile(path.join(store, "info", "alternates"), `${next}\n`);
        }
      }
      expect(
        (await git(primary, "count-objects", "-v"))
          .split("\n")
          .filter((line) => line.startsWith("alternate: ")),
      ).toHaveLength(6);
      const dependencies = readGitObjectStorageDependencies(primary, () => {});
      expect(dependencies.complete).toBe(true);
      expect(dependencies.paths).toEqual(
        stores.slice(0, 7).flatMap((store) => [store, path.join(store, "info", "alternates")]),
      );
    });
  });

  it.each([
    "missing target",
    "invalid UTF-8",
    "NUL",
    "oversized file",
    "non-file",
    "dangling control",
    "dangling alias",
    "cyclic alias",
  ] as const)("retains partial object dependencies when an alternate has %s", async (kind) => {
    await withTestDir({ prefix: "openclaw-git-object-partial-" }, async (root) => {
      const primary = path.join(root, "primary");
      const objects = path.join(primary, "objects");
      const known = path.join(root, "known");
      const marker = path.join(objects, "info", "alternates");
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.mkdir(known);
      const valid = Buffer.from("../../known\n");
      if (kind === "missing target") {
        await fs.writeFile(marker, Buffer.concat([valid, Buffer.from("../../missing\n")]));
      } else if (kind === "invalid UTF-8") {
        await fs.writeFile(marker, Buffer.concat([valid, Buffer.from([0xff, 10])]));
      } else if (kind === "NUL") {
        await fs.writeFile(marker, Buffer.concat([valid, Buffer.from([0, 10])]));
      } else if (kind === "oversized file") {
        await fs.writeFile(marker, Buffer.alloc(1024 * 1024 + 1, 10));
      } else if (kind === "non-file") {
        await fs.mkdir(marker);
      } else if (kind === "dangling alias" || kind === "cyclic alias") {
        const first = path.join(root, "first-link");
        const second = path.join(root, "second-link");
        await fs.symlink(second, first, "junction");
        await fs.symlink(
          kind === "cyclic alias" ? first : path.join(root, "missing"),
          second,
          "junction",
        );
        await fs.writeFile(marker, Buffer.concat([valid, Buffer.from("../../first-link\n")]));
      } else {
        await fs.symlink(path.join(root, "missing"), marker);
      }
      const dependencies = readGitObjectStorageDependencies(primary, () => {});
      expect(dependencies.complete).toBe(false);
      expect(dependencies.paths).toContain(objects);
      if (kind === "missing target" || kind === "invalid UTF-8" || kind === "NUL") {
        expect(dependencies.paths).toContain(known);
      }
      if (kind === "dangling alias" || kind === "cyclic alias") {
        expect(dependencies.paths).toEqual(
          expect.arrayContaining([
            known,
            path.join(root, "first-link"),
            path.join(root, "second-link"),
          ]),
        );
      }
    });
  });
});
