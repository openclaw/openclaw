import { expect, it } from "vitest";
import { resolveCiCheckFamilyScope } from "../../scripts/lib/ci-check-family-scope.mts";

type Scope = Partial<ReturnType<typeof resolveCiCheckFamilyScope>>;
const kit = "apps/shared/OpenClawKit/Sources";
const noTs = { madgeImportCycles: false, kyselyGuardrails: false };
// Source/test/extension/style manifest wiring is exercised by
// ci-workflow-planning.test.ts: "emits and wires narrow families for $path".
it.each(
  Object.entries({
    "packages/gateway-protocol/README.md": { fastTasks: [] },
    "packages/gateway-protocol/src/schema.ts": { fastTasks: ["bundled-protocol"] },
    "packages/gateway-protocol/prompts/runtime.md": { fastTasks: ["bundled-protocol"] },
    "packages/media-core/src/runtime.mts": { madgeImportCycles: true, kyselyGuardrails: true },
    "src/config/zod-schema.core.ts": {
      checkTasks: expect.arrayContaining(["bundled-channel-config-metadata"]),
    },
    "extensions/telegram/src/config-schema.ts": {
      checkTasks: expect.arrayContaining(["bundled-channel-config-metadata"]),
    },
    [`${kit}/OpenClawKit/Resources/tool-display.json`]: { checkTasks: ["guards"] },
    "docs/providers/new-provider.md": { fastTasks: [], baselineRatchets: true },
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
    "cli-invocation.mjs": { fastTasks: expect.arrayContaining(["bun-launcher"]) },
    "src/infra/sqlite-existing-database.ts": { fastTasks: ["bun-launcher"] },
  } satisfies Record<string, Scope>),
)("selects the check families owned by %s", (file, expected) => {
  expect(resolveCiCheckFamilyScope([file])).toMatchObject(expected);
});

it.each([
  "test/helpers/fixture.ts",
  "src/agents/session.test-support.ts",
  "scripts/lib/source-file-scan-cache.mts",
  "extensions/telegram/tsconfig.json",
  "new-owner/data.json",
])("falls back to the full checks for %s", (file) => {
  expect(resolveCiCheckFamilyScope([file])).toMatchObject({
    mode: "full",
    checkTasks: ["guards", "npm-lock", "bundled-channel-config-metadata", "dependencies"],
    fastTasks: ["bundled-protocol"],
    additionalGroups: [
      "boundaries",
      "source-contracts",
      "extension-package-boundary",
      "runtime-topology-architecture",
    ],
    baselineRatchets: true,
    madgeImportCycles: true,
    kyselyGuardrails: true,
    lint: true,
    types: true,
  });
});

it("does not infer source Kysely work from unrelated UI TypeScript and source JSON", () => {
  expect(
    resolveCiCheckFamilyScope(["ui/src/runtime.tsx", "src/config/catalog.json"]),
  ).toMatchObject({
    madgeImportCycles: true,
    kyselyGuardrails: false,
  });
});
