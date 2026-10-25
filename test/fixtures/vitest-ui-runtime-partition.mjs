/* oxlint-disable unicorn/no-array-sort -- Vitest's sequencer API is named sort. */
/* oxlint-disable no-underscore-dangle -- Vitest exposes its result cache as _results. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BaseSequencer, createVitest, resolveConfig } from "vitest/node";
import { uiNodeDrivenBrowserTestFiles } from "../vitest/vitest.ui-paths.mjs";

const [fixtureRoot, selectionsPath, includeFile] = process.argv.slice(2);
if (!fixtureRoot || !selectionsPath || !includeFile) {
  throw new Error("Expected fixture root, selections, and include paths");
}
const selections = JSON.parse(fs.readFileSync(selectionsPath, "utf8"));
delete process.env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE;
fs.writeFileSync(includeFile, "[]");
const ctx = await createVitest({
  config: path.resolve("ui/vitest.config.ts"),
  watch: false,
  reporters: [],
  configLoader: "runner",
  api: false,
  cache: false,
});
try {
  assert.equal(Boolean(ctx.config.passWithNoTests), false);
  const specifications = await ctx.globTestSpecifications();
  const paths = (files) =>
    files.map((file) => path.relative(process.cwd(), file.moduleId).replaceAll("\\", "/")).sort();
  const packageNodeFiles = paths(
    specifications.filter((file) => ["unit", "unit-node"].includes(file.project.name)),
  );
  const rootCtx = await createVitest({
    config: path.resolve("test/vitest/vitest.ui.config.ts"),
    watch: false,
    reporters: [],
    configLoader: "runner",
    api: false,
    cache: false,
  });
  try {
    const rootNodeFiles = paths(await rootCtx.globTestSpecifications());
    assert.deepEqual(rootNodeFiles, packageNodeFiles);
    assert(rootNodeFiles.includes("ui/src/pages/chat/talk/shared.browser-import.test.ts"));
    for (const file of uiNodeDrivenBrowserTestFiles) {
      assert(rootNodeFiles.includes(file));
    }
  } finally {
    await rootCtx.close();
  }
  process.env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE = includeFile;
  const discovered = paths(specifications);
  assert(discovered.includes("ui/src/solid-smoke/solid-smoke.test.tsx"));
  const nodeRequired = new Set([
    "ui/src/components/desktop/desktop-mobile-keyboard.test.ts",
    "ui/src/pages/chat/chat-pane-retention.test.ts",
    "ui/src/pages/chat/chat-thread-retention.test.ts",
    "ui/src/pages/chat/session-snapshot-store.test.ts",
    "ui/src/pages/usage/usage-page-retention.test.ts",
  ]);
  const shardFiles = [];
  for (const index of [undefined, 1, 2, 3]) {
    ctx.config.shard = index ? { index, count: 3 } : undefined;
    const native = new BaseSequencer(ctx);
    const original = index ? await native.shard(specifications) : specifications;
    const selected = {};
    for (const [policy, partition] of Object.entries(selections)) {
      selected[policy] = [];
      for (const selection of partition) {
        fs.writeFileSync(
          includeFile,
          JSON.stringify(selection.includePatterns ?? paths(specifications)),
        );
        const sequencer = new ctx.config.sequence.sequencer(ctx);
        const sharded = index ? await sequencer.shard(specifications) : specifications;
        selected[policy].push({
          runtime: selection.runtime,
          files: paths(await sequencer.sort(sharded)),
        });
      }
    }
    const files = paths(original);
    if (index) {
      shardFiles.push(...files);
    }
    const nodeFiles = files.filter((file) => nodeRequired.has(file));
    const bunFiles = files.filter((file) => !nodeRequired.has(file));
    for (const [policy, expected] of [
      ["bun-all", nodeFiles],
      ["dual-all", files],
    ]) {
      assert.deepEqual(selected[policy], [
        { runtime: "node", files: expected },
        { runtime: "bun", files: bunFiles },
      ]);
    }
  }
  assert.deepEqual(shardFiles.toSorted(), discovered);

  // Exercise the registered sequencer with interleaved environment pragmas,
  // without running a second Vitest process or executing synthetic test bodies.
  delete process.env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE;
  const unit = ctx.getProjectByName("unit");
  const schedulingCases = [
    ["default-a", ""],
    ["node-a", "/* @jest-environment node */\n/* @vitest-environment jsdom */"],
    [
      "url-a",
      '/* @vitest-environment-options {"url":"https://same.test/","pretendToBeVisual":true} */',
    ],
    ["default-b", "// @jest-environment-options null"],
    ["node-b", "// @vitest-environment node"],
    [
      "url-b",
      '// @jest-environment-options {"pretendToBeVisual":true,"url":"https://same.test/"}\n// @vitest-environment-options {"url":"https://ignored.test/"}',
    ],
    ["default-false", "/* @vitest-environment-options false */"],
    ["other-url", '// @jest-environment-options {"url":"https://different.test/"}'],
  ];
  const schedulingSpecs = schedulingCases.map(([name, pragma], index) => {
    const file = path.join(fixtureRoot, `${name}.test.ts`);
    fs.writeFileSync(
      file,
      `${pragma}\n// ${"padding".repeat((schedulingCases.length - index) * 100)}\n`,
    );
    return unit.createSpecification(file);
  });
  const names = (files) => files.map((file) => path.basename(file.moduleId, ".test.ts"));
  const native = new BaseSequencer(ctx);
  const sequencer = new ctx.config.sequence.sequencer(ctx);
  const nativeOrder = names(await native.sort(schedulingSpecs));
  assert.deepEqual(
    nativeOrder,
    "default-a node-a url-a default-b node-b url-b default-false other-url".split(" "),
  );
  assert.deepEqual(
    names(await sequencer.sort(schedulingSpecs)),
    "default-a default-b default-false node-a node-b url-a url-b other-url".split(" "),
  );
  const assertNativeOrder = async (specs) => {
    const expected = names(await native.sort(specs));
    assert.deepEqual(names(await sequencer.sort(specs)), expected);
  };
  for (const populateAll of [false, true]) {
    for (const [index, spec] of schedulingSpecs.entries()) {
      if (populateAll || index === 0) {
        // Seed prior-run results through the cache owner without registering
        // synthetic files as executed modules in the current Vitest state.
        await ctx.cache._results.update(
          [
            {
              ...spec,
              testModule: {
                task: {
                  meta: {},
                  result: { duration: index * 100, state: index === 2 ? "fail" : "pass" },
                },
              },
            },
          ],
          0,
        );
      }
    }
    await assertNativeOrder(schedulingSpecs);
    // Native Vitest caches keep portable keys even when node:path uses Windows separators.
    const relative = path.relative;
    try {
      path.relative = (...args) => relative(...args).replaceAll("/", "\\");
      await assertNativeOrder(schedulingSpecs);
    } finally {
      path.relative = relative;
    }
  }
  await ctx.cache._results.clear();
  // testLines identify independent selections over shared physical pragma
  // fixtures; the real sequencer still reads their environments and file sizes.
  const boundedSpecs = [
    { count: 315, prefix: "default-" },
    { count: 90, prefix: "node-" },
  ].flatMap(({ count, prefix }) => {
    const fixtures = schedulingSpecs.filter((spec) =>
      path.basename(spec.moduleId).startsWith(prefix),
    );
    return Array.from({ length: count }, (_, index) =>
      unit.createSpecification(fixtures[index % fixtures.length].moduleId, {
        testLines: [index + 1],
      }),
    );
  });
  const selectionIds = (files) =>
    files.map((file) => `${path.basename(file.moduleId, ".test.ts")}:${file.testLines.join(",")}`);
  const boundedNative = selectionIds(await native.sort(boundedSpecs));
  const boundedActual = selectionIds(await sequencer.sort(boundedSpecs));
  assert.equal(boundedActual.length, 405);
  assert.deepEqual(boundedActual.toSorted(), boundedNative.toSorted());
  for (const prefix of ["default-", "node-"]) {
    assert.deepEqual(
      boundedActual.filter((id) => id.startsWith(prefix)),
      boundedNative.filter((id) => id.startsWith(prefix)),
    );
  }
  let previousEnvironment;
  let consecutive = 0;
  for (const selection of boundedActual) {
    const environment = selection.startsWith("node-") ? "node" : "jsdom";
    consecutive = environment === previousEnvironment ? consecutive + 1 : 1;
    assert(consecutive <= 128);
    previousEnvironment = environment;
  }
  const mixed = [...schedulingSpecs];
  for (const name of ["unit-mock-registry", "chromium", "unit-timing"]) {
    const project = ctx.getProjectByName(name);
    const specs = schedulingSpecs.map((spec) => project.createSpecification(spec.moduleId));
    await assertNativeOrder(specs);
    mixed.push(...specs);
  }
  const projectOrder = (await native.sort(mixed)).map((spec) => spec.project.name);
  assert.deepEqual(
    (await sequencer.sort(mixed)).map((spec) => spec.project.name),
    projectOrder,
  );
  const originalSeed = ctx.config.sequence.seed;
  ctx.config.sequence.seed = 37;
  ctx.config.shard = { index: 1, count: 2 };
  const shuffleShard = await native.shard(schedulingSpecs);
  const shuffleMembers = shuffleShard.slice(1);
  for (const shuffle of [true, { files: true, tests: false }]) {
    const options = { sequence: { shuffle, seed: 37 }, watch: false, cache: false };
    const [nativeConfig, uiConfig] = await Promise.all([
      resolveConfig({ ...options, config: false }),
      resolveConfig({
        ...options,
        config: path.resolve("ui/vitest.config.ts"),
        configLoader: "runner",
      }),
    ]);
    const nativeShuffled = names(
      await new nativeConfig.test.sequence.sequencer(ctx).sort([...schedulingSpecs]),
    );
    const shuffled = names(
      await new uiConfig.test.sequence.sequencer(ctx).sort([...schedulingSpecs]),
    );
    assert.deepEqual(shuffled, nativeShuffled);
    assert.notDeepEqual(shuffled, nativeOrder);
    process.env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE = includeFile;
    fs.writeFileSync(includeFile, JSON.stringify(paths(shuffleMembers)));
    const shuffledCtx = await createVitest({
      ...options,
      config: path.resolve("ui/vitest.config.ts"),
      configLoader: "runner",
      shard: "1/2",
      reporters: [],
      api: false,
    });
    try {
      const partitioned = new shuffledCtx.config.sequence.sequencer(shuffledCtx);
      const sharded = await partitioned.shard(schedulingSpecs);
      const nativeMembers = names(
        await new nativeConfig.test.sequence.sequencer(ctx).sort([...shuffleMembers]),
      );
      assert.deepEqual(names(await partitioned.sort(sharded)), nativeMembers);
      assert.deepEqual(paths(sharded), paths(shuffleShard));
    } finally {
      await shuffledCtx.close();
      delete process.env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE;
    }
  }
  ctx.config.sequence.seed = originalSeed;
  // Exercise the registered pool boundary with no members in this runtime's shard.
  process.env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE = includeFile;
  fs.writeFileSync(includeFile, "[]");
  ctx.config.shard = { index: 1, count: 3 };
  const empty = await ctx.runTestSpecifications(specifications);
  assert.equal(empty.testModules.length, 0);
  assert.equal(empty.unhandledErrors.length, 0);
} finally {
  await ctx.close();
}
