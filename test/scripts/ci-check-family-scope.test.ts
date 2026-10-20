import { describe, expect, it } from "vitest";
import { resolveCiCheckFamilyScope } from "../../scripts/lib/ci-check-family-scope.mts";

type Scope = Partial<ReturnType<typeof resolveCiCheckFamilyScope>>;
const scoped: Scope = {
  baselineRatchets: true,
  madgeImportCycles: true,
  kyselyGuardrails: true,
  lint: true,
  types: true,
};
const casesFor = (expected: Scope, ...paths: string[]): [string[], Scope][] =>
  paths.map((path) => [[path], expected]);
const cases: [string[], Scope][] = [
  ...[
    ["packages/gateway-protocol/README.md", false],
    ["packages/gateway-protocol/README.mdx", false],
    ["packages/gateway-protocol/src/schema.ts", true],
    ["packages/gateway-protocol/test/fixtures/README.md", true],
    ["packages/gateway-protocol/prompts/runtime.md", true],
  ].map(([file, selected]): [string[], Scope] => [
    [String(file), "src/utils/absolute-deadline.test.ts"],
    { fastTasks: selected ? ["bundled-protocol"] : [] },
  ]),
  [
    ["src/agents/session.test.ts"],
    {
      ...scoped,
      mode: "scoped",
      checkTasks: ["guards", "dependencies"],
      fastTasks: [],
      additionalGroups: ["boundaries", "source-contracts", "runtime-topology-architecture"],
    },
  ],
  ...casesFor(
    {
      ...scoped,
      checkTasks: ["guards", "dependencies"],
      fastTasks: [],
      additionalGroups: expect.arrayContaining(["boundaries", "extension-package-boundary"]),
    },
    "src/shared/runtime.ts",
    "src/shared/view.tsx",
    "packages/media-core/src/runtime.mts",
    "packages/media-core/src/runtime.cts",
    "extensions/telegram/src/runtime.ts",
    "packages/media-core/src/types.d.ts",
  ),
  ...casesFor(
    { checkTasks: expect.arrayContaining(["bundled-channel-config-metadata"]) },
    "src/config/zod-schema.core.ts",
    "extensions/telegram/src/config-schema.ts",
  ),
  ...casesFor(
    {
      ...scoped,
      mode: "full",
      checkTasks: expect.arrayContaining(["npm-lock"]),
      fastTasks: ["bundled-protocol"],
      additionalGroups: expect.arrayContaining(["extension-package-boundary"]),
    },
    "test/helpers/fixture.ts",
    "src/agents/session.test-support.ts",
    "scripts/lib/source-file-scan-cache.mts",
    "config/knip.all-exports.config.ts",
    "extensions/telegram/tsconfig.json",
    "extensions/telegram/package.json",
    "pnpm-lock.yaml",
    "new-owner/data.json",
  ),
  [
    [
      "ui/src/styles/chat.css",
      "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json",
    ],
    { checkTasks: ["guards"] },
  ],
  [["docs/providers/new-provider.md"], { fastTasks: [] }],
  [
    ["docs/.generated/sqlite-session-transcript-schema-baseline.sha256"],
    { additionalGroups: ["source-contracts"] },
  ],
  [
    ["apps/shared/OpenClawKit/Sources/OpenClawNativeState/OpenClawNativeStateSQLite.swift"],
    { additionalGroups: ["boundaries"] },
  ],
  [
    ["apps/macos/Sources/OpenClaw/Storage.swift"],
    { additionalGroups: ["runtime-topology-architecture"] },
  ],
  [
    ["apps/android/app/src/main/java/ai/openclaw/app/protocol/OpenClawProtocolConstants.kt"],
    { fastTasks: ["bundled-protocol"] },
  ],
  ...["docs/plugins/sdk-subpaths.md", "extensions/discord/skills/discord/SKILL.md"].map(
    (path): [string[], Scope] => [["ui/src/styles/chat.css", path], { fastTasks: [] }],
  ),
  [
    ["packages/normalization-core/src/record-coerce.ts"],
    { checkTasks: expect.arrayContaining(["npm-lock"]) },
  ],
  [["src/config/catalog.yaml"], { lint: true, types: false }],
  [
    ["src/config/catalog.json"],
    { lint: true, types: true, madgeImportCycles: false, kyselyGuardrails: false },
  ],
  [["src/shared/runtime.js"], { madgeImportCycles: false, kyselyGuardrails: false }],
  [
    ["ui/src/runtime.tsx"],
    { madgeImportCycles: true, kyselyGuardrails: false, checkTasks: ["guards", "dependencies"] },
  ],
  [
    ["ui/src/runtime.tsx", "src/config/catalog.json"],
    { madgeImportCycles: true, kyselyGuardrails: false },
  ],
  [["test/openclaw-launcher.e2e.test.ts"], { fastTasks: ["bun-launcher"] }],
  [["cli-invocation.mjs"], { fastTasks: expect.arrayContaining(["bun-launcher"]) }],
  [["src/infra/sqlite-existing-database.ts"], { fastTasks: ["bun-launcher"] }],
];

describe("narrow PR check families", () => {
  it("drops unrelated source guard rows for UI styles", () => {
    expect(resolveCiCheckFamilyScope(["ui/src/styles/chat.css"])).toEqual({
      mode: "scoped",
      checkTasks: [],
      fastTasks: [],
      additionalGroups: [],
      baselineRatchets: false,
      madgeImportCycles: false,
      kyselyGuardrails: false,
      lint: true,
      types: false,
    });
  });
  it.each(cases)("selects the check families owned by %j", (paths, expected) => {
    expect(resolveCiCheckFamilyScope(paths)).toMatchObject(expected);
  });
});
