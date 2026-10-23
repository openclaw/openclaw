import { globSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { TestSpecification } from "vitest/node";
import { createE2EVitestConfig } from "../vitest/vitest.e2e.config.ts";
import { RepoE2eSequencer } from "../vitest/vitest.e2e.sequencer.ts";
import { createUiE2eVitestConfig } from "../vitest/vitest.ui-e2e.config.ts";
import { UiE2eSequencer } from "../vitest/vitest.ui-e2e.sequencer.ts";
import { selectWeightedShard } from "../vitest/vitest.weighted-sharding.ts";

const { timings } = vi.hoisted(() => ({ timings: {} as Record<string, number> }));
vi.mock("../../scripts/lib/ci-test-timings.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/ci-test-timings.mts")>()),
  readRepoE2eFileTimings: () => timings,
  readUiE2eFileTimings: () => ({ fileSeconds: timings, perFileOverheadSeconds: 0 }),
}));

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];

it("keeps host E2Es and browser suites in their own projects", () => {
  const ui = createUiE2eVitestConfig({}, []).test!;
  const gateway = createE2EVitestConfig({}).test!;
  expect(gateway.pool).toBe("forks");
  const browserFiles = new Set(globSync(ui.include!, { cwd: repoRoot, exclude: ui.exclude }));
  expect(browserFiles.size).toBeGreaterThan(0);
  const gatewayFiles = globSync(gateway.include!, { cwd: repoRoot, exclude: gateway.exclude });
  expect(gatewayFiles.filter((file) => browserFiles.has(file))).toEqual([]);
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const key of Object.keys(timings)) {
    delete timings[key];
  }
});

function testFiles(sizes: number[]): TestSpecification[] {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-sharding-")));
  directories.push(directory);
  return sizes.map((bytes, index) => {
    const moduleId = path.join(directory, `${index}.e2e.test.ts`);
    writeFileSync(moduleId, "x".repeat(bytes));
    return { moduleId } as TestSpecification;
  });
}

async function gatewayShards(files: TestSpecification[], count: number) {
  return Promise.all(
    Array.from({ length: count }, (_, offset) => {
      const context = { config: { shard: { count, index: offset + 1 } } };
      return new RepoE2eSequencer(
        context as unknown as ConstructorParameters<typeof RepoE2eSequencer>[0],
      ).shard(files);
    }),
  );
}

it("balances the measured tail while retaining every discovered file exactly once", async () => {
  const files = testFiles([100, 100, 100]);
  for (const [index, seconds] of [
    [0, 100],
    [1, 20],
  ] as const) {
    timings[path.relative(repoRoot, files[index]!.moduleId).replaceAll("\\", "/")] = seconds!;
  }
  timings["test/deleted.e2e.test.ts"] = 900;
  const shards = await gatewayShards(files, 2);
  // The unmeasured file inherits 60 seconds from the discovered 120s/200-byte
  // sample. Equal file-count hashing cannot enforce this 100s/80s split.
  expect(shards).toEqual([[files[0]], [files[2], files[1]]]);
  expect(shards.flat()).toHaveLength(files.length);
  expect(new Set(shards.flat())).toEqual(new Set(files));
  expect(await gatewayShards(files.toReversed(), 2)).toEqual(shards);
});

it("uses source bytes for every file when timing data is absent", async () => {
  const files = testFiles([100, 80, 20]);
  expect(await gatewayShards(files, 2)).toEqual([[files[0]], [files[1], files[2]]]);
  const added = testFiles([120])[0]!;
  const shards = await gatewayShards([...files, added], 2);
  expect(shards.flat()).toHaveLength(4);
  expect(new Set(shards.flat())).toEqual(new Set([...files, added]));
});

it("keeps shared UI/Gateway partition ties deterministic without collapsing specifications", () => {
  const files = testFiles([1, 1, 1]);
  const secondProject = { moduleId: files[0]!.moduleId } as TestSpecification;
  const discovered = [...files, secondProject];
  const shards = [1, 2].map((index) =>
    selectWeightedShard(discovered, { index, count: 2 }, () => 1),
  );
  expect(shards.map((shard) => shard.length)).toEqual([2, 2]);
  expect(shards.flat()).toHaveLength(discovered.length);
  expect(new Set(shards.flat())).toEqual(new Set(discovered));
});

it("starts expensive standalone UI work early without crossing serial phase barriers", async () => {
  const sizes = [400, 300, 200, 100, 50, 60, 70];
  const files = testFiles(sizes);
  const durations = [10, 10, 10, 30, 100, 200, 300];
  const projects = [
    "ui-e2e-bundled",
    "ui-e2e-bundled",
    "ui-e2e-bundled",
    "ui-e2e-standalone",
    "ui-e2e-serial",
    "ui-e2e-serial",
    "ui-e2e-real-gateway",
  ];
  const specs = files.map((file, index) => {
    timings[path.relative(repoRoot, file.moduleId).replaceAll("\\", "/")] = durations[index]!;
    return Object.assign(file, {
      project: {
        name: projects[index]!,
        config: { isolate: true, sequence: { groupOrder: index < 4 ? 0 : index < 6 ? 1 : 2 } },
      },
    });
  });
  const stats = new Map(
    specs.map((file, index) => [
      `${file.project.name}:${path.relative(repoRoot, file.moduleId).replaceAll("\\", "/")}`,
      { size: sizes[index]! },
    ]),
  );
  const context = {
    config: { root: repoRoot },
    cache: { getFileTestResults: () => undefined, getFileStats: (key: string) => stats.get(key) },
  };
  const sequencer = new UiE2eSequencer(
    context as unknown as ConstructorParameters<typeof UiE2eSequencer>[0],
  );
  // eslint-disable-next-line unicorn/no-array-sort -- TestSequencer.sort is Vitest's ordering API.
  const ordered = await sequencer.sort(specs);
  expect(new Set(ordered)).toEqual(new Set(specs));
  expect(ordered).toHaveLength(specs.length);
  expect(ordered.map((file) => file.project.config.sequence.groupOrder)).toEqual([
    0, 0, 0, 0, 1, 1, 2,
  ]);
  expect(ordered.slice(4)).toEqual([specs[5], specs[4], specs[6]]);
  const workers = [0, 0, 0];
  for (const file of ordered.filter((spec) => spec.project.config.sequence.groupOrder === 0)) {
    const index = workers.indexOf(Math.min(...workers));
    workers[index]! += durations[specs.indexOf(file)]!;
  }
  // Three 10s bundled files before the 30s standalone would leave a 40s tail.
  expect(Math.max(...workers)).toBe(30);
  // eslint-disable-next-line unicorn/no-array-sort -- TestSequencer.sort is Vitest's ordering API.
  expect(await sequencer.sort(specs.toReversed())).toEqual(ordered);
});

it("keeps native failed-first and observed-duration ordering for warm UI runs", async () => {
  const files = testFiles([100, 80, 20]);
  const specs = files.map((file, index) => {
    timings[path.relative(repoRoot, file.moduleId).replaceAll("\\", "/")] = [100, 1, 50][index]!;
    return Object.assign(file, {
      project: {
        name: "ui-e2e-bundled",
        config: { isolate: true, sequence: { groupOrder: 0 } },
      },
    });
  });
  const results = new Map(
    specs.map((file, index) => [
      `${file.project.name}:${path.relative(repoRoot, file.moduleId).replaceAll("\\", "/")}`,
      { failed: index === 1, duration: [500, 1, 90][index]! },
    ]),
  );
  const context = {
    config: { root: repoRoot },
    cache: { getFileTestResults: (key: string) => results.get(key), getFileStats: () => undefined },
  };
  const sequencer = new UiE2eSequencer(
    context as unknown as ConstructorParameters<typeof UiE2eSequencer>[0],
  );
  // eslint-disable-next-line unicorn/no-array-sort -- TestSequencer.sort is Vitest's ordering API.
  expect(await sequencer.sort(specs)).toEqual([specs[1], specs[0], specs[2]]);
});
