import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  createChangedNodeTestShards,
  createNodeWorkerE2eTestShards,
  hasControlUiPerformanceAffectingChange,
  resolveChangedNodeTestTargets,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import {
  createNodeTestShardBundles,
  resolveUiE2ePrTestSelection,
} from "../../scripts/lib/ci-node-test-plan.mts";
import {
  isReleaseOnlyRuntimeTestFile,
  listPrExemptRuntimeTestFiles,
  PR_PROTECTED_RUNTIME_TEST_FILES,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import { fallbackGroups, selectedFiles } from "./ci-changed-node-test-plan.test-support.js";

afterEach(() => vi.unstubAllEnvs());

// Real-checkout compositions share the planner's process-scoped import-graph cache.
// Small synthetic graphs and canonical process selection remain in the unit file.
it("selects the forced-cron process owner through its runtime-worker descriptor", () => {
  expect(resolveChangedNodeTestTargets(["src/cron/service/run-queue.ts"])).toContain(
    "src/cli/gateway-cli/run-loop.forced-cron.process.test.ts",
  );
});

it("keeps the aggressive fixed smoke within two Node rows", () => {
  let smoke: string[] = [];
  resolveChangedNodeTestTargets(["src/infra/new-unlisted-module.ts"], {
    selectionMode: "aggressive",
    onSelection: ({ rule, targets }) => {
      if (rule === "fixed-smoke") {
        smoke = targets;
      }
    },
  });
  expect(smoke).toHaveLength(2);
  const rows = createChangedNodeTestShards(["src/infra/new-unlisted-module.ts"], {
    selectedTestTargets: smoke,
    selectionMode: "aggressive",
    runnerBackend: "hybrid",
    dedicatedBuildArtifacts: false,
    dedicatedUiTests: true,
    dedicatedUiE2e: true,
  });
  expect(selectedFiles(rows).toSorted()).toEqual(smoke.toSorted());
  expect(rows?.filter((row) => !row.requiresDist).length).toBeLessThanOrEqual(2);
});

it("keeps the hybrid hourly plan within the main-tier cap", () => {
  const workerRows = createNodeWorkerE2eTestShards();
  const hourly = [
    ...createNodeTestShardBundles({
      runnerBackend: "hybrid",
      compactMode: "pull-request",
      compactNodeJobCap: 77 - workerRows.length,
      mainValidation: true,
      includeProofTests: true,
      includeReleaseOnlyToolingShards: true,
      includePrExemptRuntimeTests: true,
      includeReleaseOnlyRuntimeTests: false,
      includeReleaseOnlyPluginShards: false,
    }),
    ...workerRows,
  ];
  expect(hourly.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(77);
  expect(hourly.length).toBeLessThanOrEqual(79);
});

it.each(["test/scripts/bench-gateway-installed.test.ts", "scripts/bench-gateway-startup.ts"])(
  "opts in the installed benchmark for %s beside hub inputs",
  (changedPath) => {
    const target = "test/scripts/bench-gateway-installed.test.ts";
    expect(listPrExemptRuntimeTestFiles()).toContain(target);
    const options = {
      runnerBackend: "github",
      includeReleaseOnlyRuntimeTests: false,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyToolingShards: false,
    };
    const precise = createChangedNodeTestShards([changedPath], options);
    expect(precise, changedPath).not.toBeNull();
    expect(selectedFiles(precise), changedPath).toContain(target);
    const withHub = createChangedNodeTestShards(["tsconfig.json", changedPath], options);
    expect(withHub, changedPath).not.toBeNull();
    const withHubFiles = selectedFiles(withHub);
    expect(withHubFiles, changedPath).toContain(target);
    expect(withHubFiles).not.toContain(
      "extensions/acpx/src/runtime-advertised-model.process.test.ts",
    );
  },
);

it("retains package and plugin consumers together in a mixed diff", () => {
  const changedPaths = [
    "packages/gateway-protocol/src/frame-guards.ts",
    "extensions/codex/src/session-upstream-marker.ts",
  ];

  const fallbackReasons: string[] = [];
  const shards = createChangedNodeTestShards(changedPaths, {
    onFallback: (reason) => fallbackReasons.push(reason),
  });
  expect(shards, fallbackReasons.join("\n")).not.toBeNull();
  expect(selectedFiles(shards)).toEqual(
    expect.arrayContaining([
      "packages/gateway-protocol/src/frame-guards.test.ts",
      "extensions/codex/src/session-upstream-marker.test.ts",
    ]),
  );
  const extensionGroups = fallbackGroups(shards ?? []).filter((group) =>
    group.configs.some((config) => config.includes("vitest.extension")),
  );
  expect(extensionGroups.length).toBeGreaterThan(0);
  expect(extensionGroups.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
});

it.each(["packages/markdown-core/src/render-aware-chunking.ts"])(
  "selects channel chunk-contract suites when %s changes",
  (source) => {
    // Channels import the chunker through the Plugin SDK facade, below the PR import-walk depth.
    expect(
      resolveChangedNodeTestTargets([source], {
        selectionMode: "aggressive",
        includePrExemptRuntimeTests: false,
        includeReleaseOnlyRuntimeTests: false,
      }),
    ).toContain("extensions/telegram/src/format.test.ts");
  },
);

// #170662 moved transcript layout completion to a microtask. PR selection omitted
// these mocked-Gateway cases, so the resulting renderer freeze first failed on main.
it.each([
  {
    name: "the #170662 diff",
    paths: [
      "ui/src/pages/chat/components/chat-transcript-layout-solid.tsx",
      "ui/src/pages/chat/solid-render-lifecycle.ts",
    ],
  },
  { name: "message reveal", paths: ["ui/src/pages/chat/components/chat-message-reveal.ts"] },
  { name: "Solid render lifecycle", paths: ["ui/src/pages/chat/solid-render-lifecycle.ts"] },
])("selects transcript browser owners for $name", ({ paths }) => {
  const selection = resolveUiE2ePrTestSelection(paths);
  expect(selection.mode).toBe("owners");
  for (const file of [
    "ui/src/e2e/chat-collapsed-reply-reveal.e2e.test.ts",
    "ui/src/e2e/chat-position-rail.e2e.test.ts",
  ]) {
    expect(selection.reasons[file], file).toEqual(
      expect.arrayContaining([expect.stringMatching(/^direct route\/component dependency: /u)]),
    );
  }
});

it.each(["node", "bun-all"])("keeps exact UI and core owners with %s timings", (runtimePolicy) => {
  vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME_POLICY", runtimePolicy);
  const paths = [
    "ui/src/components/markdown-file-links.ts",
    "src/agents/live-provider-owner.ts",
    "ui/config/control-ui-boot-modules.json",
  ];
  const options = {
    runnerBackend: "hybrid",
    dedicatedUiE2e: true,
    includeReleaseOnlyRuntimeTests: false,
  };
  const shards = createChangedNodeTestShards(paths, options);
  expect(shards).not.toBeNull();
  expect(hasControlUiPerformanceAffectingChange([paths[2]!])).toBe(true);
  const targets = selectedFiles(shards);
  expect(targets).toEqual(
    expect.arrayContaining([
      "ui/src/components/markdown-file-links.test.ts",
      "src/agents/live-model-filter.test.ts",
    ]),
  );
  expect(targets).not.toContain("src/audit/execution-decision-facts.test.ts");
  expect(new Set(targets).size).toBe(targets.length);
  expect(new Set(shards?.map((shard) => shard.checkName)).size).toBe(shards?.length);
  expect(
    targets
      .filter(isReleaseOnlyRuntimeTestFile)
      .every((file) => PR_PROTECTED_RUNTIME_TEST_FILES.includes(file)),
  ).toBe(true);
  expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
  // Resource projection is covered by the unit suite's precise-process ownership and >96-target cases.
  // Missing ui/src/AGENTS.md models a deleted path, so retain its QA reference check.
  const deletedDocumentationPaths = [paths[1]!, "ui/src/AGENTS.md"];
  expect(createChangedNodeTestShards(deletedDocumentationPaths, options)).toEqual(
    createChangedNodeTestShards(deletedDocumentationPaths, {
      ...options,
      selectedTestTargets: [
        ...resolveChangedNodeTestTargets([paths[1]!], options),
        "extensions/qa-lab/src/scenario-catalog.test.ts",
      ],
    }),
  );
  for (const hub of ["package.json", "tsconfig.json"]) {
    const withHub = createChangedNodeTestShards([...paths, hub], options);
    expect(withHub).not.toBeNull();
    expect(selectedFiles(withHub)).toEqual(expect.arrayContaining(targets));
    expect(selectedFiles(withHub)).not.toContain(
      "extensions/acpx/src/runtime-advertised-model.process.test.ts",
    );
  }
});

it("keeps new-plugin, core, and manifest changes within the complete PR matrix cap", () => {
  // Minimal representatives of the #159879 diff: global, new-plugin, catalog,
  // core-source, explicit-test, and generated-tooling routes.
  const changedPaths = [
    "package.json",
    "extensions/slack-huddles/openclaw.plugin.json",
    "extensions/slack-huddles/src/config.test.ts",
    "scripts/lib/official-external-plugin-catalog.json",
    "src/meeting-bot/status-call-source.ts",
    "scripts/generate-plugin-inventory-doc.mts",
    "test/scripts/bundled-plugin-build-entries.test.ts",
  ];
  const shards = expectDefined(
    createChangedNodeTestShards(changedPaths, {
      runnerBackend: "hybrid",
      compactNodeJobCap: 130,
      dedicatedBuildArtifacts: false,
      includeReleaseOnlyRuntimeTests: false,
      includePrExemptRuntimeTests: false,
      dedicatedUiE2e: true,
      dedicatedUiTests: true,
    }),
    "new plugin and global-input owner plan",
  );
  expect(shards.filter((shard) => !shard.requiresDist).length).toBeLessThanOrEqual(130);
  expect(new Set(shards.map((shard) => shard.checkName)).size).toBe(shards.length);
  const files = selectedFiles(shards);
  expect(files).toContain("src/plugins/official-external-plugin-catalog.test.ts");
  // Global inputs keep protection for suites split out of protected owners.
  for (const split of [
    "src/cli/run-main.bare-root.test.ts",
    "src/cli/run-main.command-dispatch.test.ts",
    "src/cli/run-main.gateway-startup.test.ts",
    "src/plugins/official-external-plugin-catalog.hosted.test.ts",
  ]) {
    expect(files, split).toContain(split);
  }
  expect(files).toContain("src/plugins/bundled-plugin-metadata.test.ts");
  expect(files).toContain("test/scripts/bundled-plugin-build-entries.test.ts");
  expect(shards.some((shard) => shard.checkName.startsWith("checks-node-changed-extensions"))).toBe(
    true,
  );
  expect(
    shards.some((shard) => shard.configs.includes("test/vitest/vitest.boundary.config.ts")),
  ).toBe(true);
});
