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

function uiSpecs(rows: [bytes: number, seconds: number, name: string, groupOrder: number][]) {
  return testFiles(rows.map(([bytes]) => bytes)).map((file, index) => {
    const [, seconds, name, groupOrder] = rows[index]!;
    timings[path.relative(repoRoot, file.moduleId).replaceAll("\\", "/")] = seconds;
    return Object.assign(file, {
      project: { name, config: { isolate: true, sequence: { groupOrder } } },
    });
  });
}

function uiSequencer(
  getTestSpecificationResult = (
    _file: TestSpecification,
  ): { failed: boolean; duration: number } | undefined => undefined,
  shard?: { count: number; index: number },
) {
  return new UiE2eSequencer({
    config: { root: repoRoot, shard },
    cache: { getTestSpecificationResult },
  } as unknown as ConstructorParameters<typeof UiE2eSequencer>[0]);
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
  expect(await gatewayShards(files.toReversed(), 2)).toEqual(shards);
});

it("uses source bytes for every file when timing data is absent", async () => {
  const files = testFiles([100, 80, 20]);
  expect(await gatewayShards(files, 2)).toEqual([[files[0]], [files[1], files[2]]]);
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

it("keeps the UI worker borrowers together without changing discovered or selected files", async () => {
  const ui = createUiE2eVitestConfig({ OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1" }, []).test!;
  const discovered = (ui.projects ?? []).flatMap((project) => {
    if (typeof project !== "object" || project === null || !("test" in project) || !project.test) {
      return [];
    }
    const config = project.test;
    return globSync(config.include ?? [], { cwd: repoRoot, exclude: config.exclude }).map((file) =>
      Object.assign({ moduleId: path.join(repoRoot, file) } as TestSpecification, {
        project: { name: config.name, config },
      }),
    );
  });
  const borrowerPaths = new Set(
    [
      "model-providers-profile-outcomes",
      "post-deploy-session-entry",
      "question-guest",
      "screen-requester-routing",
    ].map((name) => path.join(repoRoot, "ui/src/e2e", `${name}.e2e.test.ts`)),
  );
  expect(discovered.filter((file) => borrowerPaths.has(file.moduleId))).toHaveLength(4);
  const partition = (files: TestSpecification[]) =>
    Promise.all(
      Array.from({ length: 6 }, (_, offset) =>
        uiSequencer(undefined, { count: 6, index: offset + 1 }).shard(files),
      ),
    );
  const selected = discovered.filter(
    (file) => !file.moduleId.endsWith("post-deploy-session-entry.e2e.test.ts"),
  );
  for (const files of [discovered, selected]) {
    const shards = await partition(files);
    expect(shards.flat()).toHaveLength(files.length);
    expect(new Set(shards.flat())).toEqual(new Set(files));
    const owners = shards.filter((shard) => shard.some((file) => borrowerPaths.has(file.moduleId)));
    expect(owners).toHaveLength(1);
    expect(await partition(files.toReversed())).toEqual(shards);
  }
});

it("starts expensive standalone UI work early without crossing serial phase barriers", async () => {
  const specs = uiSpecs([
    [400, 10, "ui-e2e-bundled", 0],
    [300, 10, "ui-e2e-bundled", 0],
    [100, 30, "ui-e2e-standalone", 0],
    [50, 100, "ui-e2e-serial", 1],
    [60, 200, "ui-e2e-serial", 1],
    [70, 300, "ui-e2e-real-gateway", 2],
  ]);
  const sequencer = uiSequencer();
  // eslint-disable-next-line unicorn/no-array-sort -- TestSequencer.sort is Vitest's ordering API.
  const ordered = await sequencer.sort(specs);
  expect(ordered).toEqual([specs[2], specs[0], specs[1], specs[4], specs[3], specs[5]]);
  // eslint-disable-next-line unicorn/no-array-sort -- TestSequencer.sort is Vitest's ordering API.
  expect(await sequencer.sort(specs.toReversed())).toEqual(ordered);
});

it("keeps native failed-first and observed-duration ordering for warm UI runs", async () => {
  const specs = uiSpecs([
    [100, 100, "ui-e2e-bundled", 0],
    [80, 1, "ui-e2e-bundled", 0],
    [20, 50, "ui-e2e-bundled", 0],
  ]);
  const results = new Map(
    specs.map((file, index) => [file, { failed: index === 1, duration: [500, 1, 90][index]! }]),
  );
  const sequencer = uiSequencer((file) => results.get(file));
  // eslint-disable-next-line unicorn/no-array-sort -- TestSequencer.sort is Vitest's ordering API.
  expect(await sequencer.sort(specs)).toEqual([specs[1], specs[0], specs[2]]);
});
