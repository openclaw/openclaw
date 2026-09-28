import { describe, expect, it } from "vitest";
import { resolveCiCheckFamilyScope } from "../../scripts/lib/ci-check-family-scope.mts";

describe("narrow PR check families", () => {
  it("drops unrelated source guard rows for UI styles", () => {
    expect(resolveCiCheckFamilyScope(["ui/src/styles/chat.css"])).toEqual({
      mode: "scoped",
      checkTasks: [],
      fastTasks: [],
      additionalGroups: [],
      baselineRatchets: false,
      lint: true,
      types: false,
    });
  });

  it("preserves source scanners and test consumers without rebuilding metadata for a unit test", () => {
    const scope = resolveCiCheckFamilyScope(["src/agents/session.test.ts"]);
    expect(scope.checkTasks).toEqual(["guards", "dependencies"]);
    expect(scope.fastTasks).toEqual([]);
    expect(scope.additionalGroups).toEqual([
      "boundaries",
      "source-contracts",
      "runtime-topology-architecture",
    ]);
    expect(scope).toMatchObject({
      mode: "scoped",
      baselineRatchets: true,
      lint: true,
      types: true,
    });
  });

  it.each([
    "src/shared/runtime.ts",
    "extensions/telegram/src/runtime.ts",
    "packages/media-core/src/types.d.ts",
  ])("keeps runtime and declaration consumers for %s", (path) => {
    const scope = resolveCiCheckFamilyScope([path]);
    expect(scope.checkTasks).not.toContain("bundled-channel-config-metadata");
    expect(scope.fastTasks).toEqual([]);
    expect(scope.additionalGroups).toContain("extension-package-boundary");
    expect(scope).toMatchObject({
      baselineRatchets: true,
      lint: true,
      types: true,
    });
  });

  it("keeps extension correctness checks while exact runtime tests use the Node owner", () => {
    const scope = resolveCiCheckFamilyScope(["extensions/telegram/src/send.ts"]);
    expect(scope.fastTasks).toEqual([]);
    expect(scope.checkTasks).toEqual(["guards", "dependencies"]);
    expect(scope).toMatchObject({ types: true, lint: true });
    expect(scope.additionalGroups).toContain("boundaries");
    expect(scope.additionalGroups).toContain("extension-package-boundary");
  });

  it.each(["src/config/zod-schema.core.ts", "extensions/telegram/src/config-schema.ts"])(
    "selects bundled metadata through its schema owner for %s",
    (file) => {
      expect(resolveCiCheckFamilyScope([file]).checkTasks).toContain(
        "bundled-channel-config-metadata",
      );
    },
  );

  it.each([
    "test/helpers/fixture.ts",
    "src/agents/session.test-support.ts",
    "scripts/lib/source-file-scan-cache.mts",
    "config/knip.all-exports.config.ts",
    "extensions/telegram/tsconfig.json",
    "extensions/telegram/package.json",
    "pnpm-lock.yaml",
    "new-owner/data.json",
  ])("falls back for shared, policy, or unclassified input %s", (path) => {
    const scope = resolveCiCheckFamilyScope([path]);
    expect(scope.checkTasks).toContain("npm-lock");
    expect(scope.fastTasks).toEqual(["bundled-protocol"]);
    expect(scope.additionalGroups).toContain("extension-package-boundary");
    expect(scope).toMatchObject({
      mode: "full",
      baselineRatchets: true,
      lint: true,
      types: true,
    });
  });

  it("selects generators and scanner owners for their non-TypeScript watched inputs", () => {
    expect(
      resolveCiCheckFamilyScope([
        "ui/src/styles/chat.css",
        "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json",
      ]).checkTasks,
    ).toEqual(["guards"]);
    expect(resolveCiCheckFamilyScope(["docs/providers/new-provider.md"]).fastTasks).toEqual([]);
    expect(
      resolveCiCheckFamilyScope([
        "docs/.generated/sqlite-session-transcript-schema-baseline.sha256",
      ]).additionalGroups,
    ).toEqual(["source-contracts"]);
    expect(
      resolveCiCheckFamilyScope([
        "apps/shared/OpenClawKit/Sources/OpenClawNativeState/OpenClawNativeStateSQLite.swift",
      ]).additionalGroups,
    ).toEqual(["boundaries"]);
    expect(
      resolveCiCheckFamilyScope(["apps/macos/Sources/OpenClaw/Storage.swift"]).additionalGroups,
    ).toEqual(["runtime-topology-architecture"]);
    expect(
      resolveCiCheckFamilyScope([
        "apps/android/app/src/main/java/ai/openclaw/app/protocol/OpenClawProtocolConstants.kt",
      ]).fastTasks,
    ).toEqual(["bundled-protocol"]);
  });

  it.each(["docs/plugins/sdk-subpaths.md", "extensions/discord/skills/discord/SKILL.md"])(
    "leaves runtime scanners with their exact changed-owner tests: %s",
    (path) => {
      expect(resolveCiCheckFamilyScope(["ui/src/styles/chat.css", path]).fastTasks).toEqual([]);
    },
  );

  it("keeps npm lock checks for their normalization dependency", () => {
    expect(
      resolveCiCheckFamilyScope(["packages/normalization-core/src/record-coerce.ts"]).checkTasks,
    ).toContain("npm-lock");
  });

  it("preserves data formatting and JSON type consumers with direct specialized-runtime opt-in", () => {
    expect(resolveCiCheckFamilyScope(["src/config/catalog.yaml"])).toMatchObject({
      lint: true,
      types: false,
    });
    expect(resolveCiCheckFamilyScope(["src/config/catalog.json"])).toMatchObject({
      lint: true,
      types: true,
    });
    expect(resolveCiCheckFamilyScope(["test/openclaw-launcher.e2e.test.ts"]).fastTasks).toEqual([
      "bun-launcher",
    ]);
  });
});
