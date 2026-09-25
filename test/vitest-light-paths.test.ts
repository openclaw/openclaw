// Vitest light path tests validate light test include path generation.
import { describe, expect, it } from "vitest";
import {
  isCommandsLightTarget,
  resolveCommandsLightIncludePattern,
} from "./vitest/vitest.commands-light-paths.mjs";

describe("light vitest path routing", () => {
  it("maps commands allowlist source and test files to sibling light tests", () => {
    expect(isCommandsLightTarget("src/commands/text-format.ts")).toBe(true);
    expect(isCommandsLightTarget("src/commands/text-format.test.ts")).toBe(true);
    expect(resolveCommandsLightIncludePattern("src/commands/text-format.ts")).toBe(
      "src/commands/text-format.test.ts",
    );
    expect(resolveCommandsLightIncludePattern("src/commands/text-format.test.ts")).toBe(
      "src/commands/text-format.test.ts",
    );
    expect(isCommandsLightTarget("src/commands/gateway-status/helpers.ts")).toBe(true);
    expect(resolveCommandsLightIncludePattern("src/commands/gateway-status/helpers.ts")).toBe(
      "src/commands/gateway-status/helpers.test.ts",
    );
  });

  it("can route broad command test files without narrowing their source files", () => {
    expect(isCommandsLightTarget("src/commands/auth-choice.test.ts")).toBe(true);
    expect(resolveCommandsLightIncludePattern("src/commands/auth-choice.test.ts")).toBe(
      "src/commands/auth-choice.test.ts",
    );
    expect(isCommandsLightTarget("src/commands/auth-choice.ts")).toBe(false);
    expect(resolveCommandsLightIncludePattern("src/commands/auth-choice.ts")).toBeNull();
  });
});
