import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import unitConfig from "../vitest.unit.config.ts";
import {
  loadExtraExcludePatternsFromEnv,
  loadIncludePatternsFromEnv,
} from "../vitest.unit.config.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

const writePatternFile = (basename: string, value: unknown) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vitest-unit-config-"));
  tempDirs.add(dir);
  const filePath = path.join(dir, basename);
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
  return filePath;
};

describe("loadIncludePatternsFromEnv", () => {
  it("returns null when no include file is configured", () => {
    expect(loadIncludePatternsFromEnv({})).toBeNull();
  });

  it("loads include patterns from a JSON file", () => {
    const filePath = writePatternFile("include.json", [
      "src/infra/update-runner.test.ts",
      42,
      "",
      "ui/src/ui/views/chat.test.ts",
    ]);

    expect(
      loadIncludePatternsFromEnv({
        OPENCLAW_VITEST_INCLUDE_FILE: filePath,
      }),
    ).toEqual(["src/infra/update-runner.test.ts", "ui/src/ui/views/chat.test.ts"]);
  });
});

describe("loadExtraExcludePatternsFromEnv", () => {
  it("returns an empty list when no extra exclude file is configured", () => {
    expect(loadExtraExcludePatternsFromEnv({})).toEqual([]);
  });

  it("loads extra exclude patterns from a JSON file", () => {
    const filePath = writePatternFile("extra-exclude.json", [
      "src/infra/update-runner.test.ts",
      42,
      "",
      "ui/src/ui/views/chat.test.ts",
    ]);

    expect(
      loadExtraExcludePatternsFromEnv({
        OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE: filePath,
      }),
    ).toEqual(["src/infra/update-runner.test.ts", "ui/src/ui/views/chat.test.ts"]);
  });

  it("throws when the configured file is not a JSON array", () => {
    const filePath = writePatternFile("extra-exclude.json", {
      exclude: ["src/infra/update-runner.test.ts"],
    });

    expect(() =>
      loadExtraExcludePatternsFromEnv({
        OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE: filePath,
      }),
    ).toThrow(/JSON array/u);
  });
});

describe("unit vitest config", () => {
  it("defaults unit tests to non-isolated mode", () => {
    expect(unitConfig.test?.isolate).toBe(false);
  });
});
