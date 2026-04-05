import { afterEach, describe, expect, it } from "vitest";
import {
  createUnitVitestConfig,
  createUnitVitestConfigWithOptions,
  loadExtraExcludePatternsFromEnv,
  loadIncludePatternsFromEnv,
} from "../vitest.unit.config.ts";
import { createPatternFileHelper } from "./helpers/pattern-file.js";

const patternFiles = createPatternFileHelper("openclaw-vitest-unit-config-");

afterEach(() => {
  patternFiles.cleanup();
});

describe("loadIncludePatternsFromEnv", () => {
  it("returns null when no include file is configured", () => {
    expect(loadIncludePatternsFromEnv({})).toBeNull();
  });

  it("loads include patterns from a JSON file", () => {
    const filePath = patternFiles.writePatternFile("include.json", [
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
    const filePath = patternFiles.writePatternFile("extra-exclude.json", [
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
    const filePath = patternFiles.writePatternFile("extra-exclude.json", {
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
  it("defaults unit tests to the non-isolated runner", () => {
    const unitConfig = createUnitVitestConfig({});
    expect(unitConfig.test?.isolate).toBe(false);
    expect(unitConfig.test?.runner).toBe("./test/non-isolated-runner.ts");
  });

  it("keeps acp and ui tests out of the generic unit lane", () => {
    const unitConfig = createUnitVitestConfig({});
    expect(unitConfig.test?.exclude).toEqual(expect.arrayContaining(["extensions/**", "test/**"]));
  });

  it("narrows the active include list to CLI file filters when present", () => {
    const unitConfig = createUnitVitestConfigWithOptions(
      {},
      {
        argv: ["node", "vitest", "run", "src/config/channel-configured.test.ts"],
      },
    );
    expect(unitConfig.test?.include).toEqual(["src/config/channel-configured.test.ts"]);
    expect(unitConfig.test?.passWithNoTests).toBe(true);
  });

  it("adds the OpenClaw runtime setup hooks on top of the base setup", () => {
    const unitConfig = createUnitVitestConfig({});
    expect(unitConfig.test?.setupFiles).toEqual([
      "test/setup.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
  });
});
