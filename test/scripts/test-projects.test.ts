import { describe, expect, it } from "vitest";
import {
  buildVitestRunPlans,
  resolveChangedTargetArgs,
} from "../../scripts/test-projects.test-support.mjs";

describe("scripts/test-projects changed-target routing", () => {
  it("maps changed source files into scoped lane targets", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "src/shared/string-normalization.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toEqual(["src/shared/string-normalization.ts", "src/utils/provider-utils.ts"]);
  });

  it("keeps the broad changed run for Vitest wiring edits", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "vitest.shared.config.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toBeNull();
  });

  it("ignores changed files that cannot map to test lanes", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "docs/help/testing.md",
      ]),
    ).toBeNull();
  });

  it("narrows default-lane changed source files to include globs", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "packages/sdk/src/index.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.unit.config.ts",
        forwardedArgs: [],
        includePatterns: ["packages/sdk/src/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes changed utils and shared files to their light scoped lanes", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/shared/string-normalization.ts",
      "src/utils/provider-utils.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.shared-core.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/shared/**/*.test.ts"],
        watchMode: false,
      },
      {
        config: "vitest.utils.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/utils/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit plugin-sdk light tests to the lighter plugin-sdk lane", () => {
    const plans = buildVitestRunPlans(["src/plugin-sdk/temp-path.test.ts"], process.cwd());

    expect(plans).toEqual([
      {
        config: "vitest.plugin-sdk-light.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/temp-path.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit commands light tests to the lighter commands lane", () => {
    const plans = buildVitestRunPlans(["src/commands/cleanup-utils.test.ts"], process.cwd());

    expect(plans).toEqual([
      {
        config: "vitest.commands-light.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/cleanup-utils.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes changed plugin-sdk source allowlist files to sibling light tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/plugin-sdk/lazy-value.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.plugin-sdk-light.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/lazy-value.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes changed commands source allowlist files to sibling light tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/commands/status-overview-values.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.commands-light.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/status-overview-values.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps non-allowlisted plugin-sdk source files on the heavy lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/plugin-sdk/facade-runtime.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.plugin-sdk.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps non-allowlisted commands source files on the heavy lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/commands/channels.add.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });
});
