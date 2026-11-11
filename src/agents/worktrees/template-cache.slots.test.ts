import fs from "node:fs/promises";
import path from "node:path";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as allocation from "./allocation.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import { collectWorktreeTemplates, prepareWorktreeTemplate } from "./template-cache.js";
import { listTemplatesAsync } from "./template-registry-async.js";

const directories = useWorktreeStateRoots();
const guard = { commitGuard: () => {} };
let env: NodeJS.ProcessEnv;
let root: string;
let now: number;
let installs: string[];
let backend: string;

beforeEach(() => {
  root = directories.make("sandbox-template-slots-");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  env = { ...process.env };
  now = Date.now();
  installs = [];
  backend = "sandbox-test";
});

async function prepare(
  commit: string,
  identity = "runtime-one",
  waitBudget?: { remainingMs: number },
  background?: boolean,
) {
  const build = async (record: { path: string }) => {
    installs.push(commit);
    await fs.mkdir(record.path, { recursive: true });
    await fs.writeFile(path.join(record.path, "dependency"), commit);
  };
  const prepared = await prepareWorktreeTemplate({
    env,
    now: () => now++,
    options: { ...guard, waitBudget },
    cacheKey: identity,
    contentKey: commit,
    repoRoot: path.join(root, "repo"),
    commonDir: path.join(root, "repo", ".git"),
    worktreeRoot: path.join(root, "templates"),
    sourceCommit: commit,
    backend,
    background,
    requireSpace: async () => {},
    validate: async (record) =>
      (await fs.readFile(path.join(record.path, "dependency"), "utf8")) === record.sourceCommit,
    prepare: build,
    refresh: async (_existing, staged) => {
      await build(staged);
      return true;
    },
  });
  assert(prepared, "Each source commit must retain its own reusable generation");
  return prepared;
}
const collect = () => collectWorktreeTemplates(env, 0, guard);

it("does not retire a retained generation promoted while collection acquires publication custody", async () => {
  const original = await prepare("a");
  const latest = await prepare("b");
  await latest.release();
  const entered = createDeferred();
  const resume = createDeferred();
  const withMutation = allocation.withWorktreeMutationLease;
  let paused = false;
  vi.spyOn(allocation, "withWorktreeMutationLease").mockImplementation(async (input, run) => {
    if (!paused && input.id === "template:runtime-one") {
      paused = true;
      entered.resolve();
      await resume.promise;
    }
    return withMutation(input, run);
  });
  const pruning = collectWorktreeTemplates(env, 0, { ...guard, supersededBy: latest });
  await entered.promise;
  try {
    const promoted = await prepare("a");
    await promoted.release();
    await original.release();
  } finally {
    resume.resolve();
    await pruning;
  }
  expect(
    (await listTemplatesAsync(env)).find((record) => record.cacheKey === "runtime-one")?.id,
  ).toBe(original.id);
});

it.each(["idle", "retained"])(
  "preserves a foreground hit on a %s prewarm after the next head",
  async (state) => {
    await (await prepare("a")).release();
    const warmed = await prepare("b", "runtime-one", undefined, true);
    if (state === "idle") {
      await warmed.release();
    }
    const used = await prepare("b");
    expect(used.id).toBe(warmed.id);
    await used.release();
    if (state === "retained") {
      await warmed.release();
    }
    const latest = await prepare("c", "runtime-one", undefined, true);
    await latest.release();
    await collectWorktreeTemplates(env, 0, { ...guard, supersededBy: latest });
    const previous = await prepare("b");
    await previous.release();
    expect(previous.id).toBe(warmed.id);
    expect(installs).toEqual(["a", "b", "c"]);
    expect((await listTemplatesAsync(env)).map((record) => record.sourceCommit).toSorted()).toEqual(
      ["b", "c"],
    );
  },
);

it("retains only the newest prewarm, the foreground template, and active readers", async () => {
  const foreground = await prepare("a");
  await foreground.release();
  const previous = await prepare("b", "runtime-one", undefined, true);
  const latest = await prepare("c", "runtime-one", undefined, true);
  await latest.release();
  const prune = () => collectWorktreeTemplates(env, 0, { ...guard, supersededBy: latest });
  await prune();
  expect((await listTemplatesAsync(env)).map((record) => record.sourceCommit).toSorted()).toEqual([
    "a",
    "b",
    "c",
  ]);
  await previous.release();
  await prune();
  expect((await listTemplatesAsync(env)).map((record) => record.sourceCommit).toSorted()).toEqual([
    "a",
    "c",
  ]);
  const reused = await prepare("a");
  expect(reused.id).toBe(foreground.id);
  await reused.release();
});

it("does not hold template publication while maintenance waits for IO capacity", async () => {
  await (await prepare("a")).release();
  const entered = createDeferred();
  const resume = createDeferred();
  const cleanup = collectWorktreeTemplates(env, Date.now() + 60_000, {
    ...guard,
    beforeRemoval: async () => {
      entered.resolve();
      await resume.promise;
    },
  });
  await entered.promise;
  try {
    const reader = await prepare("a", "runtime-one", { remainingMs: 0 });
    resume.resolve();
    await cleanup;
    expect(await fs.readFile(path.join(reader.path, "dependency"), "utf8")).toBe("a");
    await reader.release();
  } finally {
    resume.resolve();
    await cleanup;
  }
});

it("reuses three alternating commits for interleaved waiters without reinstalling", async () => {
  for (const commit of ["a", "b", "c"]) {
    await (await prepare(commit)).release();
  }
  for (let wave = 0; wave < 2; wave++) {
    const cohort = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) => prepare(["a", "b", "c"][(index + wave) % 3]!)),
    );
    try {
      expect(cohort.every((result) => result.status === "fulfilled")).toBe(true);
      for (const result of cohort) {
        if (result.status === "fulfilled") {
          expect(await fs.readFile(path.join(result.value.path, "dependency"), "utf8")).toBe(
            result.value.sourceCommit,
          );
        }
      }
    } finally {
      await Promise.all(
        cohort.map(async (result) => {
          if (result.status === "fulfilled") {
            await result.value.release();
          }
        }),
      );
    }
  }
  expect(installs).toEqual(["a", "b", "c"]);
  expect(
    (await listTemplatesAsync(env)).filter((record) => record.status === "ready"),
  ).toHaveLength(3);
});

it.each([
  ["btrfs", false],
  ["sandbox-test", true],
] as const)(
  "bounds %s idle slots without retiring live readers (recent reuse: %s)",
  async (kind, reuse) => {
    backend = kind;
    const pinned = await prepare("a");
    for (const commit of ["b", "c", "d"]) {
      await (await prepare(commit)).release();
    }
    if (reuse) {
      await (await prepare("a")).release();
    }
    await (await prepare("e")).release();
    await collect();
    expect(await fs.readFile(path.join(pinned.path, "dependency"), "utf8")).toBe("a");
    await pinned.release();
    await collect();
    const records = await listTemplatesAsync(env);
    expect(records.map((record) => record.sourceCommit).toSorted()).toEqual([
      reuse ? "a" : "b",
      "c",
      "d",
      "e",
    ]);
    if (!reuse) {
      await expect(fs.stat(pinned.path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it("retires idle identity keys after six hours without damaging completed clones", async () => {
  now -= 7 * 60 * 60_000;
  const old = await prepare("a", "old-runtime");
  const projection = path.join(root, "projection");
  await fs.cp(old.path, projection, { recursive: true });
  now = Date.now();
  const current = await prepare("b", "new-runtime");
  await current.release();
  await collect();
  expect((await listTemplatesAsync(env)).some((record) => record.id === old.id)).toBe(true);
  await old.release();
  await collect();
  expect((await listTemplatesAsync(env)).map((record) => record.id)).toEqual([current.id]);
  expect(await fs.readFile(path.join(projection, "dependency"), "utf8")).toBe("a");
  await expect(fs.stat(old.path)).rejects.toMatchObject({ code: "ENOENT" });
});
