import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import {
  expectPrivateMetadata,
  gitCommonDirectory,
  gitDirectory,
  linkDirectory,
  read,
  relocatePrivateGitDirectory,
  write,
} from "./eviction.test-support.js";
import { requireGit } from "./git.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import { hasLiveWorktreeRunLease, testing as runLeaseTesting } from "./run-lease.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

const initializeRepository = useManagedWorktreeTestRepository();
const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    runLeaseTesting.resetForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

let root: string;
let repoRoot: string;
let env: NodeJS.ProcessEnv;
let service: ManagedWorktreeService;
let config: { worktreeMaxCount: number; worktreeAcceleration: boolean };
beforeEach(async () => {
  root = temps.make("openclaw-eviction-nesting-");
  repoRoot = await initializeRepository(root);
  env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  config = { worktreeMaxCount: 2, worktreeAcceleration: false };
  service = new ManagedWorktreeService({ env, getConfig: () => config });
});
const create = (name: string, source = repoRoot, target = service) =>
  target.create({ repoRoot: source, name, baseRef: "HEAD" });
const registry = (id: string) => getRegistryWorktree(env, id);
const head = (checkout: string) => requireGit(checkout, ["rev-parse", "--verify", "HEAD"]);
async function expectExternalLive(record: { id: string; path: string }, contents: string) {
  expect(registry(record.id)?.removedAt).toBeUndefined();
  expect(await head(record.path)).toBeTruthy();
  expect(await read(record.path, "unsaved.txt")).toBe(contents);
}
const liveIds = async () =>
  (await service.listRegistryRecords())
    .filter((record) => record.removedAt === undefined)
    .map((record) => record.id);
async function withRunLease(id: string, run: () => Promise<void>) {
  const lease = await acquireWorktreeRunLease(id, { env });
  try {
    await run();
  } finally {
    await lease.release();
  }
}
async function externalFixture() {
  const outer = await create("outer");
  const source = await initializeRepository(path.join(root, "external-source"));
  const external = await create("external", source);
  return { outer, source, external };
}
function onSnapshot(checkoutPath: string, effect: () => Promise<void>) {
  const execute = gitExec.executeGitCommandBuffered;
  vi.spyOn(gitExec, "executeGitCommandBuffered").mockImplementation(async (cwd, args, options) => {
    if (
      cwd === checkoutPath &&
      args.includes("ls-files") &&
      args.includes("--stage") &&
      options?.operation === "worktree.snapshot"
    ) {
      await effect();
    }
    return execute(cwd, args, options);
  });
}

it("cannot evict an ancestor of a live checkout and retires idle children individually", async () => {
  const outer = await create("outer");
  const nested = new ManagedWorktreeService({
    env,
    getConfig: () => ({ ...config, worktreeRoot: path.join(outer.path, "children") }),
  });
  const child = await create("child", repoRoot, nested);
  await write(child.path, "unsaved.txt", "child data\n");
  await withRunLease(child.id, async () => {
    await expect(create("replacement")).rejects.toThrow(/cap 2.*live owners/);
    expect(await read(child.path, "unsaved.txt")).toBe("child data\n");
    expect(registry(outer.id)?.removedAt).toBeUndefined();
    expect(registry(child.id)?.removedAt).toBeUndefined();
  });
  config.worktreeMaxCount = 1;
  await create("replacement");
  expect(registry(outer.id)?.removedAt).toEqual(expect.any(Number));
  expect(registry(child.id)?.snapshotRef).toBeTruthy();
  expect(registry(child.id)?.removedAt).toEqual(expect.any(Number));
  expect(await liveIds()).toHaveLength(1);
});

it("preserves a live dependent's chained object lookup at the cap", async () => {
  const outer = await create("donor-owner");
  const donor = await initializeRepository(path.join(root, "donor"));
  const source = path.join(root, "shared-source");
  const filename = "borrowed-only.txt";
  const contents = "unique shared-clone object bytes for live dependent\n";
  await write(donor, filename, contents);
  await requireGit(donor, ["add", filename]);
  await requireGit(donor, ["commit", "-m", "unique shared-clone donor for live dependent"]);
  const commit = await requireGit(donor, ["rev-parse", "HEAD"]);
  const blob = await requireGit(donor, ["rev-parse", `HEAD:${filename}`]);
  await requireGit(root, ["clone", "--shared", "--", donor, source]);
  const alternatesFile = path.join(source, ".git", "objects", "info", "alternates");
  const alternates = (await fs.readFile(alternatesFile, "utf8")).trim();
  const lookup = path.join(outer.path, "odb-link");
  await linkDirectory(alternates, lookup);
  const declaredLookup = path.join(root, "object-alias");
  await linkDirectory(lookup, declaredLookup);
  await fs.writeFile(alternatesFile, `${declaredLookup}\n`);
  const dependent = await create("dependent", source);
  await withRunLease(dependent.id, async () => {
    await expect(create("replacement")).rejects.toThrow(/cap 2/);
    expect(registry(outer.id)?.removedAt).toBeUndefined();
    expect((await liveIds()).toSorted()).toEqual([outer.id, dependent.id].toSorted());
    expect(await read(donor, filename)).toBe(contents);
    for (const repository of [source, dependent.path]) {
      expect(await requireGit(repository, ["cat-file", "-e", `${commit}^{commit}`])).toBe("");
      expect(await requireGit(repository, ["cat-file", "blob", blob])).toBe(contents.trim());
    }
    expect(hasLiveWorktreeRunLease(env, dependent.id)).toBe(true);
  });
});

it("refuses a late live owner of unresolved shared metadata before deleting its container", async () => {
  const { outer, source, external } = await externalFixture();
  const commonDir = await gitCommonDirectory(source);
  const unavailableGit = path.join(outer.path, "unavailable-source-git");
  await write(external.path, "unsaved.txt", "live dependency bytes\n");
  const { id, path: checkoutPath, lastActiveAt } = registry(outer.id)!;
  let lease: Awaited<ReturnType<typeof acquireWorktreeRunLease>> | undefined;
  let unavailable = false;
  onSnapshot(outer.path, async () => {
    if (!unavailable) {
      lease = await acquireWorktreeRunLease(external.id, { env });
      await fs.rename(commonDir, unavailableGit);
      unavailable = true;
    }
  });
  const logFile = path.join(root, "evict.log");
  setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logFile });
  try {
    await expect(create("replacement")).rejects.toThrow(/cap 2.*live owners/);
    expect(unavailable).toBe(true);
    expect(lease).toBeDefined();
    await flushLogger();
    const fileLog = await fs.readFile(logFile, "utf8");
    expect(fileLog.split("\n").filter((line) => line.includes(external.id))).toContainEqual(
      expect.stringContaining(`Worktree eviction live-refused: ${outer.id}`),
    );
    expect(registry(outer.id)).toMatchObject({ id, path: checkoutPath, lastActiveAt });
    expect(registry(outer.id)?.removedAt).toBeUndefined();
    await fs.rename(unavailableGit, commonDir);
    unavailable = false;
    await expectExternalLive(external, "live dependency bytes\n");
  } finally {
    try {
      if (unavailable) {
        await fs.rename(unavailableGit, commonDir);
      }
    } finally {
      await lease?.release();
      setLoggerOverride(null);
      resetLogger();
    }
  }
});

it.each([
  "checkpoint",
  "snapshot",
  "snapshot with replaced source",
  "snapshot with private metadata",
] as const)(
  "rechecks relocated backing metadata after the %s await before purging",
  async (phase) => {
    const { outer, source, external } = await externalFixture();
    await write(external.path, "unsaved.txt", "relocated live data\n");
    let relocated = false;
    let originalSource: string | undefined;
    let lease: Awaited<ReturnType<typeof acquireWorktreeRunLease>> | undefined;
    let privateMetadata: Awaited<ReturnType<typeof relocatePrivateGitDirectory>> | undefined;
    const relocate = async () => {
      if (relocated) {
        return;
      }
      relocated = true;
      if (phase === "snapshot with private metadata") {
        privateMetadata = await relocatePrivateGitDirectory(
          external.path,
          path.join(outer.path, "private-git"),
        );
        expect(privateMetadata.commonDirectory.startsWith(`${outer.path}${path.sep}`)).toBe(false);
      } else {
        const relocatedGit = path.join(outer.path, "relocated-git");
        await requireGit(source, ["init", "--separate-git-dir", relocatedGit]);
        await requireGit(source, ["worktree", "repair", external.path]);
      }
      lease = await acquireWorktreeRunLease(external.id, { env });
      if (phase === "snapshot with replaced source") {
        await fs.rename(source, `${source}-original`);
        originalSource = `${source}-original`;
        await initializeRepository(path.dirname(source));
      }
    };
    if (phase !== "checkpoint") {
      onSnapshot(outer.path, relocate);
    }
    config.worktreeMaxCount = 1;
    try {
      const checkpoint = phase === "checkpoint" ? relocate : undefined;
      const result = await service.gc({ checkpoint });
      expect(lease).toBeDefined();
      expect(result).toMatchObject({
        removed: [],
        limitsSatisfied: false,
        issues: expect.arrayContaining([
          expect.objectContaining({
            id: outer.id,
            reason: expect.stringContaining(`repository dependency: ${external.id}`),
          }),
        ]),
      });
      expect(registry(outer.id)?.removedAt).toBeUndefined();
      expect(await read(outer.path, "README.md")).toBe("base\n");
      await expectExternalLive(external, "relocated live data\n");
      if (phase === "snapshot with private metadata") {
        await expectPrivateMetadata(privateMetadata!);
      }
    } finally {
      if (originalSource) {
        await fs.rm(source, { recursive: true, force: true });
        await fs.rename(originalSource, source);
      }
      await lease?.release();
    }
  },
);

it.each([
  ["source repository", "checkout", false],
  ["source repository", "native administration", true],
  ["private Git directory", "symlinked native administration", false],
] as const)(
  "preserves an external live checkout backed by %s in %s",
  async (layout, surface, missingCheckout) => {
    const outer = await create("outer");
    let storageRoot = outer.path;
    if (surface !== "checkout") {
      storageRoot = await gitDirectory(outer.path);
      if (surface === "symlinked native administration") {
        storageRoot = (
          await relocatePrivateGitDirectory(outer.path, path.join(root, "relocated-outer-admin"))
        ).directory;
      }
    }
    const source = await initializeRepository(
      path.join(layout === "source repository" ? storageRoot : root, "nested-source"),
    );
    const external = await create("external", source);
    const privateMetadata =
      layout === "private Git directory"
        ? await relocatePrivateGitDirectory(external.path, path.join(storageRoot, "private-git"))
        : undefined;
    await write(external.path, "unsaved.txt", "external checkout data\n");
    const original = registry(outer.id);
    await withRunLease(external.id, async () => {
      if (missingCheckout) {
        await fs.rm(outer.path, { recursive: true });
      }
      await expect(create("replacement")).rejects.toThrow(/cap 2.*live owners/);
      expect(registry(outer.id)?.removedAt).toBeUndefined();
      if (surface === "checkout") {
        expect(registry(outer.id)).toEqual(original);
      }
      expect(hasLiveWorktreeRunLease(env, external.id)).toBe(true);
      await expectExternalLive(external, "external checkout data\n");
      expect(await requireGit(source, ["cat-file", "-e", "HEAD^{commit}"])).toBe("");
      if (privateMetadata) {
        await expectPrivateMetadata(privateMetadata);
      }
    });
    if (surface !== "checkout") {
      return;
    }
    const replacement = await create("replacement");
    expect(registry(outer.id)).toEqual(original);
    const retired = registry(external.id)!;
    expect(retired.removedAt).toEqual(expect.any(Number));
    expect(await requireGit(source, ["show", `${retired.snapshotRef}:unsaved.txt`])).toBe(
      "external checkout data",
    );
    config.worktreeMaxCount = 1;
    await service.gc();
    expect(registry(outer.id)?.removedAt).toEqual(expect.any(Number));
    expect(await liveIds()).toEqual([replacement.id]);
  },
);

it.each(["native administration", "control file"] as const)(
  "preserves an incoming linked source with storage in the victim %s",
  async (layout) => {
    config.worktreeMaxCount = 1;
    const outer = await create("outer");
    const sourceBase = await initializeRepository(path.join(root, "source-base"));
    const source = path.join(root, "incoming-source");
    await requireGit(sourceBase, ["worktree", "add", "-b", "incoming", source, "HEAD"]);
    await write(source, "staged-source.txt", "incoming staged bytes\n");
    await requireGit(source, ["add", "staged-source.txt"]);
    const originalHead = await head(source);
    let directory = await gitDirectory(source);
    const index = await fs.readFile(path.join(directory, "index"));
    if (layout === "control file") {
      const pointer = path.join(outer.path, "incoming.gitfile");
      await fs.rename(path.join(source, ".git"), pointer);
      await fs.symlink(pointer, path.join(source, ".git"), "file");
    } else {
      const storageRoot = await gitDirectory(outer.path);
      directory = (
        await relocatePrivateGitDirectory(source, path.join(storageRoot, "incoming-private"))
      ).directory;
    }
    await expect(create("replacement", source)).rejects.toThrow(/cap 1/);
    expect(registry(outer.id)?.removedAt).toBeUndefined();
    expect(await liveIds()).toEqual([outer.id]);
    expect(await read(outer.path, "README.md")).toBe("base\n");
    expect(await fs.readFile(path.join(directory, "index"))).toEqual(index);
    expect(await head(source)).toBe(originalHead);
    expect(await requireGit(source, ["show", ":staged-source.txt"])).toBe("incoming staged bytes");
  },
);
