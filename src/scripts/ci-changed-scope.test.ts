import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { detectChangedScope } = (await import("../../scripts/ci-changed-scope.mjs")) as unknown as {
  detectChangedScope: (paths: string[]) => {
    runNode: boolean;
    runMacos: boolean;
    runAndroid: boolean;
    runWindows: boolean;
  };
};

describe("detectChangedScope", () => {
  it("fails safe when no paths are provided", () => {
    expect(detectChangedScope([])).toEqual({
      runNode: true,
      runMacos: true,
      runAndroid: true,
      runWindows: true,
    });
  });

  it("keeps all lanes off for docs-only changes", () => {
    expect(detectChangedScope(["docs/ci.md", "README.md"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
    });
  });

  it("enables node lane for node-relevant files", () => {
    expect(detectChangedScope(["src/plugins/runtime/index.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
    });
  });

  it("keeps node lane off for native-only changes", () => {
    expect(detectChangedScope(["apps/macos/Sources/Foo.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runAndroid: false,
      runWindows: false,
    });
    expect(detectChangedScope(["apps/shared/OpenClawKit/Sources/Foo.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runAndroid: true,
      runWindows: false,
    });
  });

  it("does not force macOS for generated protocol model-only changes", () => {
    expect(detectChangedScope(["apps/macos/Sources/OpenClawProtocol/GatewayModels.swift"])).toEqual(
      {
        runNode: false,
        runMacos: false,
        runAndroid: false,
        runWindows: false,
      },
    );
  });

  it("enables node lane for non-native non-doc files by fallback", () => {
    expect(detectChangedScope(["README.md"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
    });

    expect(detectChangedScope(["assets/icon.png"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
    });
  });

  it("keeps windows lane off for non-runtime GitHub metadata files", () => {
    expect(detectChangedScope([".github/labeler.yml"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
    });
  });
});
