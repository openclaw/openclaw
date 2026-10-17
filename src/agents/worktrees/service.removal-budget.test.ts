import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { requireGit } from "./git.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { isWorktreeRepositoryCorruptionError } from "./removal-errors.js";
import { resolveRepository } from "./repository-paths.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
const initializeRepository = useManagedWorktreeTestRepository();
const hour = 60 * 60_000;
const read = (directory: string, name = "README.md") =>
  fs.readFile(path.join(directory, name), "utf8");
const makeService = (env: NodeJS.ProcessEnv, now = IDLE_GC_MS + 2) =>
  new ManagedWorktreeService({ env, now: () => now, getConfig: () => ({}) });
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
  await requireGit(source, ["add", "missing.txt"]);
  await requireGit(source, ["commit", "-m", "add omitted blob"]);
  await requireGit(source, ["config", "uploadpack.allowFilter", "true"]);
  const repo = path.join(root, "partial");
  await requireGit(root, [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    pathToFileURL(source).href,
    repo,
  ]);
  await requireGit(repo, ["sparse-checkout", "set", "--no-cone", "/README.md"]);
  return repo;
}

async function editRecords(records: readonly ManagedWorktreeRecord[]) {
  for (const record of records) {
    await fs.writeFile(path.join(record.path, "README.md"), "retained changes\n");
    // Materialized bytes do not repair the missing object in the shared store.
    await fs.writeFile(path.join(record.path, "missing.txt"), "omitted blob\n");
  }
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
  await requireGit(repo, ["checkout", "main"]);
  const records = await materialize(["broken-a", "broken-b"], {
    repoFingerprint: (await resolveRepository(repo)).fingerprint,
  });
  await requireGit(repo, ["remote", "set-url", "origin", path.join(root, "unavailable")]);
  await editRecords(records);
  let now = IDLE_GC_MS + 2;
  const gc = (retryDeferred = false) => makeService(env, now).gc({ retryDeferred });
  const first = await gc();
  await closeOpenClawStateDatabaseAsync();
  now += hour;
  const second = await gc();
  expect(first).toMatchObject({ failedCount: 1, deferredCount: 1 });
  const reasons = first.issues.map((issue) => issue.reason).join("\n");
  expect(reasons).toContain("has missing or corrupt Git objects");
  expect(reasons).toMatch(/repair/i);
  const failed = records.find((record) => retryState(env, record.id))!;
  expect(retryState(env, failed.id)).toMatchObject({
    stage: "repository-corrupt",
    attempts: 1,
    retryAt: now + hour,
  });
  expect(second.deferredCount).toBe(2);

  now += hour;
  expect((await gc()).failedCount).toBe(1);
  expect(retryState(env, failed.id)).toMatchObject({ attempts: 2, retryAt: now + 4 * hour });
  const [healthy] = await materialize(["healthy"], { repoRoot: source });
  expect((await gc()).removed).toEqual([healthy!.id]);
  await requireGit(repo, ["remote", "set-url", "origin", source]);
  expect((await gc(true)).removed.toSorted()).toEqual(
    records.map((record) => record.id).toSorted(),
  );
  for (const record of records) {
    const restored = await makeService(env, now).restore({ id: record.id });
    expect(await read(restored.path)).toBe("retained changes\n");
  }
});

it.each(["promised", "promised-retry", "unpromised", "checksum", "byte-limited"] as const)(
  "consolidates healthy pack batches independently of missing snapshot objects (%s)",
  async (damage) => {
    const { root, source, repo, env, materialize } = await fixture("partial");
    // Fixture materialization is an explicit checkout, not a Gateway inspection.
    await requireGit(repo, ["config", "gc.auto", "0"]);
    await requireGit(repo, ["config", "maintenance.auto", "false"]);
    const records = await materialize(["partial-a", "partial-b"], { stateDir: root });
    await editRecords(records);
    if (damage === "promised-retry") {
      // Persist the snapshot failure before explicitly retrying with an offline remote.
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
    await requireGit(repo, ["prune-packed"]);
    if (damage === "checksum") {
      const pack = payloadPacks[0]!;
      const bytes = await fs.readFile(pack);
      bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
      await fs.chmod(pack, 0o600);
      await fs.writeFile(pack, bytes);
    } else if (damage === "unpromised") {
      // A local commit is not a promise, even with a promisor remote configured.
      const record = records[0]!;
      await requireGit(record.path, ["config", "user.name", "OpenClaw Test"]);
      await requireGit(record.path, ["config", "user.email", "openclaw-test@example.invalid"]);
      await fs.writeFile(path.join(record.path, "README.md"), "local-only blob\n");
      await requireGit(record.path, ["add", "README.md"]);
      await requireGit(record.path, ["commit", "-m", "local change"]);
      const blob = await requireGit(record.path, ["rev-parse", "HEAD:README.md"]);
      await fs.unlink(path.join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
      await requireGit(source, ["hash-object", "-w", "--stdin"], { input: "local-only blob\n" });
      await requireGit(source, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    }
    const before = (await fs.readdir(directory)).filter((name) => name.endsWith(".pack"));
    if (damage === "byte-limited") {
      // Exercise the 512-MiB budget with native tiny packs, without writing 640 MiB in a test.
      const realStat = fs.stat.bind(fs);
      vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        const stat = await realStat(...args);
        const file = String(args[0]);
        if (stat && path.dirname(file) === directory && file.endsWith(".pack")) {
          stat.size = 40 * 1024 * 1024;
        }
        return stat;
      });
    }
    const expectedPacks = damage === "byte-limited" ? before.length - 11 : 1;
    const missing = await requireGit(repo, ["rev-list", "--objects", "--all", "--missing=print"]);
    expect(missing).toContain("?");
    await requireGit(repo, ["remote", "set-url", "origin", path.join(root, "unavailable.git")]);
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
      expect(await requireGit(repo, ["rev-list", "--objects", "--all", "--missing=print"])).toBe(
        missing,
      );
      expect(
        await requireGit(repo, ["cat-file", "--batch-check"], {
          input: `${objects.join("\n")}\n`,
        }),
      ).not.toContain("missing");
      await requireGit(repo, ["multi-pack-index", "verify"]);
    }
    const traceOutput = await fs.readFile(trace, "utf8");
    expect(traceOutput).not.toContain('"fsck"');
    if (damage !== "promised-retry") {
      expect(traceOutput).not.toContain("upload-pack");
    }
    if (damage === "unpromised") {
      await requireGit(repo, ["remote", "set-url", "origin", source]);
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
  let now = IDLE_GC_MS + 2;
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
  const gc = () => makeService(env, now).gc();
  expect((await gc()).outcome).toBe("partial");
  const first = retryState(env, record.id);
  expect(first).toEqual({
    stage: "snapshot",
    elapsedMs: expect.any(Number),
    attempts: 1,
    retryAt: now + 2 * hour,
  });
  expect(await read(record.path)).toBe("retained changes\n");

  await closeOpenClawStateDatabaseAsync();
  now += hour;
  expect((await gc()).outcome).toBe("deferred");
  expect(attempts).toBe(1);
  expect(retryState(env, record.id)).toEqual(first);

  now += hour;
  expect((await gc()).outcome).toBe("partial");
  expect(attempts).toBe(2);
  expect(retryState(env, record.id)).toMatchObject({ attempts: 2, retryAt: now + 4 * hour });
  fail = false;
  const retried = await makeService(env, now).gc({ retryDeferred: true });
  expect(retried.removed).toEqual([record.id]);
  expect(attempts).toBe(3);
  expect(retryState(env, record.id)).toBeUndefined();
  const restored = await makeService(env, now).restore({ id: record.id });
  expect(await read(restored.path)).toBe("retained changes\n");
});
