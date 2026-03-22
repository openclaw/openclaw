import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadIncludePatternsFromEnv } from "../vitest.extensions.config.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

const writePatternFile = (basename: string, value: unknown) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vitest-extensions-config-"));
  tempDirs.add(dir);
  const filePath = path.join(dir, basename);
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
  return filePath;
};

describe("extensions vitest include patterns", () => {
  it("returns null when no include file is configured", () => {
    expect(loadIncludePatternsFromEnv({})).toBeNull();
  });

  it("loads include patterns from a JSON file", () => {
    const filePath = writePatternFile("include.json", [
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
    const filePath = writePatternFile("include.json", {
      include: ["extensions/feishu/index.test.ts"],
    });

    expect(() =>
      loadIncludePatternsFromEnv({
        OPENCLAW_VITEST_INCLUDE_FILE: filePath,
      }),
    ).toThrow(/JSON array/u);
  });
});
