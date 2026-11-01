import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChildEnv } from "../../scripts/ci-run-node-test-shard.mts";
import { hasBuildArtifactAffectingChange } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { resolvePolicyTestTargets } from "../../scripts/lib/ci-policy-test-watch.mts";
import {
  isCiProofTestFile,
  PR_PROTECTED_RUNTIME_TEST_FILES,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  gatewayCallsitesGuard,
  createFixtureGit,
  createChangedNodeTestShards,
  materializeGatewayCallsitesFixture,
  selectedFiles,
  fallbackGroups,
  expectProtectedOwnerExpansion,
  writeFiles,
} from "./ci-changed-node-test-plan.test-support.js";

const argvTempDirs = useAutoCleanupTempDirTracker(afterEach);

const sourcePolicyTest = "src/infra/fs-safe-import-boundary.test.ts";
const lintSuppressionInventory = "test/scripts/lint-suppressions.test.ts";

function createSourceFixture(prefix: string, files: Record<string, string>) {
  const cwd = argvTempDirs.make(prefix);
  writeFiles(cwd, files);
  return cwd;
}

function expectFiles(
  shards: ReturnType<typeof createChangedNodeTestShards>,
  files: readonly string[],
  label?: string,
) {
  expect(shards, label).not.toBeNull();
  expect(selectedFiles(shards).toSorted(), label).toEqual([...files].toSorted());
}

function runPlan(config: string, ...includePatterns: string[]) {
  return { config, forwardedArgs: [], includePatterns, watchMode: false };
}

function createErasedCoreSourceFixture() {
  const erasedSource = "export interface Entry { value: string }\n";
  const cwd = createSourceFixture("changed-erased-core-", {
    ...Object.fromEntries(
      [
        "entry",
        "entry-sibling",
        "entry-imported",
        "entry-read",
        "import-retained",
        "ambient",
        "incomplete",
        "entry.d",
        "retired",
      ].map((name) => [`src/example/${name}.ts`, erasedSource]),
    ),
    "src/test-utils/entry.ts": erasedSource,
    [sourcePolicyTest]: "export {};\n",
    "src/example/entry-sibling.test.ts": "export {};\n",
    "src/example/import-consumer.test.ts": 'import "./entry-imported.js";\n',
    "src/example/source-reader.test.ts":
      'import { readFileSync } from "node:fs";\nreadFileSync(new URL("./entry-read.ts", import.meta.url), "utf8");\n',
    "src/example/runtime.ts": "export const value = 1;\n",
    "src/example/runtime-consumer.test.ts": 'import "./runtime.js";\n',
    "src/example/unknown.ts": "export const value = 1;\n",
    "src/example/runtime-before.ts": "export const value = 1;\n",
  });
  materializeGatewayCallsitesFixture(cwd);
  const git = createFixtureGit(cwd);
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture baseline");
  const baseRef = git("rev-parse", "HEAD");
  writeFiles(cwd, {
    "src/example/entry.ts": "export interface Entry { value: number }\n",
    "src/test-utils/entry.ts": "export interface Entry { value: number }\n",
    "src/example/entry-sibling.ts": "export type Entry = { value: number };\n",
    "src/example/entry-imported.ts": "export type Entry = { value: number };\n",
    "src/example/entry-read.ts": "export type Entry = { value: number };\n",
    "src/example/runtime.ts": "export const value = 2;\n",
    "src/example/runtime-before.ts": erasedSource,
    "src/example/import-retained.ts":
      'import { type Entry } from "./entry.js";\nexport type Result = Entry;\n',
    "src/example/ambient.ts": "export {};\ndeclare global { interface Window { entry: string } }\n",
    "src/example/incomplete.ts": "export interface Entry { value:\n",
    "src/example/new-entry.ts": erasedSource,
    "src/example/untracked.ts": erasedSource,
  });
  git("add", "src/example/new-entry.ts");
  rmSync(path.join(cwd, "src/example/retired.ts"));
  return { cwd, baseRef };
}

describe("CI changed Node test plan", () => {
  it.each([
    ["extensions/copilot/index.ts", ["extensions/copilot/index.test.ts"]],
    ["extensions/copilot/harness.ts", ["extensions/copilot/harness.test.ts"]],
    [
      "extensions/copilot/openclaw.plugin.json",
      ["extensions/copilot/index.test.ts", "extensions/copilot/harness.test.ts"],
    ],
  ] as const)("keeps host discovery proof when only %s changes", (changedPath, pluginTests) => {
    const hostTest = "src/agents/prepared-model-runtime.copilot.integration.test.ts";
    const shards = createChangedNodeTestShards([changedPath]);
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards).filter((file) => file === hostTest)).toHaveLength(1);
    const groups = fallbackGroups(shards ?? []);
    for (const pluginTest of pluginTests) {
      const config = expectDefined(
        buildVitestRunPlans([pluginTest])[0]?.config,
        `plugin config for ${pluginTest}`,
      );
      expect(
        groups.some(
          (group) =>
            group.configs.includes(config) &&
            (!group.includePatterns || group.includePatterns.includes(pluginTest)),
        ),
        pluginTest,
      ).toBe(true);
    }
    expect(buildVitestRunPlans([hostTest])).toEqual([
      runPlan("test/vitest/vitest.agents-core.config.ts", hostTest),
    ]);
    expect(
      buildVitestRunPlans([
        "extensions/copilot/index.test.ts",
        "extensions/copilot/harness.test.ts",
      ]),
    ).toEqual([
      runPlan(
        "test/vitest/vitest.extension-database-workers.config.ts",
        "extensions/copilot/harness.test.ts",
      ),
      runPlan("test/vitest/vitest.extensions.config.ts", "extensions/copilot/index.test.ts"),
    ]);
  });

  it.each([
    {
      source: "scripts/check-test-timeout-race-ratchet.mts",
      targets: ["test/scripts/check-test-timeout-race-ratchet.test.ts"],
      areas: ["scripts", "src/scripts", "test/scripts"],
    },
    {
      source: "ui/src/styles/chat/layout.css",
      areas: ["ui"],
      targets: [
        "ui/src/styles/base-theme-tokens.node.test.ts",
        "ui/src/styles/cursor-policy.node.test.ts",
      ],
    },
    {
      source: "ui/public/themes/tide.css",
      areas: ["ui"],
      targets: [
        "ui/src/styles/base-theme-contrast.node.test.ts",
        "ui/src/styles/base-theme-tokens.node.test.ts",
      ],
    },
    {
      source: "extensions/anthropic/openclaw.plugin.json",
      targets: ["src/agents/model-ref-shared.test.ts"],
      areas: ["extensions/anthropic", "src/config"],
    },
    {
      source: "src/test-utils/symlink-rebind-race.ts",
      targets: [
        "src/infra/fs-safe-import-boundary.test.ts",
        "src/agents/apply-patch.test.ts",
        "src/infra/fs-safe-remove.test.ts",
        "src/infra/fs-safe.test.ts",
      ],
      areas: ["src/test-utils"],
    },
    {
      source: "src/channels/message-access/operator-authority.test-support.ts",
      targets: [
        "src/channels/message-access/operator-authority.test.ts",
        "src/agents/command/delivery.restart-final.integration.test.ts",
        "src/agents/command/delivery.settle-reset.integration.test.ts",
        "src/auto-reply/reply/commands-acp.owner.test.ts",
        "src/auto-reply/reply/commands-allowlist.owner.test.ts",
        "src/auto-reply/reply/commands-plugin.channel-native.test.ts",
        "src/auto-reply/reply/commands-plugin.native-subagents.test.ts",
        "src/gateway/operator-run-recovery.channel.test.ts",
        "src/gateway/operator-run-recovery.test.ts",
        "src/gateway/server.mcp-session-owner.test.ts",
      ],
      areas: ["src/channels"],
    },
  ])("retains affected owner tests for $source", ({ source, targets: expected, areas }) => {
    if (source.endsWith(".test-support.ts")) {
      expect(hasBuildArtifactAffectingChange([source])).toBe(false);
    }
    const shards = createChangedNodeTestShards([source]);
    expect(shards).not.toBeNull();
    expectProtectedOwnerExpansion(shards, expected, areas);
    expect(selectedFiles(shards)).not.toContain(
      "extensions/acpx/src/runtime-advertised-model.process.test.ts",
    );
  });

  it("selects UI source consumers through exact executable owner plans", () => {
    const shards = createChangedNodeTestShards([
      "ui/src/app-routes.ts",
      "ui/src/app-navigation.ts",
    ]);
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toEqual(
      expect.arrayContaining(["ui/src/app-routes.test.ts", "ui/src/app-navigation.test.ts"]),
    );
    const uiFiles = selectedFiles(shards).filter((file) => file.startsWith("ui/"));
    const uiPlans = buildVitestRunPlans(uiFiles);
    expect(uiPlans.length).toBeGreaterThan(0);
    expect(
      uiPlans.flatMap((plan) => plan.includePatterns ?? plan.forwardedArgs).toSorted(),
    ).toEqual(uiFiles.toSorted());
    expect(
      uiPlans.every(
        (plan) =>
          plan.config === "ui/vitest.config.ts" || plan.config.startsWith("test/vitest/vitest.ui"),
      ),
    ).toBe(true);
    expect(selectedFiles(shards)).not.toContain("test/scripts/mobile-release-ci.test.ts");
  });

  it("leaves dedicated UI tests to their owners while retaining changed Node-driven tests", () => {
    const browser = "ui/src/components/markdown-mermaid.runtime.browser.test.ts";
    const node = "ui/src/components/form-controls.browser.test.ts";
    const bootstrap = "extensions/browser/chrome-extension/bootstrap.chromium.test.ts";
    const uiE2e = [
      "ui/src/e2e/chat-widget-sandbox.real-gateway.e2e.test.ts",
      "ui/src/e2e/settings-layout.e2e.test.ts",
    ];
    const changedPaths = [browser, node, ...uiE2e];
    const shards = createChangedNodeTestShards(changedPaths);
    expect(shards).not.toBeNull();
    const targets = shards?.flatMap((shard) => shard.targets ?? []) ?? [];
    expect(targets).toContain(node);
    expect(targets).not.toContain(browser);
    expect(targets).toEqual(expect.arrayContaining(uiE2e));
    expect(createChangedNodeTestShards(changedPaths, { dedicatedUiE2e: false })).toEqual(shards);

    const dedicated = createChangedNodeTestShards(changedPaths, { dedicatedUiE2e: true });
    expect(dedicated).not.toBeNull();
    expect(dedicated?.flatMap((shard) => shard.targets ?? [])).toEqual(
      targets.filter((target) => !uiE2e.includes(target)),
    );
    expect(dedicated?.filter((shard) => !shard.targets)).toEqual(
      shards?.filter((shard) => !shard.targets),
    );
    for (const dedicatedUiE2e of [undefined, false, true]) {
      const bootstrapPlan = createChangedNodeTestShards([bootstrap, node], { dedicatedUiE2e });
      expect(bootstrapPlan).not.toBeNull();
      expect(selectedFiles(bootstrapPlan).includes(bootstrap)).toBe(dedicatedUiE2e !== true);
      expect(selectedFiles(bootstrapPlan)).toContain(node);
    }
    const coreE2e = "src/gateway/gateway.test.ts";
    for (const dedicatedUiE2e of [false, true]) {
      const coreShards = createChangedNodeTestShards([coreE2e], { dedicatedUiE2e });
      expect(coreShards).not.toBeNull();
      expect(selectedFiles(coreShards)).toContain(coreE2e);
      expect(buildVitestRunPlans([coreE2e])[0]?.forwardedArgs).toContain(coreE2e);
      const mixed = createChangedNodeTestShards([...changedPaths, "src/deleted.ts"], {
        dedicatedUiE2e,
      });
      expect(mixed).not.toBeNull();
      expect(selectedFiles(mixed)).toContain(node);
      expect(selectedFiles(mixed)).not.toContain("test/scripts/mobile-release-ci.test.ts");
    }
  });
  it("keeps plugin-owned package metadata on its package and concrete readers", () => {
    const manifest = "extensions/msteams/package.json";
    const reader = "src/infra/plugin-package-reader.test.ts";
    const hostReader = "src/plugins/bundled-plugin-metadata.test.ts";
    const pluginTests = ["extensions/msteams/index.test.ts", "extensions/msteams/setup.test.ts"];
    const cwd = createSourceFixture("changed-plugin-metadata-", {
      [manifest]: JSON.stringify({ name: "@openclaw/msteams" }),
      [reader]: 'import "../../extensions/msteams/package.json" with { type: "json" };',
      [hostReader]: "export {};",
      [pluginTests[0]!]: "export {};",
      [pluginTests[1]!]: "export {};",
      "extensions/discord/package.json": JSON.stringify({ name: "@openclaw/discord" }),
      "extensions/discord/index.test.ts": "export {};",
    });
    const shards = createChangedNodeTestShards([manifest], { cwd });
    expectFiles(shards, [...pluginTests, reader]);
    expect(
      selectedFiles(createChangedNodeTestShards([manifest, hostReader], { cwd })).toSorted(),
    ).toEqual([...pluginTests, reader, hostReader].toSorted());
  });

  it("keeps a focused source job beside its canonical source scanner", () => {
    const shards = createChangedNodeTestShards(["src/agents/live-provider-owner.ts"]);
    const sourceTargets = [
      "src/agents/live-model-dynamic-candidates.test.ts",
      "src/agents/live-model-filter.test.ts",
      "src/agents/live-target-matcher.test.ts",
      "src/agents/model-compat.test.ts",
      // Missing history retains this cross-area consumer's closed module mock.
      "src/gateway/gateway-models.profiles.live.test-helpers.test.ts",
    ];
    expectProtectedOwnerExpansion(
      shards,
      [...sourceTargets, gatewayCallsitesGuard],
      ["src/agents"],
    );
    expect(selectedFiles(shards)).not.toContain("src/infra/device-bootstrap.test.ts");
    for (const target of sourceTargets) {
      const owners = (shards ?? []).filter((shard) => selectedFiles([shard]).includes(target));
      expect(owners, target).toHaveLength(1);
      expect(owners[0]?.requiresDist, target).toBe(false);
      expect(owners[0]?.runner, target).toBeDefined();
      expect(owners[0]?.predictedSeconds, target).toBeGreaterThan(0);
    }
  });

  it.each([
    ["src/plugins/contracts/registry.retry.test.ts", "contracts-plugins"],
    [
      "src/channels/plugins/contracts/session-binding.registry-backed.contract.test.ts",
      "contracts-channels",
    ],
  ])("leaves covered contract target %s to its dedicated matrix", (target, task) => {
    const before = createChangedNodeTestShards([target]);
    const dedicatedContractShards = [{ task, includePatterns: [target] }];
    expect(createChangedNodeTestShards([target], { dedicatedContractShards })).toEqual(
      before?.filter((shard) => !shard.targets),
    );
    // The same path is still a direct local target; CI coverage is opt-in.
    expect(buildVitestRunPlans([target]).flatMap((plan) => plan.includePatterns ?? [])).toEqual([
      target,
    ]);
    for (const coverage of [
      [],
      [{ task, includePatterns: [] }],
      [{ task, includePatterns: ["src/plugins/contracts/other.test.ts"] }],
      [{ task: "unrelated-task", includePatterns: [target] }],
    ]) {
      expect(createChangedNodeTestShards([target], { dedicatedContractShards: coverage })).toEqual(
        before,
      );
    }
  });

  it("requires dedicated config ownership and retains independent source scanners", () => {
    const cwd = argvTempDirs.make("openclaw-contract-coverage-");
    const target = "src/plugins/contracts/fixture.test.ts";
    const source = "src/test-utils/fixture.ts";
    const unrelated = [
      "src/plugins/contracts/fixture.e2e.test.ts",
      "src/channels/plugins/contracts/unowned.test.ts",
    ];
    try {
      writeFiles(
        cwd,
        Object.fromEntries(
          [target, source, sourcePolicyTest, ...unrelated].map((file) => [
            file,
            file === target
              ? 'import "../../test-utils/fixture.js";\nexport {};\n'
              : "export {};\n",
          ]),
        ),
      );
      materializeGatewayCallsitesFixture(cwd);
      for (const file of unrelated) {
        const before = createChangedNodeTestShards([file], { cwd });
        // General E2E and unknown channel patterns keep their exact owner;
        // the dedicated contract configs cannot claim those targets.
        expect(before?.flatMap((shard) => shard.targets ?? [])).toEqual([file]);
        expect(
          createChangedNodeTestShards([file], {
            cwd,
            dedicatedContractShards: [
              { task: "contracts-plugins", includePatterns: [file] },
              { task: "contracts-channels", includePatterns: [file] },
            ],
          }),
        ).toEqual(before);
      }
      const dedicatedContractShards = [{ task: "contracts-plugins", includePatterns: [target] }];
      expect(
        createChangedNodeTestShards([source], { cwd })?.flatMap((shard) => shard.targets ?? []),
      ).toEqual([gatewayCallsitesGuard, sourcePolicyTest, target]);
      expect(createChangedNodeTestShards([source], { cwd, dedicatedContractShards })).toEqual([
        expect.objectContaining({
          targets: [gatewayCallsitesGuard, sourcePolicyTest],
          requiresDist: false,
        }),
        expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("runs a boundary target once through its local owner", () => {
    const target = "test/plugin-extension-import-boundary.test.ts";
    const runnerBackend = "blacksmith";
    expect(createChangedNodeTestShards([target], { runnerBackend })).toEqual([
      {
        checkName: "checks-node-changed-boundary",
        configs: ["test/vitest/vitest.boundary.config.ts"],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed-boundary",
      },
    ]);
    // Local explicit selection still runs only the requested file.
    expect(buildVitestRunPlans([target])).toMatchObject([
      {
        config: "test/vitest/vitest.boundary.config.ts",
        includePatterns: [target],
        forwardedArgs: [],
        watchMode: false,
      },
    ]);
  });

  it("leaves explicit boundary coverage with the selected artifact owner", () => {
    const companion = "src/agents/live-provider-owner.ts";
    const target = "test/plugin-extension-import-boundary.test.ts";
    const options = { dedicatedBuildArtifacts: true };
    const shards = createChangedNodeTestShards([target, companion], options);
    expect(shards).not.toBeNull();
    expect(hasBuildArtifactAffectingChange([companion])).toBe(true);
    expect(shards).toEqual(createChangedNodeTestShards([companion], options));
    expect(selectedFiles(shards)).not.toContain(target);
    expect(shards?.map((shard) => shard.checkName)).not.toContain("checks-node-changed-boundary");
  });

  it("keeps direct helper readers and owner-bounded transitive contracts", () => {
    const helper = "test/helpers/local-fixture.ts";
    const direct = "src/example/direct-consumer.test.ts";
    const indirect = "src/example/indirect-consumer.test.ts";
    const e2e = "extensions/example/proof.e2e.test.ts";
    const cwd = createSourceFixture("changed-helper-consumers-", {
      [helper]: "export const fixture = 1;\n",
      [direct]: 'import "../../test/helpers/local-fixture.js";\n',
      [indirect]: 'import "./direct-consumer.test.js";\n',
      [e2e]: 'import "../../test/helpers/local-fixture.js";\n',
      "src/example/unrelated.test.ts": "export {};\n",
    });
    for (const [changedPath, expected] of [
      [helper, [direct, e2e]],
      [direct, [direct, indirect]],
    ] as const) {
      const shards = createChangedNodeTestShards([changedPath], { cwd });
      expectFiles(shards, expected);
      expect(selectedFiles(shards)).not.toContain("src/example/unrelated.test.ts");
    }
    const explicit = createChangedNodeTestShards([helper, e2e], { cwd });
    expectFiles(explicit, [e2e, direct]);
    expect(selectedFiles(explicit)).not.toContain(indirect);
  });

  it("retains protected configuration consumers while bounding ordinary cross-area consumers", () => {
    const source = "src/config/mutate.ts";
    const sibling = "src/config/mutate.test.ts";
    const contract = "src/config/owner-contract.test.ts";
    const directReader = "src/other/direct-reader.test.ts";
    const unrelated = "src/other/unrelated-contract.test.ts";
    const protectedConsumer = "src/state/local-onboarding-state.test.ts";
    expect(PR_PROTECTED_RUNTIME_TEST_FILES).toContain(protectedConsumer);
    expect(PR_PROTECTED_RUNTIME_TEST_FILES).not.toContain(unrelated);
    const cwd = createSourceFixture("changed-bounded-owner-contracts-", {
      [source]: "export const value = 1;\n",
      [sibling]: "export {};\n",
      "src/config/config.ts": 'export { value } from "./mutate.js";\n',
      [contract]: 'import { value } from "./config.js";\nexport const contract = value;\n',
      [directReader]: 'import "../config/mutate.js";\n',
      [unrelated]: 'import "../config/config.js";\n',
      [protectedConsumer]: 'import "../config/config.js";\n',
    });
    const shards = createChangedNodeTestShards([source], {
      cwd,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyRuntimeTests: false,
    });
    expectFiles(shards, [sibling, contract, directReader, protectedConsumer]);
    expect(selectedFiles(shards)).not.toContain(unrelated);
  });

  it("keeps both pending-input contracts protected by their worker-source policy", () => {
    const pendingInputTests = [
      "src/config/sessions/session-accessor.pending-input-retention.test.ts",
      "src/config/sessions/session-accessor.pending-inputs.test.ts",
    ];
    expect(PR_PROTECTED_RUNTIME_TEST_FILES).toEqual(expect.arrayContaining(pendingInputTests));
    expect(resolvePolicyTestTargets(["src/config/sessions/session-transcript.worker.ts"])).toEqual(
      expect.arrayContaining(pendingInputTests),
    );
  });

  it("keeps the extracted session database collection proof protected", () => {
    expect(PR_PROTECTED_RUNTIME_TEST_FILES).toContain(
      "src/gateway/session-database-retention.test.ts",
    );
  });

  it("keeps policy scanners beside ordinary importers without claiming complete source ownership", () => {
    const source = "src/test-utils/runtime.ts";
    const consumer = "src/example/runtime.test.ts";
    const unowned = "src/test-utils/unowned.ts";
    const createFixture = () =>
      createSourceFixture("changed-policy-scanner-", {
        [source]: "export const value = 1;\n",
        "src/example/runtime.ts": "export const value = 1;\n",
        [consumer]: 'import "../test-utils/runtime.js";\n',
        [unowned]: "export {};\n",
      });
    const cwd = createFixture();
    materializeGatewayCallsitesFixture(cwd);
    mkdirSync(path.dirname(path.join(cwd, sourcePolicyTest)), { recursive: true });
    writeFileSync(path.join(cwd, sourcePolicyTest), "export {};\n");
    const shards = createChangedNodeTestShards([source], { cwd });
    expectFiles(shards, [consumer, gatewayCallsitesGuard, sourcePolicyTest]);
    for (const paths of [[unowned], [source, unowned]]) {
      expect(selectedFiles(createChangedNodeTestShards(paths, { cwd })).toSorted()).toEqual(
        [
          ...(paths.includes(source) ? [consumer] : []),
          gatewayCallsitesGuard,
          sourcePolicyTest,
        ].toSorted(),
      );
    }
    expect(selectedFiles(createChangedNodeTestShards([source], { cwd: createFixture() }))).toEqual([
      consumer,
    ]);

    const sourceInventories = [
      "test/scripts/pr-wrapper-source-closure.test.ts",
      "test/scripts/pr-worktree-provision.test.ts",
      "test/scripts/eager-import-closure.test.ts",
      "test/scripts/update-restart-module-outcome.test.ts",
      "test/scripts/type-suppression-inventory.test.ts",
      "test/scripts/plugin-sdk-surface-report.test.ts",
      lintSuppressionInventory,
    ];
    expect(resolvePolicyTestTargets([source], { cwd })).toEqual([
      ...sourceInventories,
      gatewayCallsitesGuard,
      sourcePolicyTest,
    ]);
    expect(resolvePolicyTestTargets([source], { cwd, completeOwnersOnly: true })).toEqual([]);
    expect(resolvePolicyTestTargets(["src/example/runtime.ts"], { cwd })).toEqual([
      ...sourceInventories,
      gatewayCallsitesGuard,
    ]);
  });

  it.each([
    "scripts/perf/idle-gateway-measure-preload.mjs",
    "src/example.test.js",
    "src/.hidden.ts",
    "extensions/xai/.boundary-stubs/example.d.ts",
    "extensions/example/.one/.two/file.ts",
  ])("retains the lint inventory through the actual PR-exempt planner for %s", (changedPath) => {
    const shards = createChangedNodeTestShards([changedPath], {
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyRuntimeTests: false,
    });
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toContain(lintSuppressionInventory);
  });

  it.each([
    "scripts/perf/example.mts",
    "scripts/perf/example.cts",
    "packages/example/index.js",
    "docs/example.js",
  ])("keeps the lint inventory outside unsupported path %s", (changedPath) => {
    expect(resolvePolicyTestTargets([changedPath])).not.toContain(lintSuppressionInventory);
  });

  it("keeps erased-source owner selection independent of history", () => {
    const fixture = createErasedCoreSourceFixture();
    const options = fixture;
    for (const [label, paths, overrides] of [
      ["ordinary source", ["src/example/entry.ts"], {}],
      ["new source", ["src/example/new-entry.ts"], {}],
      [
        "mixed sources",
        [
          "src/example/entry.ts",
          "src/test-utils/entry.ts",
          "src/example/entry-sibling.ts",
          "src/example/entry-imported.ts",
          "src/example/entry-read.ts",
          "src/example/runtime.ts",
        ],
        {},
      ],
      ["policy-only owner", ["src/test-utils/entry.ts"], {}],
      ["missing base", ["src/example/entry.ts"], { baseRef: undefined }],
      ["moving base", ["src/example/entry.ts"], { baseRef: "HEAD" }],
      ["missing history", ["src/example/entry.ts"], { baseRef: "a".repeat(40) }],
      ["runtime before", ["src/example/runtime-before.ts"], {}],
      ["retained import", ["src/example/import-retained.ts"], {}],
      ["ambient declarations", ["src/example/ambient.ts"], {}],
      ["parse uncertainty", ["src/example/incomplete.ts"], {}],
      ["untracked source", ["src/example/untracked.ts"], {}],
      ["declaration file", ["src/example/entry.d.ts"], {}],
      ["deleted source", ["src/example/retired.ts"], {}],
      ["unknown companion", ["src/example/entry.ts", "src/example/unknown.ts"], {}],
    ] as const) {
      const shards = createChangedNodeTestShards([...paths], { ...options, ...overrides });
      expectFiles(
        shards,
        label === "policy-only owner"
          ? [gatewayCallsitesGuard, sourcePolicyTest]
          : [
              ...(label === "mixed sources" ? [sourcePolicyTest] : []),
              "src/example/entry-sibling.test.ts",
              "src/example/import-consumer.test.ts",
              "src/example/runtime-consumer.test.ts",
              "src/example/source-reader.test.ts",
              gatewayCallsitesGuard,
            ],
        label,
      );
    }
  });

  it("keeps mixed native changes with concrete readers independently of native jobs", () => {
    const swift = "apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift";
    const android = "apps/android/app/src/main/java/Example.kt";
    const runtime = "src/example/runtime.ts";
    const runtimeConsumer = "src/example/runtime-consumer.test.ts";
    const sourceReader = "src/example/native-source-reader.test.ts";
    for (const withSourceReader of [false, true]) {
      const cwd = createSourceFixture("changed-native-consumers-", {
        [swift]: "struct Example {}\n",
        [android]: "class Example\n",
        [runtime]: "export const value = 1;\n",
        [runtimeConsumer]: 'import "./runtime.js";\n',
        "apps/unknown/Example.swift": "struct Example {}\n",
        ...(withSourceReader
          ? {
              [sourceReader]: `import { readFileSync } from "node:fs";\nreadFileSync(new URL("../../${swift}", import.meta.url), "utf8");\n`,
            }
          : {}),
      });
      materializeGatewayCallsitesFixture(cwd);
      const reasons: string[] = [];
      const options = {
        cwd,
        onFallback: (reason: string) => reasons.push(reason),
      };
      const expected = [
        runtimeConsumer,
        gatewayCallsitesGuard,
        ...(withSourceReader ? [sourceReader] : []),
      ].toSorted();
      const shards = createChangedNodeTestShards([swift, android, runtime], options);
      expectFiles(shards, expected, reasons.join("\n"));
      expect(
        createChangedNodeTestShards(
          [swift, android, runtime, "apps/unknown/Example.swift"],
          options,
        ),
      ).toEqual(shards);
      if (withSourceReader) {
        const readerOwned = createChangedNodeTestShards([swift, runtime], { cwd });
        expectFiles(readerOwned, expected);
      }
    }
  });

  it.each([
    ...[
      "src/secrets/runtime-auth-store-admission.ts",
      "src/agents/prepared-model-runtime.configured.ts",
    ].map((changedPath) => ({
      changedPath,
      expected: ["src/gateway/server.agents.config-readiness.test.ts"],
    })),
    {
      changedPath: "src/gateway/config-reload.ts",
      expected: [
        "src/gateway/server.config-patch.test.ts",
        "src/gateway/server.agents.config-readiness.test.ts",
      ],
    },
    ...["src/gateway/server-close.ts", "src/gateway/server-run-shutdown.ts"].map((changedPath) => ({
      changedPath,
      expected: [
        "src/gateway/server.agent-execution-shutdown.test.ts",
        "src/gateway/server.agent-late-admission.test.ts",
        "test/gateway-session-end-shutdown.e2e.test.ts",
      ],
    })),
    // Child-process E2Es: the import graph reaches only the test-instance helper.
    {
      changedPath: "src/gateway/server-startup-observers.ts",
      expected: ["test/gateway-restart-resume.e2e.test.ts"],
    },
    {
      changedPath: "src/process/command-queue.capacity-groups.ts",
      expected: ["test/gateway-hook-concurrency.e2e.test.ts"],
    },
    {
      changedPath: "src/sessions/session-controller.steer.ts",
      expected: [
        "test/gateway-restart-resume.e2e.test.ts",
        "test/e2e/qa-lab/runtime/gateway-session-steering.e2e.test.ts",
      ],
    },
    {
      changedPath: "src/auto-reply/reply/queue/drain.ts",
      expected: ["test/e2e/qa-lab/runtime/gateway-session-steering.e2e.test.ts"],
    },
    {
      changedPath: "node-runtime-recovery.mjs",
      expected: ["test/scripts/node-runtime-recovery.built-cli.e2e.test.ts"],
    },
    {
      changedPath: "src/auto-reply/reply/abort.test.ts",
      expected: ["test/scripts/tsgo-core-test-shards.test.ts"],
    },
    {
      changedPath: "scripts/lib/ci-proof-test-inventory.mts",
      expected: ["test/vitest-pr-exempt-retention.test.ts"],
    },
    {
      changedPath: "src/plugins/plugin-instance.ts",
      expected: [
        "test/scripts/eager-import-closure.test.ts",
        "test/scripts/pr-worktree-provision.test.ts",
      ],
    },
    {
      changedPath: "scripts/e2e/lib/upgrade-survivor/run.sh",
      expected: [
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/upgrade-survivor-missing-load-path.test.ts",
      ],
    },
  ])(
    "retains explicit policy guards for $changedPath in automatic CI",
    ({ changedPath, expected }) => {
      const importer = "src/agents/live-model-filter.test.ts";
      const deferred = "src/state/openclaw-database-preflight.lifecycle.test.ts";
      const consumers = [importer, deferred];
      // Bound graph discovery while retaining the real watch inventory and execution owners.
      vi.spyOn(testProjects, "resolveAffectedTestsFromImportGraph").mockImplementation((paths) =>
        paths.length ? consumers : [],
      );
      vi.spyOn(testProjects, "resolveChangedTestTargetPlan").mockReturnValue({
        mode: "targets",
        targets: consumers,
      });
      vi.spyOn(testProjects, "hasImportGraphImpactOnTargets").mockReturnValue(false);
      vi.spyOn(testProjects, "hasImportGraphConsumers").mockReturnValue(false);
      try {
        const reasons: string[] = [];
        const shards = createChangedNodeTestShards([changedPath], {
          runnerBackend: "github",
          // Gateway owner watches must survive the default aggressive PR selection.
          selectionMode: changedPath.startsWith("src/gateway/") ? "aggressive" : "full",
          includeReleaseOnlyRuntimeTests: false,
          includePrExemptRuntimeTests: false,
          onFallback: (reason) => reasons.push(reason),
        });
        expect(shards, reasons.join("\n")).not.toBeNull();
        const files = selectedFiles(shards);
        for (const guard of expected) {
          expect(files.filter((file) => file === guard)).toHaveLength(1);
        }
        expect(files.includes("test/vitest-pr-exempt-retention.test.ts")).toBe(
          expected.includes("test/vitest-pr-exempt-retention.test.ts"),
        );
        expect(files).toContain(importer);
        expect(files).toContain(deferred);
        expect(files).not.toContain("test/scripts/mobile-release-ci.test.ts");
        expect(files.some(isCiProofTestFile)).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("keeps the Gateway callsite scanner beside extension source importers", () => {
    const source = "extensions/example/src/runtime.ts";
    const importer = "src/infra/extension-consumer.test.ts";
    const cwd = createSourceFixture("changed-extension-scanner-", {
      [source]: "export {};\n",
      [importer]: `import "../../${source}";\n`,
      [gatewayCallsitesGuard]: "export {};\n",
    });
    const shards = createChangedNodeTestShards([source], { cwd });
    expectFiles(shards, [gatewayCallsitesGuard, importer]);
  });

  it.each([
    {
      source: "packages/example/src/value.ts",
      specifier: "@openclaw/example/value",
      manifest: "packages/example/package.json",
      document: { name: "@openclaw/example", exports: { "./value": "./src/value.ts" } },
    },
    {
      source: "src/plugin-sdk/example.ts",
      specifier: "openclaw/plugin-sdk/example",
      manifest: "tsconfig.json",
      document: {
        compilerOptions: { paths: { "openclaw/plugin-sdk/*": ["src/plugin-sdk/*.ts"] } },
      },
    },
  ])("selects consumers of $specifier without a package-wide fallback", (fixture) => {
    const target = "src/infra/alias-consumer.test.ts";
    const cwd = argvTempDirs.make("changed-alias-consumers-");
    writeFiles(cwd, {
      [fixture.source]: "export const value = 1;\n",
      [fixture.manifest]: JSON.stringify(fixture.document),
      [target]: `import "${fixture.specifier}";\n`,
      "src/infra/unrelated.test.ts": "export {};\n",
    });
    materializeGatewayCallsitesFixture(cwd);
    const shards = createChangedNodeTestShards([fixture.source], { cwd });
    expectFiles(
      shards,
      fixture.source.startsWith("src/") ? [target, gatewayCallsitesGuard] : [target],
    );
  });

  it("keeps deleted-source owner guards beside live source owners without a full fallback", () => {
    const deleted = "src/infra/format-time/deleted-helper.ts";
    const deletedPlan = createChangedNodeTestShards([deleted]);
    expect(deletedPlan).not.toBeNull();
    expect(selectedFiles(deletedPlan)).toEqual(expect.arrayContaining([gatewayCallsitesGuard]));
    const mixed = createChangedNodeTestShards([deleted, "src/agents/live-provider-owner.ts"]);
    expect(mixed).not.toBeNull();
    expect(selectedFiles(mixed)).toEqual(
      expect.arrayContaining(["src/agents/live-model-filter.test.ts", gatewayCallsitesGuard]),
    );
    expect(selectedFiles(mixed)).not.toContain("test/scripts/mobile-release-ci.test.ts");
    expect(selectedFiles(mixed)).not.toContain(deleted);
  });

  it("runs only the boundary shard when a diff deletes a test", () => {
    const cwd = argvTempDirs.make("openclaw-ci-deleted-test-");
    expect(createChangedNodeTestShards(["src/gone.test.ts"], { cwd })).toEqual([
      {
        checkName: "checks-node-changed-boundary",
        configs: ["test/vitest/vitest.boundary.config.ts"],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed-boundary",
      },
    ]);
  });

  it("retains leaf-config owners and their execution metadata", () => {
    const config = "test/vitest/vitest.commands.config.ts";
    const full = createNodeTestShardBundles({
      compactMode: "pull-request",
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyToolingShards: true,
    });
    const owners = full.flatMap((job) =>
      job.groups.filter((group) => group.configs.includes(config)),
    );
    expect(owners.length).toBeGreaterThan(1);
    const envScratch = argvTempDirs.make("changed-command-owner-env-");
    const expectCanonicalCommands = (shards: ReturnType<typeof createChangedNodeTestShards>) => {
      expect(shards).not.toBeNull();
      const groups = fallbackGroups(shards ?? []);
      const selectedOwners = groups.filter((group) => group.configs.includes(config));
      expect(selectedOwners.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
        owners.flatMap((group) => group.includePatterns ?? []).toSorted(),
      );
      expect(selectedOwners.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
      // Selected owners retain their singleton worker ceiling when serial rows share setup.
      const canonical = expectDefined(
        createSelectedNodeTestShardBundles(selectedFiles(shards), {
          includePrExemptRuntimeTests: true,
          includeReleaseOnlyRuntimeTests: true,
        }),
        "canonical selected commands jobs",
      );
      for (const group of selectedOwners) {
        const owner = expectDefined(
          owners.find((candidate) => candidate.shard_name === group.shard_name),
          "canonical commands owner",
        );
        expect(group.configs).toEqual(owner.configs);
        expect(group.env).toEqual(owner.env);
        expect(group.fallbackMaxWorkers).toBe(owner.fallbackMaxWorkers);
        expect(group.minTotalMemoryBytes).toBe(owner.minTotalMemoryBytes);
        const ownerJob = expectDefined(
          canonical.find((job) =>
            job.groups.some((candidate) => candidate.shard_name === group.shard_name),
          ),
          "canonical selected commands job",
        );
        const ownerGroup = expectDefined(
          ownerJob.groups.find((candidate) => candidate.shard_name === group.shard_name),
          "canonical selected commands group",
        );
        const selectedJob = expectDefined(
          shards?.find((job) => job.groups?.includes(group)),
          "selected commands job",
        );
        for (const key of [
          "runner",
          "pretestBuildMode",
          "requiresDist",
          "timeoutMinutes",
        ] as const) {
          expect(selectedJob[key], `${group.shard_name} job ${key}`).toEqual(ownerJob[key]);
        }
        expect(
          Object.fromEntries(
            Object.entries(selectedJob.env ?? {}).filter(
              ([key]) => key !== "OPENCLAW_VITEST_MAX_WORKERS",
            ),
          ),
          `${group.shard_name} job environment`,
        ).toEqual(
          Object.fromEntries(
            Object.entries(ownerJob.env ?? {}).filter(
              ([key]) => key !== "OPENCLAW_VITEST_MAX_WORKERS",
            ),
          ),
        );
        const childWorkers = buildChildEnv(
          { kind: "group", name: group.shard_name, plan: group },
          {
            OPENCLAW_VITEST_MAX_WORKERS: selectedJob.planConcurrency === 1 ? "8" : "2",
            ...selectedJob.env,
          },
          envScratch,
          0,
        ).OPENCLAW_VITEST_MAX_WORKERS;
        const ownerChildWorkers = buildChildEnv(
          { kind: "group", name: ownerGroup.shard_name, plan: ownerGroup },
          {
            OPENCLAW_VITEST_MAX_WORKERS: ownerJob.planConcurrency === 1 ? "8" : "2",
            ...ownerJob.env,
          },
          envScratch,
          0,
        ).OPENCLAW_VITEST_MAX_WORKERS;
        expect(childWorkers, `${group.shard_name} child worker ceiling`).toBe(ownerChildWorkers);
      }
      const configs = groups.flatMap((group) => group.configs);
      expect(configs).not.toContain("test/vitest/vitest.cron.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.ui.config.ts");
    };
    const shards = createChangedNodeTestShards([config]);
    expectCanonicalCommands(shards);
    expect(
      createChangedNodeTestShards([config], {
        includePrExemptRuntimeTests: false,
        includeReleaseOnlyRuntimeTests: false,
      }),
    ).toEqual(shards);
    expect(selectedFiles(shards)).toEqual(
      expect.arrayContaining([
        "test/vitest-projects-config.test.ts",
        "test/scripts/ci-node-test-plan.commands.test.ts",
      ]),
    );
  });
});
