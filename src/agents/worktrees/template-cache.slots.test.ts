import fs from "node:fs/promises";
import path from "node:path";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import { collectWorktreeTemplates, prepareWorktreeTemplate } from "./template-cache.js";
import {
  listTemplatesAsync,
  markTemplateReadyAsync,
  reserveTemplateAsync,
} from "./template-registry-async.js";
import { retainedWorktreeTemplateKey } from "./template-registry.js";

const directories = useWorktreeStateRoots();
const guard = { commitGuard: () => {} };
let env: NodeJS.ProcessEnv;
let root: string;
let now: number;
let installs: string[];

beforeEach(() => {
  root = directories.make("sandbox-template-slots-");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  env = { ...process.env };
  now = Date.now();
  installs = [];
});

async function prepare(
  commit: string,
  identity = "runtime-one",
  waitBudget?: { remainingMs: number },
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
    backend: "sandbox-test",
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

it.each([false, true])(
  "bounds idle slots without retiring live readers (recent reuse: %s)",
  async (reuse) => {
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

it("retains the newest four generations when background builds share foreground recency", async () => {
  for (const [index, commit] of ["a", "b", "c", "d", "e"].entries()) {
    // Reverse UUID order so recency ties cannot accidentally select the newest build.
    const id = `00000000-0000-4000-8000-00000000000${5 - index}`;
    const templatePath = path.join(root, "templates", ".templates", id);
    await fs.mkdir(templatePath, { recursive: true });
    await fs.writeFile(path.join(templatePath, "dependency"), commit);
    await reserveTemplateAsync(
      env,
      {
        cacheKey:
          commit === "e" ? "runtime-one" : retainedWorktreeTemplateKey("runtime-one", commit),
        id,
        repoRoot: path.join(root, "repo"),
        commonDir: path.join(root, "repo", ".git"),
        worktreeRoot: path.join(root, "templates"),
        path: templatePath,
        backend: "sandbox-test",
        sourceCommit: commit,
        contentKey: commit,
        status: "preparing",
        createdAt: now + index,
        lastUsedAt: now,
      },
      guard.commitGuard,
    );
    await markTemplateReadyAsync(env, id, now, guard.commitGuard);
  }
  await collect();
  expect((await listTemplatesAsync(env)).map((record) => record.sourceCommit)).toEqual([
    "b",
    "c",
    "d",
    "e",
  ]);
  await (await prepare("e")).release();
  expect(installs).toEqual([]);
});

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
