import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { cleanScratch, closeScratchCleanupCursor } from "../../infra/scratch-cleanup.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import { createWorktreeGitMaintenance } from "./git-maintenance.js";
import { requireGit, requireGitBuffer } from "./git.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "./registry.js";
import { makeWorktreeRecord, useManagedWorktreeTestRepository } from "./service.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
let env: NodeJS.ProcessEnv;
const initRepo = useManagedWorktreeTestRepository();
const git = (repo: string, ...args: string[]) =>
  requireGit(repo, args, {
    env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
    executionIntent: "agent-tool",
  });
beforeEach(() => {
  env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-pack-state-") };
  setRuntimeConfigSnapshot({});
});
afterEach(() => clearRuntimeConfigSnapshot());

it.each([false, true])(
  "folds delta-heavy packs without inflation (promisor=%s)",
  async (promisor) => {
    const root = tempDirs.make("worktree-delta-packs-");
    const repo = await initRepo(root);
    await insertRegistryWorktree(env, makeWorktreeRecord(repo, "delta-packs"));
    await git(repo, "repack", "-ad");
    const directory = path.join(repo, ".git/objects/pack");
    const kept = (await fs.readdir(directory)).find((name) => name.endsWith(".pack"))!;
    await fs.writeFile(path.join(directory, kept.replace(/\.pack$/, ".keep")), "");
    await fs.link(path.join(directory, kept), path.join(root, "shared.pack"));
    const keptStat = await fs.stat(path.join(directory, kept));
    const selected = [];
    for (let pack = 0; pack < 2; pack++) {
      const nonce = Buffer.alloc(16, pack);
      const payload = createCipheriv("aes-256-ctr", Buffer.alloc(32), nonce).update(
        Buffer.alloc(1024),
      );
      const commands = [];
      for (let revision = 0; revision < 1024; revision++) {
        const bytes = Buffer.from(payload);
        bytes.writeUInt32LE(revision);
        commands.push(Buffer.from("blob\ndata 1024\n"), bytes, Buffer.from("\n"));
      }
      const before = new Set(await fs.readdir(directory));
      // Git's bulk importer stores these unreachable revisions with compact offset deltas.
      await requireGit(repo, ["-c", "fastimport.unpackLimit=0", "fast-import", "--quiet"], {
        input: Buffer.concat(commands),
      });
      const name = (await fs.readdir(directory)).find(
        (file) => !before.has(file) && file.endsWith(".pack"),
      )!;
      if (promisor) {
        await fs.writeFile(path.join(directory, name.replace(/\.pack$/, ".promisor")), "");
      }
      selected.push({ name, size: (await fs.stat(path.join(directory, name))).size });
    }
    const objectsBefore = await git(repo, "cat-file", "--batch-all-objects", "--batch-check");
    const progress = new WorktreeGcProgress();
    await createWorktreeGitMaintenance(env)({ progress });
    expect(progress.result.issues).toEqual([]);
    const remaining = await fs.readdir(directory);
    const outputs = remaining.filter((name) => name.endsWith(".pack") && name !== kept);
    expect(outputs).toHaveLength(1);
    expect(selected.every(({ name }) => !remaining.includes(name))).toBe(true);
    const written = (await fs.stat(path.join(directory, outputs[0]!))).size;
    const retired = selected.reduce((sum, pack) => sum + pack.size, 0);
    expect(written / retired).toBeLessThanOrEqual(1.01);
    expect(remaining.filter((name) => name.endsWith(".promisor"))).toHaveLength(promisor ? 1 : 0);
    const { ino, nlink, size } = await fs.stat(path.join(directory, kept));
    expect({ ino, nlink, size }).toEqual({
      ino: keptStat.ino,
      nlink: keptStat.nlink,
      size: keptStat.size,
    });
    expect(await git(repo, "cat-file", "--batch-all-objects", "--batch-check")).toBe(objectsBefore);
    await git(repo, "fsck", "--full", "--no-dangling");
  },
);

it("preserves shared packs across local clones and stops rewriting private packs", async () => {
  const root = tempDirs.make("worktree-hardlinked-packs-");
  const source = await initRepo(root);
  const payload = createCipheriv("aes-256-ctr", Buffer.alloc(32), Buffer.alloc(16)).update(
    Buffer.alloc(128 * 1024),
  );
  const addPack = async (repo: string, sequence: number) => {
    payload.writeUInt32LE(sequence);
    const oid = await requireGit(repo, ["hash-object", "-w", "--stdin"], { input: payload });
    await requireGit(repo, ["pack-objects", path.join(repo, ".git/objects/pack/pack")], {
      input: `${oid}\n`,
    });
    await git(repo, "prune-packed");
    return oid;
  };
  const inventory = async (repo: string) => {
    const directory = path.join(repo, ".git/objects/pack");
    return Promise.all(
      (await fs.readdir(directory))
        .filter((name) => name.endsWith(".pack"))
        .toSorted()
        .map(async (name) => {
          const { ino, size, nlink } = await fs.stat(path.join(directory, name));
          return { name, ino, size, nlink };
        }),
    );
  };
  const objects = [];
  for (let i = 0; i < 4; i++) {
    objects.push(await addPack(source, i));
  }
  const clones = [];
  for (let i = 0; i < 3; i++) {
    const clone = path.join(root, `clone-${i}`);
    await requireGit(root, ["clone", "--local", "--no-checkout", source, clone]);
    await insertRegistryWorktree(env, makeWorktreeRecord(clone, `hardlinks-${i}`));
    clones.push(clone);
  }
  const shared = await inventory(source);
  expect(shared.every((pack) => pack.nlink === 4)).toBe(true);
  const rows = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    if (cycle === 2) {
      // Equal private peers fold once; the shared history must not affect selection.
      objects.push(await addPack(clones[0]!, 4), await addPack(clones[0]!, 5));
    }
    const before = await inventory(clones[0]!);
    const progress = new WorktreeGcProgress();
    await createWorktreeGitMaintenance(env)({ progress });
    expect(progress.result.issues).toEqual([]);
    const after = await inventory(clones[0]!);
    rows.push(after.filter((pack) => !before.some((old) => old.name === pack.name)).length);
    for (const repo of [source, ...clones]) {
      const packs = await inventory(repo);
      expect(packs.filter((pack) => pack.nlink > 1)).toEqual(shared);
    }
  }
  expect(rows).toEqual([0, 0, 1, 0, 0, 0]);
  expect(
    await requireGit(clones[0]!, ["cat-file", "--batch-check=%(objecttype)"], {
      input: `${objects.join("\n")}\n`,
    }),
  ).toBe(objects.map(() => "blob").join("\n"));

  // Expiry releases the other inode names; the unchanged consolidation owner can
  // then fold the formerly shared base packs without duplicating pinned storage.
  const scratch = path.join(root, ".openclaw/tmp");
  await fs.mkdir(scratch, { recursive: true });
  for (const [index, clone] of clones.entries()) {
    await fs.rename(clone, path.join(scratch, `landing-${index}`));
    await updateRegistryWorktree(env, `hardlinks-${index}`, { removedAt: Date.now() });
  }
  const cursor = {};
  try {
    const expired = await cleanScratch({
      targets: [{ root, kind: "checkout", isLive: () => false }],
      now: Date.now() + 25 * 60 * 60_000,
      cursor,
      assertCurrent() {},
      pause: async () => {},
    });
    expect(expired).toMatchObject({ entriesRemoved: 3, errors: [] });
  } finally {
    await closeScratchCleanupCursor(cursor);
  }
  expect((await inventory(source)).every((pack) => pack.nlink === 1)).toBe(true);
  await insertRegistryWorktree(env, makeWorktreeRecord(source, "released-base"));
  await createWorktreeGitMaintenance(env)({ progress: new WorktreeGcProgress() });
  expect(await inventory(source)).toHaveLength(1);
});

it.each([false, true])(
  "converges overlapping history packs and bounds hourly writes (promisor=%s)",
  async (promisor) => {
    const repo = await initRepo(tempDirs.make("worktree-geometric-packs-"));
    await insertRegistryWorktree(env, makeWorktreeRecord(repo, `geometry-${promisor}`));
    const directory = path.join(repo, ".git", "objects", "pack");
    const payload = createCipheriv("aes-256-ctr", Buffer.alloc(32), Buffer.alloc(16)).update(
      Buffer.alloc(32 * 4096),
    );
    const objects: string[] = [];
    const blob = async (contents: Buffer) => {
      const oid = await requireGit(repo, ["hash-object", "-w", "--stdin"], { input: contents });
      objects.push(oid);
      return oid;
    };
    const pack = async (oids: string[]) => {
      const hash = await requireGit(
        repo,
        ["pack-objects", "--window=0", path.join(directory, "pack")],
        { input: `${oids.join("\n")}\n` },
      );
      if (promisor) {
        await fs.writeFile(path.join(directory, `pack-${hash}.promisor`), "");
      }
    };
    const stat = fs.stat;
    const inventory = async () =>
      Promise.all(
        (await fs.readdir(directory))
          .filter((name) => name.endsWith(".pack"))
          .map(async (name) => [name, (await stat(path.join(directory, name))).size] as const),
      );
    const base = [];
    for (let i = 0; i < 32; i++) {
      base.push(await blob(payload.subarray(i * 4096, (i + 1) * 4096)));
    }
    await pack(base);
    for (let i = 0; i < 6; i++) {
      await pack([...base, await blob(Buffer.from(`history-${i}`))]);
    }
    // Scale only admission bytes to exercise the 16 GiB limit with tiny real Git packs.
    using sizes = vi.spyOn(fs, "stat");
    sizes.mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (result && String(args[0]).startsWith(directory) && String(args[0]).endsWith(".pack")) {
        result.size = Number(result.size) * 32768;
      }
      return result;
    });
    // The retirement deadline has independent coverage in service.gc-performance.test.ts.
    using clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(0);
    const rows = [];
    for (let cycle = 0; cycle < 9; cycle++) {
      const revisions = [];
      for (let i = 0; i < 8; i++) {
        const contents = Buffer.from(payload.subarray(0, 4096));
        contents.writeUInt32LE(cycle * 8 + i);
        revisions.push(await blob(contents));
      }
      for (let i = 0; i < 8; i++) {
        await pack([...revisions, await blob(Buffer.from(`cycle-${cycle}-${i}`))]);
      }
      await git(repo, "prune-packed");
      const before = new Set((await inventory()).map(([name]) => name));
      const progress = new WorktreeGcProgress();
      // Recreating the owner also exercises restart re-arming without persistent scheduling.
      await createWorktreeGitMaintenance(env)({ progress });
      expect(progress.result.gitMaintenance?.stage).toBe("completed");
      const after = await inventory();
      rows.push({
        cycle,
        rewritten: after
          .filter(([name]) => !before.has(name))
          .reduce((sum, [, bytes]) => sum + bytes, 0),
        packs: after.length,
        bytes: after.reduce((sum, [, bytes]) => sum + bytes, 0),
      });
    }
    console.table(rows);
    const converged = rows.slice(-3);
    expect(converged.every((row) => row.rewritten < payload.length / 3)).toBe(true);
    expect(converged.every((row) => row.packs <= 4)).toBe(true);
    expect(converged.every((row) => row.bytes < payload.length * 2)).toBe(true);
    expect((await fs.readdir(directory)).filter((name) => name.endsWith(".promisor"))).toHaveLength(
      promisor ? rows.at(-1)!.packs : 0,
    );
    expect(
      await requireGit(repo, ["cat-file", "--batch-check=%(objecttype)"], {
        input: `${objects.join("\n")}\n`,
      }),
    ).toBe(objects.map(() => "blob").join("\n"));
  },
);

it("compacts committed loose packs while retaining unpublished temporary packs", async () => {
  const repo = await initRepo(tempDirs.make("worktree-loose-packs-"));
  await insertRegistryWorktree(env, makeWorktreeRecord(repo, "loose-pack-family"));
  await git(repo, "repack", "-a", "-d");
  const directory = path.join(repo, ".git", "objects", "pack");
  const canonical = (await fs.readdir(directory)).find((name) => name.endsWith(".pack"));
  expect(canonical).toMatch(/^pack-[a-f0-9]+\.pack$/);
  const hash = canonical!.slice("pack-".length, -".pack".length);
  const loose = "loose-" + hash;
  const temporary = ".tmp-123-pack-" + hash;
  for (const extension of ["pack", "idx"]) {
    const source = path.join(directory, "pack-" + hash + "." + extension);
    await fs.copyFile(source, path.join(directory, loose + "." + extension));
    await fs.copyFile(source, path.join(directory, temporary + "." + extension));
  }
  const progress = new WorktreeGcProgress();
  await createWorktreeGitMaintenance(env)({ progress });
  expect(progress.result.gitMaintenance).toMatchObject({
    packsBefore: 3,
    packsAfter: 2,
    stage: "completed",
  });
  for (const extension of ["pack", "idx"]) {
    await expect(fs.access(path.join(directory, `${loose}.${extension}`))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    await fs.access(path.join(directory, `${temporary}.${extension}`));
  }
  await git(repo, "fsck", "--no-reflogs");
});

it("drains a 600-pack burst during hourly throttling only when eligible packs are backlogged", async () => {
  const repo = await initRepo(tempDirs.make("worktree-pack-burst-"));
  await insertRegistryWorktree(env, makeWorktreeRecord(repo, "burst"));
  await git(repo, "config", "remote.origin.promisor", "true");
  await git(repo, "remote", "set-url", "origin", path.join(repo, "unavailable.git"));
  const maintain = createWorktreeGitMaintenance(env);
  await maintain({});
  const directory = path.join(repo, ".git", "objects", "pack");
  const objects: Array<{ oid: string; contents: Buffer; stem: string }> = [];
  const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest();
  for (let i = 0; i < 600; i++) {
    const contents = Buffer.from(`blob-${String(i).padStart(3, "0")}`);
    const oid = sha1(Buffer.concat([Buffer.from("blob 8\0"), contents]));
    // A single-blob Git pack; Git itself builds and validates the indexes below.
    const entry = Buffer.concat([Buffer.from([0x38]), deflateSync(contents)]);
    const pack = Buffer.concat([Buffer.from("5041434b0000000200000001", "hex"), entry]);
    const hash = sha1(pack);
    const stem = path.join(directory, `pack-${hash.toString("hex")}`);
    await Promise.all([
      fs.writeFile(`${stem}.pack`, Buffer.concat([pack, hash])),
      fs.writeFile(`${stem}.promisor`, ""),
    ]);
    objects.push({ oid: oid.toString("hex"), contents, stem });
  }
  await git(
    repo,
    "-c",
    'alias.openclaw-test-index-burst=!for pack in .git/objects/pack/pack-*.pack; do git index-pack "$pack" || exit; done',
    "openclaw-test-index-burst",
  );
  const packNames = async () =>
    (await fs.readdir(directory)).filter((name) => name.endsWith(".pack")).toSorted();
  const burst = await packNames();
  expect(burst).toHaveLength(600);
  const throttled = new WorktreeGcProgress();
  await maintain({ progress: throttled });
  expect(throttled.result.gitMaintenance?.stage).toBe("throttled");
  for (const object of objects.slice(0, 90)) {
    await fs.writeFile(`${object.stem}.keep`, "");
  }
  await maintain({ checkBacklog: true });
  expect(await packNames()).toEqual(burst);
  for (const object of objects.slice(1, 90)) {
    await fs.unlink(`${object.stem}.keep`);
  }
  const progress = new WorktreeGcProgress();
  await maintain({ checkBacklog: true, progress });
  expect(progress.result.issues).toEqual([]);
  expect(progress.result.gitMaintenance?.packsBefore).toBe(600);
  expect(progress.result.gitMaintenance?.packsAfter).toBeLessThan(600);
  await fs.access(`${objects[0]!.stem}.pack`);
  expect(
    await requireGitBuffer(repo, ["cat-file", "--batch"], {
      input: `${objects.map(({ oid }) => oid).join("\n")}\n`,
      env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
    }),
  ).toEqual(
    Buffer.concat(
      objects.flatMap(({ oid, contents }) => [
        Buffer.from(`${oid} blob 8\n`),
        contents,
        Buffer.from("\n"),
      ]),
    ),
  );
});
