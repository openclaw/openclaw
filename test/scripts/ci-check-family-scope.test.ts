import { describe, expect, it } from "vitest";
import { resolveCiCheckFamilyScope } from "../../scripts/lib/ci-check-family-scope.mts";

type ScopeCase = {
  paths: string[];
  expected: Partial<ReturnType<typeof resolveCiCheckFamilyScope>>;
};
const scoped: ScopeCase["expected"] = {
  baselineRatchets: true,
  lint: true,
  types: true,
};
const cases: ScopeCase[] = [
  {
    paths: ["src/agents/session.test.ts"],
    expected: {
      ...scoped,
      mode: "scoped",
      checkTasks: ["guards", "dependencies"],
      fastTasks: [],
      additionalGroups: ["boundaries", "source-contracts", "runtime-topology-architecture"],
    },
  },
  ...[
    "src/shared/runtime.ts",
    "extensions/telegram/src/runtime.ts",
    "packages/media-core/src/types.d.ts",
  ].map((path) => ({
    paths: [path],
    expected: {
      ...scoped,
      checkTasks: ["guards", "dependencies"],
      fastTasks: [],
      additionalGroups: expect.arrayContaining(["boundaries", "extension-package-boundary"]),
    },
  })),
  ...["src/config/zod-schema.core.ts", "extensions/telegram/src/config-schema.ts"].map((path) => ({
    paths: [path],
    expected: { checkTasks: expect.arrayContaining(["bundled-channel-config-metadata"]) },
  })),
  ...[
    "test/helpers/fixture.ts",
    "src/agents/session.test-support.ts",
    "scripts/lib/source-file-scan-cache.mts",
    "config/knip.all-exports.config.ts",
    "extensions/telegram/tsconfig.json",
    "extensions/telegram/package.json",
    "pnpm-lock.yaml",
    "new-owner/data.json",
  ].map((path): ScopeCase => ({
    paths: [path],
    expected: {
      ...scoped,
      mode: "full",
      checkTasks: expect.arrayContaining(["npm-lock"]),
      fastTasks: ["bundled-protocol"],
      additionalGroups: expect.arrayContaining(["extension-package-boundary"]),
    },
  })),
  {
    paths: [
      "ui/src/styles/chat.css",
      "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json",
    ],
    expected: { checkTasks: ["guards"] },
  },
  { paths: ["docs/providers/new-provider.md"], expected: { fastTasks: [] } },
  {
    paths: ["docs/.generated/sqlite-session-transcript-schema-baseline.sha256"],
    expected: { additionalGroups: ["source-contracts"] },
  },
  {
    paths: ["apps/shared/OpenClawKit/Sources/OpenClawNativeState/OpenClawNativeStateSQLite.swift"],
    expected: { additionalGroups: ["boundaries"] },
  },
  {
    paths: ["apps/macos/Sources/OpenClaw/Storage.swift"],
    expected: { additionalGroups: ["runtime-topology-architecture"] },
  },
  {
    paths: ["apps/android/app/src/main/java/ai/openclaw/app/protocol/OpenClawProtocolConstants.kt"],
    expected: { fastTasks: ["bundled-protocol"] },
  },
  ...["docs/plugins/sdk-subpaths.md", "extensions/discord/skills/discord/SKILL.md"].map((path) => ({
    paths: ["ui/src/styles/chat.css", path],
    expected: { fastTasks: [] },
  })),
  {
    paths: ["packages/normalization-core/src/record-coerce.ts"],
    expected: { checkTasks: expect.arrayContaining(["npm-lock"]) },
  },
  { paths: ["src/config/catalog.yaml"], expected: { lint: true, types: false } },
  { paths: ["src/config/catalog.json"], expected: { lint: true, types: true } },
  { paths: ["test/openclaw-launcher.e2e.test.ts"], expected: { fastTasks: ["bun-launcher"] } },
];

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

  it.each(cases)("selects the check families owned by $paths", ({ paths, expected }) => {
    expect(resolveCiCheckFamilyScope(paths)).toMatchObject(expected);
  });
});
