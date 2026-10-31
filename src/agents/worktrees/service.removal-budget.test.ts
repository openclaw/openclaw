import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  expectPrivateMetadata,
  gitCommonDirectory,
  gitDirectory,
  linkDirectory,
  relocatePrivateGitDirectory,
  write,
} from "./eviction.test-support.js";
import { requireGit } from "./git.js";
import { deferWorktreeCleanup } from "./registry-retirement.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { isWorktreeRepositoryCorruptionError } from "./removal-errors.js";
import { resolveRepository } from "./repository-paths.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import { hasLiveWorktreeRunLease, testing as runLeaseTesting } from "./run-lease.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    runLeaseTesting.resetForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
const initializeRepository = useManagedWorktreeTestRepository();
const hour = 60 * 60_000;
const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
const read = (directory: string, name = "README.md") =>
  fs.readFile(path.join(directory, name), "utf8");
const makeService = (env: NodeJS.ProcessEnv) =>
  new ManagedWorktreeService({ env, getConfig: () => ({}) });
const retryState = (env: NodeJS.ProcessEnv, id: string) => getRegistryWorktree(env, id)?.gcRetry;
const timedOut = <T extends string | Buffer>(output: T, timeoutMs: number) => ({
  stdout: output,
  stderr: output,
  code: null,
  signal: "SIGTERM" as const,
  killed: true,
  termination: "timeout" as const,
  timeoutMs,
});
async function fixture(mode: "full" | "partial" = "full") {
  const root = tempDirs.make("worktree-removal-budget-");
  const source = await initializeRepository(root);
  const repo = mode === "partial" ? await partialRepository(root, source) : source;
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const materialize = (
    names: string[],
    options: Partial<Parameters<typeof materializeManagedWorktreeFixtures>[0]> = {},
  ) =>
    materializeManagedWorktreeFixtures({
      env,
      repoRoot: repo,
      stateDir: env.OPENCLAW_STATE_DIR,
      now: 1,
      ownerKind: "session",
      names,
      ...options,
    });
  return { root, source, repo, env, materialize };
}

async function partialRepository(root: string, source: string) {
  await fs.writeFile(path.join(source, "missing.txt"), "omitted blob\n");
  await git(source, "add", "missing.txt");
  await git(source, "commit", "-m", "add omitted blob");
  await git(source, "config", "uploadpack.allowFilter", "true");
  const repo = path.join(root, "partial");
  await git(root, "clone", "--filter=blob:none", "--no-checkout", pathToFileURL(source).href, repo);
  await git(repo, "sparse-checkout", "set", "--no-cone", "/README.md");
  return repo;
}

async function editRecords(records: readonly ManagedWorktreeRecord[]) {
  for (const record of records) {
    await fs.writeFile(path.join(record.path, "README.md"), "retained changes\n");
    // Materialized bytes do not repair the missing object in the shared store.
    await fs.writeFile(path.join(record.path, "missing.txt"), "omitted blob\n");
  }
}

async function setRetryAt(env: NodeJS.ProcessEnv, id: string, retryAt: number) {
  const observed = getRegistryWorktree(env, id)!;
  const retry = { ...observed.gcRetry!, retryAt };
  expect(await deferWorktreeCleanup(env, { observed, reason: observed.gcProtection!, retry })).toBe(
    true,
  );
  return retry;
}

it.each([
  ["error: invalid object 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa for 'file'", true],
  ["fatal: loose object aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is corrupt", true],
  ["error: object file .git/objects/aa/aaaaaaaa is empty", true],
  ["fatal: unable to read tree aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true],
  ["fatal: not a tree object", true],
  ["fatal: unable to read aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true],
  ["fatal: could not fetch aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa from promisor remote", true],
  ["fatal: Unable to create 'index.lock': File exists", false],
  ["fatal: unable to access 'remote': Could not resolve host", false],
  ["git-write-tree: error building trees", false],
])(
  "classifies object-storage evidence without deferring unrelated Git failures: %s",
  (message, corrupt) => {
    const error = new Error("snapshot failed", { cause: new Error(message) });
    expect(isWorktreeRepositoryCorruptionError(error)).toBe(corrupt);
  },
);

it("backs off shared-repository snapshots after a missing-object failure", async () => {
  const { root, source, repo, env, materialize } = await fixture("partial");
  await git(repo, "checkout", "main");
  const records = await materialize(["broken-a", "broken-b"], {
    repoFingerprint: (await resolveRepository(repo)).fingerprint,
  });
  await git(repo, "remote", "set-url", "origin", path.join(root, "unavailable"));
  await editRecords(records);
  const gc = (retryDeferred = false) => makeService(env).gc({ retryDeferred });
  const firstStarted = Date.now();
  const first = await gc();
  const firstFinished = Date.now();
  await closeOpenClawStateDatabaseAsync();
  const failed = records.find((record) => retryState(env, record.id))!;
  const initialRetry = retryState(env, failed.id)!;
  expect(initialRetry.retryAt).toBeGreaterThanOrEqual(firstStarted + 2 * hour);
  expect(initialRetry.retryAt).toBeLessThanOrEqual(firstFinished + 2 * hour);
  const delayedRetry = await setRetryAt(env, failed.id, Date.now() + hour);
  const second = await gc();
  expect(first).toMatchObject({ failedCount: 1, deferredCount: 1 });
  const reasons = first.issues.map((issue) => issue.reason).join("\n");
  expect(reasons).toContain("has missing or corrupt Git objects");
  expect(reasons).toMatch(/repair/i);
  expect(retryState(env, failed.id)).toMatchObject({
    stage: "repository-corrupt",
    attempts: 1,
    retryAt: delayedRetry.retryAt,
  });
  expect(second.deferredCount).toBe(2);

  await setRetryAt(env, failed.id, Date.now() - 1);
  const secondStarted = Date.now();
  expect((await gc()).failedCount).toBe(1);
  expect(retryState(env, failed.id)).toMatchObject({ attempts: 2, retryAt: expect.any(Number) });
  expect(retryState(env, failed.id)?.retryAt).toBeGreaterThanOrEqual(secondStarted + 4 * hour);
  expect(retryState(env, failed.id)?.retryAt).toBeLessThanOrEqual(Date.now() + 4 * hour);
  const [healthy] = await materialize(["healthy"], { repoRoot: source });
  expect((await gc()).removed).toEqual([healthy!.id]);
  await git(repo, "remote", "set-url", "origin", source);
  expect((await gc(true)).removed.toSorted()).toEqual(
    records.map((record) => record.id).toSorted(),
  );
  for (const record of records) {
    const restored = await makeService(env).restore({ id: record.id });
    expect(await read(restored.path)).toBe("retained changes\n");
  }
});

it.each([
  ["promised", 1],
  ["promised-retry", 2],
  ["unpromised", 0],
  ["checksum", 1],
  ["byte-limited", 1],
  ["index-limited", 1],
] as const)(
  "consolidates healthy pack batches independently of missing snapshot objects (%s)",
  async (damage, expectedFetches) => {
    const { root, source, repo, env, materialize } = await fixture("partial");
    await git(repo, "config", "gc.auto", "0");
    await git(repo, "config", "maintenance.auto", "false");
    const records = await materialize(["partial-a", "partial-b"], { stateDir: root });
    await editRecords(records);
    if (damage === "promised-retry") {
      // Persist a failed hydration before explicitly retrying with an offline remote.
      await git(repo, "remote", "set-url", "origin", path.join(root, "unavailable.git"));
      await makeService(env).gc();
    }
    const directory = path.join(repo, ".git", "objects", "pack");
    const objects: string[] = [];
    const payloadPacks: string[] = [];
    for (let index = 0; index < 16; index++) {
      const object = await requireGit(repo, ["hash-object", "-w", "--stdin"], {
        input: `partial-payload-${index}`,
      });
      objects.push(object);
      const hash = await requireGit(repo, ["pack-objects", path.join(directory, "pack")], {
        input: `${object}\n`,
      });
      payloadPacks.push(path.join(directory, `pack-${hash}.pack`));
      await fs.writeFile(path.join(directory, `pack-${hash}.promisor`), "");
    }
    await git(repo, "prune-packed");
    if (damage === "checksum") {
      const pack = payloadPacks[0]!;
      const bytes = await fs.readFile(pack);
      bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
      await fs.chmod(pack, 0o600);
      await fs.writeFile(pack, bytes);
    } else if (damage === "unpromised") {
      // A local commit is not a promise, even with a promisor remote configured.
      const record = records[0]!;
      await git(record.path, "config", "user.name", "OpenClaw Test");
      await git(record.path, "config", "user.email", "openclaw-test@example.invalid");
      await fs.writeFile(path.join(record.path, "README.md"), "local-only blob\n");
      await git(record.path, "add", "README.md");
      await git(record.path, "commit", "-m", "local change");
      const blob = await git(record.path, "rev-parse", "HEAD:README.md");
      await fs.unlink(path.join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
      await requireGit(source, ["hash-object", "-w", "--stdin"], { input: "local-only blob\n" });
      await git(source, "config", "uploadpack.allowAnySHA1InWant", "true");
    }
    const before = (await fs.readdir(directory)).filter((name) => name.endsWith(".pack"));
    if (damage === "byte-limited" || damage === "index-limited") {
      // Exercise byte/object-metadata budgets using tiny native packs.
      const realStat = fs.stat.bind(fs);
      vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        const stat = await realStat(...args);
        const file = String(args[0]);
        if (stat && path.dirname(file) === directory) {
          if (damage === "byte-limited" && file.endsWith(".pack")) {
            stat.size = 40 * 1024 * 1024;
          } else if (damage === "index-limited" && file.endsWith(".idx")) {
            stat.size = 8 * 1024 * 1024;
          }
        }
        return stat;
      });
    }
    const expectedPacks =
      damage === "byte-limited"
        ? before.length - 11
        : damage === "index-limited"
          ? before.length - 3
          : 1;
    const missing = await git(repo, "rev-list", "--objects", "--all", "--missing=print");
    expect(missing).toContain("?");
    await git(repo, "remote", "set-url", "origin", path.join(root, "unavailable.git"));
    const trace = path.join(root, "partial-trace.jsonl");
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    const service = makeService(env);
    const result = await service.gc({ retryDeferred: damage === "promised-retry" });
    const suspended = damage === "checksum" || damage === "promised-retry";
    const after = (await fs.readdir(directory)).filter((name) => name.endsWith(".pack"));
    expect(after.length).toBe(damage === "checksum" ? before.length : expectedPacks);
    expect(result).toMatchObject({
      removed: [],
      failedCount: suspended ? 2 : 1,
      deferredCount: 1,
      gitMaintenance: {
        repoRoot: repo,
        stage: suspended ? "suspended" : "completed",
        packsBefore: before.length,
        ...(damage === "checksum" ? {} : { packsAfter: expectedPacks }),
      },
    });
    for (const record of records) {
      expect(await read(record.path, "missing.txt")).toBe("omitted blob\n");
      expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
    }
    if (damage !== "checksum") {
      expect(await git(repo, "rev-list", "--objects", "--all", "--missing=print")).toBe(missing);
      expect(
        await requireGit(repo, ["cat-file", "--batch-check"], {
          input: `${objects.join("\n")}\n`,
        }),
      ).not.toContain("missing");
      await git(repo, "multi-pack-index", "verify");
    }
    const traceOutput = await fs.readFile(trace, "utf8");
    expect(traceOutput).not.toContain('"fsck"');
    const fetches = traceOutput.match(/"name":"fetch"/g)?.length ?? 0;
    // Git may detect checksum damage before hydration or after its single batch.
    expect(damage === "checksum" ? [0, 1] : [expectedFetches]).toContain(fetches);
    if (damage === "unpromised") {
      await git(repo, "remote", "set-url", "origin", source);
      const repaired = await service.gc({ retryDeferred: true });
      expect(repaired.removed.toSorted()).toEqual(records.map((record) => record.id).toSorted());
      expect(await fs.readFile(trace, "utf8")).toContain("upload-pack");
    }
  },
);

it("records an admitted deletion timeout after its caller cancels and loses session authority", async () => {
  const { env, materialize } = await fixture();
  const record = (await materialize(["cancelled"], { ownerKind: "manual" }))[0]!;
  const controller = new AbortController();
  let current = true;
  const execute = gitExec.executeGitCommand;
  vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
    if (args[0] === "worktree" && args[1] === "remove") {
      options?.beforeRun?.();
      current = false;
      controller.abort(new Error("caller cancelled"));
      return timedOut("", 300_000);
    }
    return await execute(cwd, args, options);
  });
  await expect(
    new ManagedWorktreeService({ env, getConfig: () => ({}) }).remove({
      id: record.id,
      reason: "idle-gc",
      signal: controller.signal,
      commitGuard: () => {
        if (!current) {
          throw new Error("session retired");
        }
      },
    }),
  ).rejects.toThrow();
  expect(retryState(env, record.id)).toMatchObject({ stage: "checkoutRemoval", attempts: 1 });
  expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
});

it("persists timeout backoff across restart and retries only when due or explicitly requested", async () => {
  const { env, materialize } = await fixture();
  const record = (await materialize(["timed-out"]))[0]!;
  await fs.writeFile(path.join(record.path, "README.md"), "retained changes\n");
  let attempts = 0;
  let fail = true;
  const execute = gitExec.executeGitCommandBytes;
  vi.spyOn(gitExec, "executeGitCommandBytes").mockImplementation(async (cwd, args, options) => {
    if (args.includes("write-tree")) {
      attempts++;
      if (fail) {
        return { ...timedOut(Buffer.alloc(0), 120_000), windowsEncoding: null };
      }
    }
    return await execute(cwd, args, options);
  });
  const gc = () => makeService(env).gc();
  const attemptStarted = Date.now();
  expect((await gc()).outcome).toBe("partial");
  const first = retryState(env, record.id);
  expect(first).toEqual({
    stage: "snapshot",
    elapsedMs: expect.any(Number),
    attempts: 1,
    retryAt: expect.any(Number),
  });
  expect(await read(record.path)).toBe("retained changes\n");

  expect(first?.retryAt).toBeGreaterThanOrEqual(attemptStarted + 2 * hour);
  expect(first?.retryAt).toBeLessThanOrEqual(Date.now() + 2 * hour);
  const delayed = await setRetryAt(env, record.id, Date.now() + hour);
  await closeOpenClawStateDatabaseAsync();
  expect((await gc()).outcome).toBe("deferred");
  expect(attempts).toBe(1);
  expect(retryState(env, record.id)).toEqual(delayed);

  await setRetryAt(env, record.id, Date.now() - 1);
  const secondStarted = Date.now();
  expect((await gc()).outcome).toBe("partial");
  expect(attempts).toBe(2);
  expect(retryState(env, record.id)).toMatchObject({ attempts: 2, retryAt: expect.any(Number) });
  expect(retryState(env, record.id)?.retryAt).toBeGreaterThanOrEqual(secondStarted + 4 * hour);
  expect(retryState(env, record.id)?.retryAt).toBeLessThanOrEqual(Date.now() + 4 * hour);
  fail = false;
  const retried = await makeService(env).gc({ retryDeferred: true });
  expect(retried.removed).toEqual([record.id]);
  expect(attempts).toBe(3);
  expect(retryState(env, record.id)).toBeUndefined();
  const restored = await makeService(env).restore({ id: record.id });
  expect(await read(restored.path)).toBe("retained changes\n");
});

describe("nested eviction", () => {
  let root: string;
  let repoRoot: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  let config: { worktreeMaxCount: number; worktreeAcceleration: boolean };
  beforeEach(async () => {
    ({ root, repo: repoRoot, env } = await fixture());
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
    vi.spyOn(gitExec, "executeGitCommandBuffered").mockImplementation(
      async (cwd, args, options) => {
        if (
          cwd === checkoutPath &&
          args.includes("ls-files") &&
          args.includes("--stage") &&
          options?.operation === "worktree.snapshot"
        ) {
          await effect();
        }
        return execute(cwd, args, options);
      },
    );
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
          expect(privateMetadata.commonDirectory.startsWith(`${outer.path}${path.sep}`)).toBe(
            false,
          );
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
      expect(await requireGit(source, ["show", ":staged-source.txt"])).toBe(
        "incoming staged bytes",
      );
    },
  );
});

it("cleans up active owners without ref mutations when there are no packs", async () => {
  const { repo, env, materialize } = await fixture();
  const records = await materialize(["first", "second", "third", "fourth", "fifth"], {
    ownerId: "active-owner",
  });
  const refs = await requireGit(repo, ["show-ref"]);
  const mutations = vi.spyOn(gitExec, "enqueueGitRefMutation");

  const result = await new ManagedWorktreeService({ env, getConfig: () => ({}) }).gc({
    readOwnerState: () => "active",
  });

  expect(result).toMatchObject({
    removed: [],
    orphansDeleted: 0,
    orphansRetired: 0,
    snapshotsPruned: 0,
    eligibleCount: 0,
    protectedCount: records.length,
    protectionReasons: { "owner is active": records.length },
    gitMaintenance: { stage: "completed", packsBefore: 0, packsAfter: 0 },
  });
  expect(mutations).not.toHaveBeenCalled();
  expect(await requireGit(repo, ["show-ref"])).toBe(refs);
});
