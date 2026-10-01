import { describe, expect, it } from "vitest";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";

describe("shared native contract fixture CI scope", () => {
  it("runs Android and macOS contract tests for the shared Talk fixture", () => {
    const fixturePath = "test/fixtures/talk-config-contract.json";
    expect(detectChangedScope([fixturePath])).toEqual({
      runNode: true,
      runMacos: true,
      runMacosNode: true,
      runIosBuild: false,
      runAndroid: true,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("routes worker deploy artifact owners through macOS CI", () => {
    const ownerPath = "src/agents/github-exec-launcher.ts";
    expect(detectChangedScope([ownerPath])).toMatchObject({
      runNode: true,
      runMacos: true,
    });
  });
});
