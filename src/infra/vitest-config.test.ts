import { describe, expect, it } from "vitest";
import { parseVitestProcessStats } from "../../test/vitest/vitest.system-load.ts";

describe("parseVitestProcessStats", () => {
  it("counts other Vitest roots and workers while excluding the current pid", () => {
    expect(
      parseVitestProcessStats(
        [
          "101 0.0 node /Users/me/project/node_modules/.bin/vitest run --config vitest.config.ts",
          "102 41.3 /opt/homebrew/bin/node /Users/me/project/node_modules/vitest/dist/workers/forks.js",
          "103 37.4 /opt/homebrew/bin/node /Users/me/project/node_modules/vitest/dist/workers/forks.js",
          "200 12.0 node /Users/me/project/node_modules/.bin/vitest run --config test/vitest/vitest.unit.config.ts",
          "201 25.5 node unrelated-script.mjs",
        ].join("\n"),
        200,
      ),
    ).toEqual({
      otherVitestRootCount: 1,
      otherVitestWorkerCount: 2,
      otherVitestCpuPercent: 78.7,
    });
  });
});
