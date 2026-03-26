import { afterEach, describe, expect, it } from "vitest";
import { loadIncludePatternsFromEnv } from "../vitest.extensions.config.ts";
import { createPatternFileHelper } from "./helpers/pattern-file.js";

const patternFiles = createPatternFileHelper("openclaw-vitest-extensions-config-");

afterEach(() => {
  patternFiles.cleanup();
});

describe("extensions vitest include patterns", () => {
  it("returns null when no include file is configured", () => {
    expect(loadIncludePatternsFromEnv({})).toBeNull();
  });

  it("loads include patterns from a JSON file", () => {
    const filePath = patternFiles.writePatternFile("include.json", [
      "extensions/feishu/index.test.ts",
      42,
      "",
      "extensions/msteams/src/monitor.test.ts",
    ]);

    expect(
      loadIncludePatternsFromEnv({
        OPENCLAW_VITEST_INCLUDE_FILE: filePath,
      }),
    ).toEqual(["extensions/feishu/index.test.ts", "extensions/msteams/src/monitor.test.ts"]);
  });

  it("throws when the configured file is not a JSON array", () => {
    const filePath = patternFiles.writePatternFile("include.json", {
      include: ["extensions/feishu/index.test.ts"],
    });

    expect(() =>
      loadIncludePatternsFromEnv({
        OPENCLAW_VITEST_INCLUDE_FILE: filePath,
      }),
    ).toThrow(/JSON array/u);
  });
});
