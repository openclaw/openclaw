import { partitionUnitFastTestFiles } from "./vitest.unit-fast-paths.mjs";
import { createUnitFastVitestConfig } from "./vitest.unit-fast.config.ts";

export default createUnitFastVitestConfig(process.env, {
  include: partitionUnitFastTestFiles(0, 2),
  name: "unit-fast-a",
});
