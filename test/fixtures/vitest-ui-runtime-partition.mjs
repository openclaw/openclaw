import fs from "node:fs";
import path from "node:path";
import { BaseSequencer, createVitest, resolveConfig } from "vitest/node";

const [output, selectionsPath, includeFile] = process.argv.slice(2);
if (!output || !selectionsPath || !includeFile) {
  throw new Error("Expected runtime partition report, selections, and include paths");
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
  const emptyDiscoveryAllowed = Boolean(ctx.config.passWithNoTests);
  const specifications = await ctx.globTestSpecifications();
  process.env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE = includeFile;
  const paths = (files) =>
    files.map((file) => path.relative(process.cwd(), file.moduleId).replaceAll("\\", "/")).sort();
  const rows = [];
  for (const index of [undefined, 1, 2, 3]) {
    ctx.config.shard = index ? { index, count: 3 } : undefined;
    const native = new BaseSequencer(ctx);
    const original = index ? await native.shard(specifications) : specifications;
    const selected = {};
    const receipts = [];
    for (const [policy, partition] of Object.entries(selections)) {
      selected[policy] = [];
      for (const selection of partition) {
        fs.writeFileSync(
          includeFile,
          JSON.stringify(selection.includePatterns ?? paths(specifications)),
        );
        const requestId = `${index ?? "all"}-${policy}-${selection.runtime}`;
        const receiptFile = path.join(path.dirname(output), `${requestId}.json`);
        process.env.OPENCLAW_VITEST_NATIVE_SHARD_RECEIPT = receiptFile;
        process.env.OPENCLAW_VITEST_NATIVE_SHARD_REQUEST_ID = requestId;
        const sequencer = new ctx.config.sequence.sequencer(ctx);
        const sharded = index ? await sequencer.shard(specifications) : specifications;
        selected[policy].push({
          runtime: selection.runtime,
          files: paths(await sequencer.sort(sharded)),
        });
        delete process.env.OPENCLAW_VITEST_NATIVE_SHARD_RECEIPT;
        delete process.env.OPENCLAW_VITEST_NATIVE_SHARD_REQUEST_ID;
        receipts.push({ requestId, value: JSON.parse(fs.readFileSync(receiptFile, "utf8")) });
      }
    }
    rows.push({ index, original: paths(original), selected, receipts });
  }

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
    const file = path.join(path.dirname(output), `${name}.test.ts`);
    fs.writeFileSync(
      file,
      `${pragma}\n// ${"padding".repeat((schedulingCases.length - index) * 100)}\n`,
    );
    return unit.createSpecification(file);
  });
  await ctx.cache.stats.populateStats(ctx.config.root, schedulingSpecs);
  const names = (files) => files.map((file) => path.basename(file.moduleId, ".test.ts"));
  const native = new BaseSequencer(ctx);
  const sequencer = new ctx.config.sequence.sequencer(ctx);
  const scheduling = {
    native: names(await native.sort(schedulingSpecs)),
    cold: names(await sequencer.sort(schedulingSpecs)),
    cached: [],
    preserved: [],
    shuffled: [],
    partitionedShuffled: [],
  };
  for (const populateAll of [false, true]) {
    for (const [index, spec] of schedulingSpecs.entries()) {
      if (populateAll || index === 0) {
        ctx.cache.results.updateResults([
          {
            filepath: spec.moduleId,
            projectName: unit.name,
            result: { duration: index * 100, state: index === 2 ? "fail" : "pass" },
          },
        ]);
      }
    }
    scheduling.cached.push({
      native: names(await native.sort(schedulingSpecs)),
      actual: names(await sequencer.sort(schedulingSpecs)),
    });
    // Native Vitest caches keep portable keys even when node:path uses Windows separators.
    const relative = path.relative;
    try {
      path.relative = (...args) => relative(...args).replaceAll("/", "\\");
      scheduling.cached.push({
        native: names(await native.sort(schedulingSpecs)),
        actual: names(await sequencer.sort(schedulingSpecs)),
      });
    } finally {
      path.relative = relative;
    }
  }
  ctx.cache.results.cache.clear();
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
  scheduling.bounded = {
    native: selectionIds(await native.sort(boundedSpecs)),
    actual: selectionIds(await sequencer.sort(boundedSpecs)),
  };
  const mixed = [...schedulingSpecs];
  for (const name of ["unit-mock-registry", "chromium", "unit-timing"]) {
    const project = ctx.getProjectByName(name);
    const specs = schedulingSpecs.map((spec) => project.createSpecification(spec.moduleId));
    await ctx.cache.stats.populateStats(ctx.config.root, specs);
    scheduling.preserved.push({
      native: names(await native.sort(specs)),
      actual: names(await sequencer.sort(specs)),
    });
    mixed.push(...specs);
  }
  scheduling.projectOrder = {
    native: (await native.sort(mixed)).map((spec) => spec.project.name),
    actual: (await sequencer.sort(mixed)).map((spec) => spec.project.name),
  };
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
    scheduling.shuffled.push({
      native: names(await new nativeConfig.test.sequence.sequencer(ctx).sort([...schedulingSpecs])),
      actual: names(await new uiConfig.test.sequence.sequencer(ctx).sort([...schedulingSpecs])),
    });
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
      scheduling.partitionedShuffled.push({
        native: names(
          await new nativeConfig.test.sequence.sequencer(ctx).sort([...shuffleMembers]),
        ),
        actual: names(await partitioned.sort(sharded)),
        shardNative: paths(shuffleShard),
        shardActual: paths(sharded),
      });
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
  fs.writeFileSync(
    output,
    JSON.stringify({
      discovered: paths(specifications),
      rows,
      scheduling,
      empty: { modules: empty.testModules.length, errors: empty.unhandledErrors.length },
      emptyDiscoveryAllowed,
    }),
  );
} finally {
  await ctx.close();
}
