import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  findGitRoot,
  readGitBranchTrackingRemotes,
  readGitHead,
  readGitMetadataDirectories,
  readGitMetadataPrefix,
  readGitObjectStorageDependencies,
  readGitRefs,
  readGitWorktreeAdministrations,
} from "./git-root.js";

const execFileAsync = promisify(execFile);
const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-git-root-" });
let root = "";
const at = (...parts: string[]) => path.join(root, ...parts);
const directoryLink = process.platform === "win32" ? "junction" : "dir";

async function write(file: string, contents: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return file;
}

async function relocate(directory: string, destination: string) {
  await fs.rename(directory, destination);
  await fs.symlink(destination, directory, directoryLink);
}

function expectDependencies(primary: string, paths: string[], complete = true) {
  expect(readGitObjectStorageDependencies(primary, () => {})).toEqual({
    paths: expect.arrayContaining(paths),
    complete,
  });
}

function expectBudget(read: (check: () => void) => unknown, checkpoint = 1) {
  const stopped = new Error("metadata budget exhausted");
  let checks = 0;
  const check = () => {
    if (++checks === checkpoint) {
      throw stopped;
    }
  };
  expect(() => read(check)).toThrow(stopped);
}

beforeEach(async () => {
  await tempDirs.setup();
  root = await tempDirs.make();
});
afterEach(() => tempDirs.cleanup());

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.replace(/[\r\n]+$/u, "");
}

async function initialCommit(repo: string, email: string) {
  const config = { "user.name": "OpenClaw Test", "user.email": email, "commit.gpgSign": "false" };
  const overrides = Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  await git(repo, ...overrides, "commit", "--allow-empty", "-m", "source");
}

async function objectFixture(contents: string) {
  const primary = at("primary");
  const donor = at("donor");
  await git(root, "init", "--bare", "--template=", primary);
  await git(root, "init", "--bare", "--template=", donor);
  const file = await write(at("object.txt"), contents);
  const blob = await git(donor, "hash-object", "-w", file);
  const objects = path.join(primary, "objects");
  return {
    primary,
    donor,
    blob,
    objects,
    donorObjects: path.join(donor, "objects"),
    marker: path.join(objects, "info", "alternates"),
  };
}

it("selects exact packed refs while preserving loose overrides and missing aliases", async () => {
  const packed = "a".repeat(40);
  const loose = "b".repeat(40);
  const ref = "refs/heads/release.v1+hotfix";
  await write(at("refs/heads/main"), `${loose}\n`);
  await fs.writeFile(
    at("packed-refs"),
    [
      "# pack-refs with: peeled fully-peeled sorted",
      `${packed} refs/heads/main`,
      `${loose} ${ref}/child`,
      `${loose} refs/heads/releaseXv11hotfix`,
      `${packed} ${ref}`,
      `${packed} refs/tags/v1`,
      `^${loose}`,
      `${loose}\trefs/remotes/origin/main\r`,
      `${packed} refs/remotes/origin/tail`,
    ].join("\n"),
  );
  const expected = new Map([
    ["refs/heads/main", loose],
    [ref, packed],
    ["refs/tags/v1", packed],
    ["refs/remotes/origin/main", loose],
    ["refs/remotes/origin/tail", packed],
    ["refs/tags/HEAD", null],
  ]);
  expect(readGitRefs(root, [...expected.keys()])).toEqual(expected);
});

it("selects literal branch remotes across loose and packed refs", async () => {
  const value = "a".repeat(40);
  const branch = "feature/release.v1+hotfix";
  await write(at("refs/remotes/loose", branch), `${value}\n`);
  await write(at("refs/remotes/nested/fork", branch), `${value}\n`);
  await fs.writeFile(
    at("packed-refs"),
    [
      "# pack-refs with: peeled fully-peeled sorted",
      `${value} refs/openclaw/snapshots/retained`,
      `${value} refs/remotes/packed/${branch}`,
      `${value} refs/remotes/loose/${branch}`,
      `${value} refs/remotes/ignored/feature/releaseXv11hotfix`,
      `${value} refs/remotes/ignored/${branch}/child`,
      `${value} refs/remotes/ignored/${branch}-extra`,
      `^${value}`,
    ].join("\n"),
  );
  expect(readGitBranchTrackingRemotes(root, branch)).toEqual(["loose", "nested/fork", "packed"]);
});

it("keeps short-read retries within the bounded metadata window", async () => {
  const ref = await write(at("main"), `${"x".repeat(256)}abcdef0123456789`);
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

it.skipIf(process.platform === "win32").each(["HEAD", "refs/heads/main", "packed-refs"])(
  "refuses a FIFO %s instead of consuming ref bytes from a writer",
  async (name) => {
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
  },
);

it.each([
  [".git is a gitdir pointer file", "gitdir: .actual-git\n", "nested/workspace", true],
  ["invalid gitdir content without a parent repo", "not-a-gitdir-pointer\n", "nested", false],
] as const)("resolves git roots when %s", async (_name, pointer, nested, valid) => {
  const repoRoot = at("repo");
  const workspace = path.join(repoRoot, nested);
  const gitDir = path.join(repoRoot, ".actual-git");
  await fs.mkdir(workspace, { recursive: true });
  if (valid) {
    await write(path.join(gitDir, "HEAD"), `${"a".repeat(40)}\n`);
  }
  await fs.writeFile(path.join(repoRoot, ".git"), pointer);
  // Bound discovery to this fixture, never host-owned ancestors.
  const maxDepth = path.relative(root, workspace).split(path.sep).filter(Boolean).length + 1;
  expect(findGitRoot(workspace, { maxDepth })).toBe(repoRoot);
  expect(readGitHead(workspace, { maxDepth })?.headPath ?? null).toBe(
    valid ? path.join(gitDir, "HEAD") : null,
  );
});

it("matches native Git storage across normal, bare, and relocated linked layouts", async () => {
  const source = at("source");
  const checkout = at("checkout");
  const redirect = at("redirect");
  const bare = at(process.platform === "win32" ? "common store" : " common store ");
  await git(root, "init", "--template=", "-b", "main", source);
  await initialCommit(source, "openclaw-test@example.invalid");
  await git(root, "clone", "--bare", source, bare);
  await git(bare, "worktree", "add", "-b", "linked", checkout);
  const originalAdmin = await fs.realpath(await git(checkout, "rev-parse", "--absolute-git-dir"));
  const admin = at("storage", "private admin");
  const redirected = at("storage", "nested");
  await fs.mkdir(redirected, { recursive: true });
  await fs.symlink(redirected, redirect, directoryLink);
  await relocate(originalAdmin, admin);
  // Long native pointers must be read completely, including meaningful trailing spaces.
  const padding = "./".repeat(140);
  const pointer = `gitdir: ../redirect/../${padding}private admin\r\n`;
  await fs.writeFile(path.join(checkout, ".git"), pointer);
  const commonName = process.platform === "win32" ? "common alias" : " common alias ";
  const commonAlias = at(commonName);
  const commonMiddle = at("common-middle");
  await fs.symlink(bare, commonMiddle, "junction");
  await fs.symlink(commonMiddle, commonAlias, "junction");
  await fs.writeFile(path.join(admin, "commondir"), `../../${padding}${commonName}\r\n`);
  const controlPaths = [at("checkout-pointer"), at("common-pointer")];
  const controlAliases = [at("checkout-control-alias"), at("common-control-alias")];
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
  const alias = at("source-alias");
  await fs.mkdir(alias);
  await fs.symlink(path.join(source, ".git"), path.join(alias, ".git"), directoryLink);
  for (const repository of [source, bare, checkout, alias]) {
    const gitDir = await fs.realpath(await git(repository, "rev-parse", "--absolute-git-dir"));
    const commonPointer = await git(repository, "rev-parse", "--git-common-dir");
    const commonDir = await fs.realpath(
      path.isAbsolute(commonPointer) ? commonPointer : `${repository}${path.sep}${commonPointer}`,
    );
    expect(readGitMetadataDirectories(repository)).toMatchObject({
      gitDir,
      commonDir,
    });
  }
  expect(readGitHead(checkout, { maxDepth: 1 })?.value).toBe(
    await git(checkout, "rev-parse", "HEAD"),
  );
  expect(readGitMetadataDirectories(checkout)?.paths).toEqual(
    expect.arrayContaining([redirect, commonAlias, commonMiddle]),
  );
  expectBudget((check) => readGitMetadataDirectories(checkout, check));
  if (process.platform !== "win32") {
    expect(readGitMetadataDirectories(checkout)?.paths).toEqual(
      expect.arrayContaining([...controlPaths, ...controlAliases]),
    );
  }
  const nested = path.join(checkout, "nested");
  await fs.mkdir(nested);
  expect(readGitMetadataDirectories(nested)).toBeUndefined();
});

it.each([
  ["malformed gitfile", "checkout/.git", "not-a-gitfile\ngitdir: ../admin\n"],
  ["oversized gitfile", "checkout/.git", `gitdir: ../admin\n${"\n".repeat(1024 * 1024)}`],
  ["empty commondir", "admin/commondir", ""],
  ["oversized commondir", "admin/commondir", `../common\n${"\n".repeat(1024 * 1024)}`],
  ["non-file commondir", "admin/commondir", null],
  ["dangling commondir", "admin/commondir", null],
] as const)("keeps %s storage unresolved", async (kind, target, contents) => {
  const checkout = at("checkout");
  await write(at("checkout/.git"), "gitdir: ../admin\n");
  await write(at("admin/commondir"), "../common\n");
  await fs.mkdir(at("common"));
  const marker = at(target);
  if (contents !== null) {
    await fs.writeFile(marker, contents);
  } else {
    await fs.unlink(marker);
    if (kind === "non-file commondir") {
      await fs.mkdir(marker);
    } else {
      await fs.symlink(at("missing"), marker);
    }
  }
  expect(readGitMetadataDirectories(checkout)).toBeUndefined();
});
it.for(["absolute", "relative"] as const)(
  "retains native %s registration and symlink deletion roots independently of checkout markers",
  async (layout, context) => {
    const repo = at("repo");
    const checkout = at("checkout");
    await git(root, "init", "--template=", "-b", "main", repo);
    await initialCommit(repo, "git@example.invalid");
    const add = ["worktree", "add", "--detach", checkout, "HEAD"];
    await git(repo, "-c", "worktree.useRelativePaths=false", ...add);
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
      expect(path.isAbsolute((await fs.readFile(path.join(admin, "gitdir"), "utf8")).trim())).toBe(
        false,
      );
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

    const relocated = at("relocated-admin");
    await relocate(admin, relocated);
    await fs.writeFile(path.join(relocated, "commondir"), `${common}\n`);
    await fs.writeFile(path.join(relocated, "gitdir"), `${checkout}/.git\n`);
    await fs.writeFile(marker, `gitdir: ${relocated}\n`);
    const collateral = await write(path.join(relocated, "collateral.txt"), "collateral\n");
    expect(readAdministrations()).toEqual({
      entries: [{ checkoutPath: checkout, adminPath: admin, physicalAdminPath: relocated }],
      complete: true,
    });
    await git(repo, "worktree", "remove", "--force", "--force", checkout);
    await expect(fs.stat(collateral)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(admin)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("retains known registrations on bounded metadata failures and propagates the budget", async () => {
  const admin = at("worktrees/known");
  const checkout = at("missing-checkout");
  await write(path.join(admin, "gitdir"), `${checkout}/.git\n`);
  await write(at("worktrees/oversized/gitdir"), Buffer.alloc(1024 * 1024 + 1, 10));
  expect(readGitWorktreeAdministrations(root, () => {})).toEqual({
    entries: [{ checkoutPath: checkout, adminPath: admin, physicalAdminPath: admin }],
    complete: false,
  });
  expectBudget((check) => readGitWorktreeAdministrations(root, check));
});
it("follows native recursive alternates and physical control files without retaining old paths", async () => {
  const { primary, donor, blob } = await objectFixture("borrowed object\n");
  const objects = at("primary-objects");
  await relocate(path.join(primary, "objects"), objects);
  const control = at("control-info");
  await relocate(path.join(objects, "info"), control);
  const relay = at("relay-objects");
  const marker = path.join(control, "alternates");
  const relayMarker = await write(
    path.join(relay, "info", "alternates"),
    "../donor/objects\n../primary-objects\n",
  );
  await fs.writeFile(marker, '# ignored\n"../relay-objects"\n../donor/objects\n');

  expect(await git(primary, "cat-file", "-p", blob)).toBe("borrowed object");
  expectDependencies(primary, [
    objects,
    marker,
    relay,
    relayMarker,
    path.join(donor, "objects"),
    path.join(primary, "objects"),
    path.join(objects, "info"),
  ]);
  expectBudget((check) => readGitObjectStorageDependencies(primary, check), 3);

  await fs.writeFile(marker, "");
  expectDependencies(primary, [objects, marker]);
  const refreshed = readGitObjectStorageDependencies(primary, () => {}).paths;
  expect(refreshed).not.toContain(relay);
  expect(refreshed).not.toContain(path.join(donor, "objects"));
  await expect(git(primary, "cat-file", "-p", blob)).rejects.toThrow();
});

it.skipIf(process.platform === "win32")(
  "preserves native C quoting, literal fallback, and whitespace in alternate paths",
  async () => {
    const { primary, blob, objects, donorObjects, marker } = await objectFixture("quoted object\n");
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
      expectDependencies(primary, [objects, marker, donorObjects, path.join(objects, name)]);
    }
  },
);

it("matches Git's six-store alternate depth limit", async () => {
  const primary = at("primary");
  await git(root, "init", "--bare", "--template=", primary);
  const stores = [
    path.join(primary, "objects"),
    ...Array.from({ length: 7 }, (_, i) => at(`objects-${i}`)),
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
  const paths = stores.slice(0, 7).flatMap((store) => [store, path.join(store, "info/alternates")]);
  expect(readGitObjectStorageDependencies(primary, () => {})).toEqual({ complete: true, paths });
});

it.each([
  ["missing target", Buffer.from("../../missing\n")],
  ["invalid UTF-8", Buffer.from([0xff, 10])],
  ["NUL", Buffer.from([0, 10])],
  ["oversized file", null],
  ["non-file", null],
  ["dangling control", null],
  ["dangling alias", Buffer.from("../../first-link\n")],
  ["cyclic alias", Buffer.from("../../first-link\n")],
] as const)(
  "retains partial object dependencies when an alternate has %s",
  async (kind, suffix) => {
    const primary = at("primary");
    const objects = path.join(primary, "objects");
    const known = at("known");
    const marker = path.join(objects, "info", "alternates");
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.mkdir(known);
    const valid = Buffer.from("../../known\n");
    if (suffix) {
      await fs.writeFile(marker, Buffer.concat([valid, suffix]));
    }
    if (kind === "oversized file") {
      await fs.writeFile(marker, Buffer.alloc(1024 * 1024 + 1, 10));
    } else if (kind === "non-file") {
      await fs.mkdir(marker);
    } else if (kind === "dangling alias" || kind === "cyclic alias") {
      const first = at("first-link");
      const second = at("second-link");
      await fs.symlink(second, first, "junction");
      await fs.symlink(kind === "cyclic alias" ? first : at("missing"), second, "junction");
    } else if (kind === "dangling control") {
      await fs.symlink(at("missing"), marker);
    }
    const aliases = kind === "dangling alias" || kind === "cyclic alias";
    expectDependencies(
      primary,
      [
        objects,
        ...(suffix ? [known] : []),
        ...(aliases ? [at("first-link"), at("second-link")] : []),
      ],
      false,
    );
  },
);
