import fs from "node:fs";
import path from "node:path";
import { BaseSequencer, createVitest } from "vitest/node";

const [output, selectionsPath, includeFile] = process.argv.slice(2);
if (!output || !selectionsPath || !includeFile) {
  throw new Error("Expected runtime partition report, selections, and include paths");
}
const selections = JSON.parse(fs.readFileSync(selectionsPath, "utf8"));
process.env.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE = includeFile;
fs.writeFileSync(includeFile, "[]");
const ctx = await createVitest({
  config: path.resolve("ui/vitest.config.ts"),
  watch: false,
  reporters: [],
  configLoader: "runner",
  api: false,
});
try {
  const emptyDiscoveryAllowed = Boolean(ctx.config.passWithNoTests);
  const specifications = await ctx.globTestSpecifications();
  const paths = (files) =>
    files.map((file) => path.relative(process.cwd(), file.moduleId).replaceAll("\\", "/")).sort();
  const rows = [];
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
    rows.push({ index, original: paths(original), selected });
  }
  // Exercise the registered pool boundary with no members in this runtime's shard.
  fs.writeFileSync(includeFile, "[]");
  ctx.config.shard = { index: 1, count: 3 };
  const empty = await ctx.runTestSpecifications(specifications);
  fs.writeFileSync(
    output,
    JSON.stringify({
      discovered: paths(specifications),
      rows,
      empty: { modules: empty.testModules.length, errors: empty.unhandledErrors.length },
      emptyDiscoveryAllowed,
    }),
  );
} finally {
  await ctx.close();
}
