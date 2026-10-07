import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../logging/test-helpers/diagnostic-log-capture.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { listGitWorktrees, requireGit } from "./git.js";
import { getRegistryWorktree } from "./registry.js";
import { acquireWorktreeRunLease, hasLiveWorktreeRunLease } from "./run-lease.js";
import { testing as runLeaseTesting } from "./run-lease.test-support.js";
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

async function relocatePrivateGitDirectory(checkoutPath: string, directory: string) {
  const originalDirectory = await fs.realpath(
    await requireGit(checkoutPath, ["rev-parse", "--absolute-git-dir"]),
  );
  const commonDirectory = await fs.realpath(
    path.resolve(checkoutPath, await requireGit(checkoutPath, ["rev-parse", "--git-common-dir"])),
  );
  await fs.rename(originalDirectory, directory);
  await fs.writeFile(path.join(directory, "commondir"), `${commonDirectory}\n`);
  await fs.writeFile(path.join(checkoutPath, ".git"), `gitdir: ${directory}\n`);
  await fs.symlink(directory, originalDirectory, process.platform === "win32" ? "junction" : "dir");
  return {
    directory,
    commonDirectory,
    head: await fs.readFile(path.join(directory, "HEAD")),
    index: await fs.readFile(path.join(directory, "index")),
  };
}

it("cannot evict an ancestor of a live checkout and retires idle children individually", async () => {
  const root = temps.make("openclaw-eviction-nesting-");
  const repoRoot = await initializeRepository(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const config = { worktreeMaxCount: 2, worktreeAcceleration: false };
  const service = new ManagedWorktreeService({ env, getConfig: () => config });
  const outer = await service.create({ repoRoot, name: "outer", baseRef: "HEAD" });
  const nested = new ManagedWorktreeService({
    env,
    getConfig: () => ({ ...config, worktreeRoot: path.join(outer.path, "children") }),
  });
  const child = await nested.create({ repoRoot, name: "child", baseRef: "HEAD" });
  await fs.writeFile(path.join(child.path, "unsaved.txt"), "child data\n");
  const lease = await acquireWorktreeRunLease(child.id, { env });
  try {
    await expect(
      service.create({ repoRoot, name: "replacement", baseRef: "HEAD" }),
    ).rejects.toThrow(/cap 2.*live owners/);
    expect(await fs.readFile(path.join(child.path, "unsaved.txt"), "utf8")).toBe("child data\n");
    expect(getRegistryWorktree(env, outer.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, child.id)?.removedAt).toBeUndefined();
  } finally {
    await lease.release();
  }
  config.worktreeMaxCount = 1;
  await service.create({ repoRoot, name: "replacement", baseRef: "HEAD" });
  expect(getRegistryWorktree(env, outer.id)?.removedAt).toEqual(expect.any(Number));
  expect(getRegistryWorktree(env, child.id)?.snapshotRef).toBeTruthy();
  expect(getRegistryWorktree(env, child.id)?.removedAt).toEqual(expect.any(Number));
  expect(
    (await service.listRegistryRecords()).filter((record) => record.removedAt === undefined),
  ).toHaveLength(1);
});

it.each([
  ["live dependent", "nested donor"],
  ["incoming create", "nested donor"],
  ["live dependent", "chained donor lookup"],
  ["incoming create", "symlinked donor lookup"],
] as const)(
  "preserves shared-clone objects needed by a %s through a %s at the cap",
  async (consumer, layout) => {
    const root = temps.make("openclaw-eviction-shared-objects-");
    const repoRoot = await initializeRepository(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const config = {
      worktreeMaxCount: consumer === "live dependent" ? 2 : 1,
      worktreeAcceleration: false,
    };
    const service = new ManagedWorktreeService({ env, getConfig: () => config });
    const outer = await service.create({ repoRoot, name: "donor-owner", baseRef: "HEAD" });
    const donor = path.join(layout === "nested donor" ? outer.path : root, "donor");
    const source = path.join(root, "shared-source");
    const filename = "borrowed-only.txt";
    const contents = `unique shared-clone object bytes for ${consumer}\n`;
    await fs.mkdir(donor);
    await requireGit(donor, ["init", "--template=", "-b", "main"]);
    await fs.writeFile(path.join(donor, filename), contents);
    await requireGit(donor, ["add", filename]);
    await requireGit(donor, [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=openclaw-test@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      `unique shared-clone donor for ${consumer}`,
    ]);
    const commit = await requireGit(donor, ["rev-parse", "HEAD"]);
    const blob = await requireGit(donor, ["rev-parse", `HEAD:${filename}`]);
    await requireGit(root, ["clone", "--shared", "--", donor, source]);
    const alternatesFile = path.join(source, ".git", "objects", "info", "alternates");
    const alternates = (await fs.readFile(alternatesFile, "utf8")).trim();
    expect(await fs.realpath(alternates)).toBe(
      await fs.realpath(path.join(donor, ".git", "objects")),
    );
    if (layout !== "nested donor") {
      const lookup = path.join(outer.path, "odb-link");
      await fs.symlink(alternates, lookup, process.platform === "win32" ? "junction" : "dir");
      let declaredLookup = lookup;
      if (layout === "chained donor lookup") {
        declaredLookup = path.join(root, "object-alias");
        await fs.symlink(lookup, declaredLookup, process.platform === "win32" ? "junction" : "dir");
      }
      await fs.writeFile(alternatesFile, `${declaredLookup}\n`);
    }
    expect(await requireGit(source, ["cat-file", "-e", `${commit}^{commit}`])).toBe("");
    expect(await requireGit(source, ["cat-file", "blob", blob])).toBe(contents.trim());
    const dependent =
      consumer === "live dependent"
        ? await service.create({ repoRoot: source, name: "dependent", baseRef: "HEAD" })
        : undefined;
    const lease = dependent ? await acquireWorktreeRunLease(dependent.id, { env }) : undefined;
    try {
      if (dependent) {
        expect(hasLiveWorktreeRunLease(env, dependent.id)).toBe(true);
        expect(await requireGit(dependent.path, ["cat-file", "-e", `${commit}^{commit}`])).toBe("");
        expect(await requireGit(dependent.path, ["cat-file", "blob", blob])).toBe(contents.trim());
      }
      await expect(
        service.create({
          repoRoot: dependent ? repoRoot : source,
          name: "replacement",
          baseRef: "HEAD",
        }),
      ).rejects.toThrow(new RegExp(`cap ${config.worktreeMaxCount}`));
      expect(getRegistryWorktree(env, outer.id)?.removedAt).toBeUndefined();
      expect(
        (await service.listRegistryRecords())
          .filter((record) => record.removedAt === undefined)
          .map((record) => record.id)
          .toSorted(),
      ).toEqual([outer.id, ...(dependent ? [dependent.id] : [])].toSorted());
      expect(await fs.readFile(path.join(donor, filename), "utf8")).toBe(contents);
      for (const repository of [source, ...(dependent ? [dependent.path] : [])]) {
        expect(await requireGit(repository, ["cat-file", "-e", `${commit}^{commit}`])).toBe("");
        expect(await requireGit(repository, ["cat-file", "blob", blob])).toBe(contents.trim());
      }
      if (dependent) {
        expect(hasLiveWorktreeRunLease(env, dependent.id)).toBe(true);
      }
    } finally {
      await lease?.release();
    }
  },
);

it("refuses a late live owner of unresolved shared metadata before deleting its container", async () => {
  const root = temps.make("openclaw-eviction-late-dependency-lease-");
  const repoRoot = await initializeRepository(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const service = new ManagedWorktreeService({
    env,
    getConfig: () => ({ worktreeMaxCount: 2, worktreeAcceleration: false }),
  });
  const outer = await service.create({ repoRoot, name: "outer", baseRef: "HEAD" });
  const source = await initializeRepository(path.join(root, "external-source"));
  const external = await service.create({ repoRoot: source, name: "external", baseRef: "HEAD" });
  const commonDir = await fs.realpath(
    path.resolve(source, await requireGit(source, ["rev-parse", "--git-common-dir"])),
  );
  const unavailableGit = path.join(outer.path, "unavailable-source-git");
  await fs.writeFile(path.join(external.path, "unsaved.txt"), "live dependency bytes\n");
  const original = getRegistryWorktree(env, outer.id);
  const execute = gitExec.executeGitCommandBuffered;
  let lease: Awaited<ReturnType<typeof acquireWorktreeRunLease>> | undefined;
  let unavailable = false;
  vi.spyOn(gitExec, "executeGitCommandBuffered").mockImplementation(async (cwd, args, options) => {
    if (
      !unavailable &&
      cwd === outer.path &&
      args.includes("ls-files") &&
      args.includes("--stage") &&
      options?.operation === "worktree.snapshot"
    ) {
      lease = await acquireWorktreeRunLease(external.id, { env });
      await fs.rename(commonDir, unavailableGit);
      unavailable = true;
    }
    return await execute(cwd, args, options);
  });
  setLoggerOverride({
    level: "warn",
    consoleLevel: "silent",
    file: path.join(root, "eviction.log"),
  });
  const logs = createDiagnosticLogRecordCapture();
  try {
    await expect(
      service.create({ repoRoot, name: "replacement", baseRef: "HEAD" }),
    ).rejects.toThrow(/cap 2.*live owners/);
    expect(unavailable).toBe(true);
    expect(lease).toBeDefined();
    await logs.flush();
    expect(
      logs.records.some(
        (record) =>
          record.message.includes(`Worktree eviction live-refused: ${outer.id}`) &&
          record.message.includes(external.id),
      ),
    ).toBe(true);
    expect(getRegistryWorktree(env, outer.id)).toMatchObject({
      id: original!.id,
      path: original!.path,
      lastActiveAt: original!.lastActiveAt,
    });
    expect(getRegistryWorktree(env, outer.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, external.id)?.removedAt).toBeUndefined();
    await fs.rename(unavailableGit, commonDir);
    unavailable = false;
    expect(await requireGit(external.path, ["rev-parse", "--verify", "HEAD"])).toBeTruthy();
    expect(await fs.readFile(path.join(external.path, "unsaved.txt"), "utf8")).toBe(
      "live dependency bytes\n",
    );
  } finally {
    try {
      if (unavailable) {
        await fs.rename(unavailableGit, commonDir);
      }
    } finally {
      await lease?.release();
      logs.cleanup();
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
    const root = temps.make("openclaw-eviction-relocated-dependency-");
    const repoRoot = await initializeRepository(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const config = { worktreeMaxCount: 2, worktreeAcceleration: false };
    const service = new ManagedWorktreeService({ env, getConfig: () => config });
    const outer = await service.create({ repoRoot, name: "outer", baseRef: "HEAD" });
    const source = await initializeRepository(path.join(root, "external-source"));
    const external = await service.create({ repoRoot: source, name: "external", baseRef: "HEAD" });
    await fs.writeFile(path.join(external.path, "unsaved.txt"), "relocated live data\n");
    let relocated = false;
    let lease: Awaited<ReturnType<typeof acquireWorktreeRunLease>> | undefined;
    let privateMetadata: { directory: string; head: Buffer; index: Buffer } | undefined;
    const relocate = async () => {
      if (relocated) {
        return;
      }
      relocated = true;
      if (phase === "snapshot with private metadata") {
        const storage = await relocatePrivateGitDirectory(
          external.path,
          path.join(outer.path, "private-git"),
        );
        expect(storage.commonDirectory.startsWith(`${outer.path}${path.sep}`)).toBe(false);
        expect(
          await fs.realpath(await requireGit(external.path, ["rev-parse", "--git-path", "index"])),
        ).toBe(path.join(storage.directory, "index"));
        expect(await requireGit(external.path, ["status", "--porcelain"])).toBe("?? unsaved.txt");
        expect(await listGitWorktrees(source)).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: external.path })]),
        );
        privateMetadata = storage;
      } else {
        await requireGit(source, [
          "init",
          "--separate-git-dir",
          path.join(outer.path, "relocated-git"),
        ]);
        await requireGit(source, ["worktree", "repair", external.path]);
      }
      lease = await acquireWorktreeRunLease(external.id, { env });
      if (phase === "snapshot with replaced source") {
        await fs.rename(source, `${source}-original`);
        expect(await initializeRepository(path.dirname(source))).toBe(source);
        expect(await requireGit(source, ["rev-parse", "--git-common-dir"])).toBe(".git");
      }
    };
    const execute = gitExec.executeGitCommandBuffered;
    if (phase !== "checkpoint") {
      vi.spyOn(gitExec, "executeGitCommandBuffered").mockImplementation(
        async (cwd, args, options) => {
          if (
            cwd === outer.path &&
            args.includes("ls-files") &&
            args.includes("--stage") &&
            options?.operation === "worktree.snapshot"
          ) {
            await relocate();
          }
          return await execute(cwd, args, options);
        },
      );
    }
    config.worktreeMaxCount = 1;
    try {
      const result = await service.gc({
        checkpoint: async () => {
          if (phase === "checkpoint") {
            await relocate();
          }
        },
      });
      expect(relocated).toBe(true);
      expect(lease).toBeDefined();
      expect(result.removed).toEqual([]);
      expect(result.limitsSatisfied).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: outer.id,
            reason: expect.stringContaining(`repository dependency: ${external.id}`),
          }),
        ]),
      );
      expect(getRegistryWorktree(env, outer.id)?.removedAt).toBeUndefined();
      expect(getRegistryWorktree(env, external.id)?.removedAt).toBeUndefined();
      expect(await requireGit(external.path, ["rev-parse", "--verify", "HEAD"])).toBeTruthy();
      expect(await fs.readFile(path.join(outer.path, "README.md"), "utf8")).toBe("base\n");
      expect(await fs.readFile(path.join(external.path, "unsaved.txt"), "utf8")).toBe(
        "relocated live data\n",
      );
      if (phase === "snapshot with private metadata") {
        expect(privateMetadata).toBeDefined();
        expect(await fs.readFile(path.join(privateMetadata!.directory, "HEAD"))).toEqual(
          privateMetadata!.head,
        );
        expect(await fs.readFile(path.join(privateMetadata!.directory, "index"))).toEqual(
          privateMetadata!.index,
        );
      }
    } finally {
      await lease?.release();
    }
  },
);

it.each([
  { layout: "source repository", surface: "checkout", missingCheckout: false },
  { layout: "shared Git directory", surface: "checkout", missingCheckout: false },
  { layout: "source repository", surface: "native administration", missingCheckout: true },
  { layout: "shared Git directory", surface: "native administration", missingCheckout: false },
  {
    layout: "private Git directory",
    surface: "symlinked native administration",
    missingCheckout: false,
  },
] as const)(
  "preserves an external live checkout backed by $layout in $surface",
  async ({ layout, surface, missingCheckout }) => {
    const root = temps.make("openclaw-eviction-repository-dependency-");
    const repoRoot = await initializeRepository(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const config = { worktreeMaxCount: 2, worktreeAcceleration: false };
    const service = new ManagedWorktreeService({ env, getConfig: () => config });
    const outer = await service.create({ repoRoot, name: "outer", baseRef: "HEAD" });
    let storageRoot = outer.path;
    if (surface !== "checkout") {
      storageRoot = await fs.realpath(
        await requireGit(outer.path, ["rev-parse", "--absolute-git-dir"]),
      );
      if (surface === "symlinked native administration") {
        const commonDirectory = await fs.realpath(
          path.resolve(outer.path, await requireGit(outer.path, ["rev-parse", "--git-common-dir"])),
        );
        const relocated = path.join(root, "relocated-outer-admin");
        await fs.rename(storageRoot, relocated);
        await fs.symlink(relocated, storageRoot, process.platform === "win32" ? "junction" : "dir");
        await fs.writeFile(path.join(relocated, "commondir"), `${commonDirectory}\n`);
        await fs.writeFile(path.join(outer.path, ".git"), `gitdir: ${relocated}\n`);
        storageRoot = relocated;
      }
    }
    const source = await initializeRepository(
      path.join(layout === "source repository" ? storageRoot : root, "nested-source"),
    );
    if (layout === "shared Git directory") {
      await requireGit(source, [
        "init",
        "--separate-git-dir",
        path.join(storageRoot, "shared-git"),
      ]);
    }
    const external = await service.create({ repoRoot: source, name: "external", baseRef: "HEAD" });
    const privateMetadata =
      layout === "private Git directory"
        ? await relocatePrivateGitDirectory(external.path, path.join(storageRoot, "private-git"))
        : undefined;
    const commonDir = await fs.realpath(
      path.resolve(
        external.path,
        await requireGit(external.path, ["rev-parse", "--git-common-dir"]),
      ),
    );
    expect((privateMetadata?.directory ?? commonDir).startsWith(`${storageRoot}${path.sep}`)).toBe(
      true,
    );
    await fs.writeFile(path.join(external.path, "unsaved.txt"), "external checkout data\n");
    const original = getRegistryWorktree(env, outer.id);
    const lease = await acquireWorktreeRunLease(external.id, { env });
    try {
      expect(hasLiveWorktreeRunLease(env, external.id)).toBe(true);
      if (missingCheckout) {
        await fs.rm(outer.path, { recursive: true });
      }
      await expect(
        service.create({ repoRoot, name: "replacement", baseRef: "HEAD" }),
      ).rejects.toThrow(/cap 2.*live owners/);
      expect(getRegistryWorktree(env, outer.id)?.removedAt).toBeUndefined();
      if (surface === "checkout") {
        expect(getRegistryWorktree(env, outer.id)).toEqual(original);
      }
      expect(getRegistryWorktree(env, external.id)?.removedAt).toBeUndefined();
      expect(hasLiveWorktreeRunLease(env, external.id)).toBe(true);
      expect(await requireGit(external.path, ["rev-parse", "--verify", "HEAD"])).toBeTruthy();
      expect(await requireGit(source, ["cat-file", "-e", "HEAD^{commit}"])).toBe("");
      expect(await fs.readFile(path.join(external.path, "unsaved.txt"), "utf8")).toBe(
        "external checkout data\n",
      );
      if (privateMetadata) {
        expect(await fs.readFile(path.join(privateMetadata.directory, "HEAD"))).toEqual(
          privateMetadata.head,
        );
        expect(await fs.readFile(path.join(privateMetadata.directory, "index"))).toEqual(
          privateMetadata.index,
        );
      }
    } finally {
      await lease.release();
    }
    if (surface !== "checkout") {
      return;
    }
    const replacement = await service.create({ repoRoot, name: "replacement", baseRef: "HEAD" });
    expect(getRegistryWorktree(env, outer.id)).toEqual(original);
    const retired = getRegistryWorktree(env, external.id)!;
    expect(retired.removedAt).toEqual(expect.any(Number));
    expect(await requireGit(source, ["show", `${retired.snapshotRef}:unsaved.txt`])).toBe(
      "external checkout data",
    );
    config.worktreeMaxCount = 1;
    await service.gc();
    expect(getRegistryWorktree(env, outer.id)?.removedAt).toEqual(expect.any(Number));
    expect(
      (await service.listRegistryRecords())
        .filter((record) => record.removedAt === undefined)
        .map((record) => record.id),
    ).toEqual([replacement.id]);
  },
);

it.each(["checkout", "native administration", "control file"] as const)(
  "preserves an incoming linked source with storage in the victim %s",
  async (layout) => {
    const root = temps.make("openclaw-eviction-incoming-storage-");
    const repoRoot = await initializeRepository(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const service = new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeMaxCount: 1, worktreeAcceleration: false }),
    });
    const outer = await service.create({ repoRoot, name: "outer", baseRef: "HEAD" });
    const sourceBase = await initializeRepository(path.join(root, "source-base"));
    const source = path.join(root, "incoming-source");
    await requireGit(sourceBase, ["worktree", "add", "-b", "incoming", source, "HEAD"]);
    await fs.writeFile(path.join(source, "staged-source.txt"), "incoming staged bytes\n");
    await requireGit(source, ["add", "staged-source.txt"]);
    const head = await requireGit(source, ["rev-parse", "--verify", "HEAD"]);
    let directory = await fs.realpath(
      await requireGit(source, ["rev-parse", "--absolute-git-dir"]),
    );
    const index = await fs.readFile(path.join(directory, "index"));
    if (layout === "control file") {
      const pointer = path.join(outer.path, "incoming.gitfile");
      await fs.rename(path.join(source, ".git"), pointer);
      await fs.symlink(pointer, path.join(source, ".git"), "file");
    } else {
      const storageRoot =
        layout === "checkout"
          ? outer.path
          : await fs.realpath(await requireGit(outer.path, ["rev-parse", "--absolute-git-dir"]));
      directory = (
        await relocatePrivateGitDirectory(source, path.join(storageRoot, "incoming-private"))
      ).directory;
    }
    expect(await requireGit(source, ["show", ":staged-source.txt"])).toBe("incoming staged bytes");
    await expect(
      service.create({ repoRoot: source, name: "replacement", baseRef: "HEAD" }),
    ).rejects.toThrow(/cap 1/);
    expect(getRegistryWorktree(env, outer.id)?.removedAt).toBeUndefined();
    expect(
      (await service.listRegistryRecords())
        .filter((record) => record.removedAt === undefined)
        .map((record) => record.id),
    ).toEqual([outer.id]);
    expect(await fs.readFile(path.join(outer.path, "README.md"), "utf8")).toBe("base\n");
    expect(await fs.readFile(path.join(directory, "index"))).toEqual(index);
    expect(await requireGit(source, ["rev-parse", "--verify", "HEAD"])).toBe(head);
    expect(await requireGit(source, ["show", ":staged-source.txt"])).toBe("incoming staged bytes");
  },
);
