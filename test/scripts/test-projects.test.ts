import { describe, expect, it } from "vitest";
import {
  buildVitestArgs,
  parseTestProjectsArgs,
} from "../../scripts/test-projects.test-support.mjs";

describe("test-projects args", () => {
  it("drops a pnpm passthrough separator while preserving targeted filters", () => {
    expect(parseTestProjectsArgs(["--", "src/foo.test.ts", "-t", "target"])).toEqual({
      forwardedArgs: ["src/foo.test.ts", "-t", "target"],
      watchMode: false,
    });
  });

  it("keeps watch mode explicit without leaking the sentinel to Vitest", () => {
    expect(buildVitestArgs(["--watch", "--", "src/foo.test.ts"])).toEqual([
      "exec",
      "vitest",
      "--config",
      "vitest.config.ts",
      "src/foo.test.ts",
    ]);
  });

  it("uses run mode by default", () => {
    expect(buildVitestArgs(["src/foo.test.ts"])).toEqual([
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      "src/foo.test.ts",
    ]);
  });
});
