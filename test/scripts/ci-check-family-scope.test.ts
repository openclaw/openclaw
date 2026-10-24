import { describe, expect, it } from "vitest";
import { resolveCiCheckFamilyScope } from "../../scripts/lib/ci-check-family-scope.mts";

type Scope = Partial<ReturnType<typeof resolveCiCheckFamilyScope>>;
type Case = [string | string[], Scope];
const kit = "apps/shared/OpenClawKit/Sources";
const noTs = { madgeImportCycles: false, kyselyGuardrails: false };
const scoped: Scope = {
  baselineRatchets: true,
  madgeImportCycles: true,
  kyselyGuardrails: true,
  lint: true,
  types: true,
};
const casesFor = (expected: Scope, ...paths: string[]): Case[] =>
  paths.map((path) => [path, expected]);
const cases: Case[] = [
  ...[
    ["packages/gateway-protocol/README.md", false],
    ["packages/gateway-protocol/src/schema.ts", true],
    ["packages/gateway-protocol/prompts/runtime.md", true],
  ].map(([file, selected]): Case => [
    [String(file), "src/utils/absolute-deadline.test.ts"],
    { fastTasks: selected ? ["bundled-protocol"] : [] },
  ]),
  [
    "src/agents/session.test.ts",
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
    "extensions/telegram/src/runtime.ts",
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
    "extensions/telegram/tsconfig.json",
    "pnpm-lock.yaml",
    "new-owner/data.json",
  ),
  [
    ["ui/src/styles/chat.css", `${kit}/OpenClawKit/Resources/tool-display.json`],
    { checkTasks: ["guards"] },
  ],
  ...Object.entries({
    "docs/providers/new-provider.md": { fastTasks: [] },
    "docs/.generated/sqlite-session-transcript-schema-baseline.sha256": {
      additionalGroups: ["source-contracts"],
    },
    [`${kit}/OpenClawNativeState/OpenClawNativeStateSQLite.swift`]: {
      additionalGroups: ["boundaries"],
    },
    "apps/macos/Sources/OpenClaw/Storage.swift": {
      additionalGroups: ["runtime-topology-architecture"],
    },
    "apps/android/app/src/main/java/ai/openclaw/app/protocol/OpenClawProtocolConstants.kt": {
      fastTasks: ["bundled-protocol"],
    },
    "packages/normalization-core/src/record-coerce.ts": {
      checkTasks: expect.arrayContaining(["npm-lock"]),
    },
    "src/config/catalog.yaml": { lint: true, types: false },
    "src/config/catalog.json": { lint: true, types: true, ...noTs },
    "src/shared/runtime.js": noTs,
    "ui/src/runtime.tsx": {
      madgeImportCycles: true,
      kyselyGuardrails: false,
      checkTasks: ["guards", "dependencies"],
    },
    "cli-invocation.mjs": { fastTasks: expect.arrayContaining(["bun-launcher"]) },
    "src/infra/sqlite-existing-database.ts": { fastTasks: ["bun-launcher"] },
  } satisfies Record<string, Scope>),
  [["ui/src/styles/chat.css", "extensions/discord/skills/discord/SKILL.md"], { fastTasks: [] }],
  [
    ["ui/src/runtime.tsx", "src/config/catalog.json"],
    { madgeImportCycles: true, kyselyGuardrails: false },
  ],
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
    expect(resolveCiCheckFamilyScope(typeof paths === "string" ? [paths] : paths)).toMatchObject(
      expected,
    );
  });
});
