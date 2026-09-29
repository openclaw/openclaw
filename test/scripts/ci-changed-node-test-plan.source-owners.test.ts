import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as changedDependencies from "../../scripts/lib/changed-dependencies.mts";
import {
  createChangedExtensionFallbackShards,
  hasBuildArtifactAffectingChange,
  hasCoreExtensionImpact,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { resolvePolicyTestTargets } from "../../scripts/lib/ci-policy-test-watch.mts";
import {
  isCiProofTestFile,
  PR_PROTECTED_RUNTIME_TEST_FILES,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { boundaryTestFiles } from "../vitest/vitest.unit-paths.mjs";
import {
  gatewayCallsitesGuard,
  createChangedNodeTestShards,
  materializeGatewayCallsitesFixture,
  fallbackGroups,
  selectedFiles,
  expectProtectedOwnerExpansion,
} from "./ci-changed-node-test-plan.test-support.js";

const argvTempDirs = useAutoCleanupTempDirTracker(afterEach);

const sourcePolicyTest = "src/infra/fs-safe-import-boundary.test.ts";

function createErasedCoreSourceFixture() {
  const cwd = argvTempDirs.make("changed-erased-core-");
  const erasedSource = "export interface Entry { value: string }\n";
  const files = {
    "src/example/entry.ts": erasedSource,
    "src/test-utils/entry.ts": erasedSource,
    [sourcePolicyTest]: "export {};\n",
    "src/example/entry-sibling.ts": erasedSource,
    "src/example/entry-sibling.test.ts": "export {};\n",
    "src/example/entry-imported.ts": erasedSource,
    "src/example/import-consumer.test.ts": 'import "./entry-imported.js";\n',
    "src/example/entry-read.ts": erasedSource,
    "src/example/source-reader.test.ts":
      'import { readFileSync } from "node:fs";\nreadFileSync(new URL("./entry-read.ts", import.meta.url), "utf8");\n',
    "src/example/runtime.ts": "export const value = 1;\n",
    "src/example/runtime-consumer.test.ts": 'import "./runtime.js";\n',
    "src/example/unknown.ts": "export const value = 1;\n",
    "src/example/runtime-before.ts": "export const value = 1;\n",
    "src/example/import-retained.ts": erasedSource,
    "src/example/ambient.ts": erasedSource,
    "src/example/incomplete.ts": erasedSource,
    "src/example/entry.d.ts": erasedSource,
    "src/example/retired.ts": erasedSource,
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), source);
  }
  materializeGatewayCallsitesFixture(cwd);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd, env: createNestedGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture baseline");
  const baseRef = git("rev-parse", "HEAD");
  for (const [file, source] of Object.entries({
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
  })) {
    writeFileSync(path.join(cwd, file), source);
  }
  git("add", "src/example/new-entry.ts");
  rmSync(path.join(cwd, "src/example/retired.ts"));
  return { cwd, baseRef };
}

describe("CI changed Node test plan", () => {
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
    const cwd = argvTempDirs.make("changed-plugin-metadata-");
    const manifest = "extensions/msteams/package.json";
    const reader = "src/infra/plugin-package-reader.test.ts";
    const hostReader = "src/plugins/bundled-plugin-metadata.test.ts";
    const pluginTests = ["extensions/msteams/index.test.ts", "extensions/msteams/setup.test.ts"];
    for (const [file, source] of Object.entries({
      [manifest]: JSON.stringify({ name: "@openclaw/msteams" }),
      [reader]: 'import "../../extensions/msteams/package.json" with { type: "json" };',
      [hostReader]: "export {};",
      [pluginTests[0]!]: "export {};",
      [pluginTests[1]!]: "export {};",
      "extensions/discord/package.json": JSON.stringify({ name: "@openclaw/discord" }),
      "extensions/discord/index.test.ts": "export {};",
    })) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), source);
    }
    const dependencies = vi
      .spyOn(changedDependencies, "resolveChangedDependencies")
      .mockReturnValue({ importers: [], pluginMetadataPaths: [manifest] });
    try {
      const shards = createChangedNodeTestShards([manifest], { cwd });
      expect(shards).not.toBeNull();
      expect(selectedFiles(shards).toSorted()).toEqual([...pluginTests, reader].toSorted());
      expect(
        selectedFiles(createChangedNodeTestShards([manifest, hostReader], { cwd })).toSorted(),
      ).toEqual([...pluginTests, reader, hostReader].toSorted());
    } finally {
      dependencies.mockRestore();
    }
  });

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
      {
        config: "test/vitest/vitest.agents-core.config.ts",
        forwardedArgs: [],
        includePatterns: [hostTest],
        watchMode: false,
      },
    ]);
    expect(
      buildVitestRunPlans([
        "extensions/copilot/index.test.ts",
        "extensions/copilot/harness.test.ts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.extension-database-workers.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/copilot/harness.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.extensions.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/copilot/index.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it.each([
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
        "src/auto-reply/reply/commands-acp.owner.test.ts",
        "src/auto-reply/reply/commands-allowlist.owner.test.ts",
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

  it.each([
    {
      source: "test/scripts/openclaw-npm-plugin-recovery-workflow.test.ts",
      targets: [
        "test/scripts/openclaw-npm-plugin-recovery-workflow.test.ts",
        "test/scripts/test-projects.test.ts",
      ],
    },
    ...[
      "extensions/codex/src/app-server/run-attempt.native-config.test.ts",
      "extensions/codex/src/app-server/run-attempt.subscription.test.ts",
    ].map((source) => ({
      source,
      targets: expect.arrayContaining([source, "test/vitest-projects-config.test.ts"]),
    })),
  ])("selects inventory guards alongside $source", ({ source, targets: expected }) => {
    const shards = createChangedNodeTestShards([source]);
    expect(shards).not.toBeNull();
    const targets = fallbackGroups(shards ?? []).flatMap((group) => group.includePatterns ?? []);
    expect(targets.toSorted()).toEqual(expected);
  });

  it("routes cron alert sanitization changes through alert policy suites", () => {
    const shards = createChangedNodeTestShards(["src/cron/failure-notification-text.ts"]);
    const targets = selectedFiles(shards);

    expectProtectedOwnerExpansion(
      shards,
      [
        "src/cron/failure-notification-text.test.ts",
        "src/cron/service.stream-trigger.test.ts",
        "src/cron/service.stream-validation.test.ts",
        "src/cron/service/timer.timeout-watchdog.test.ts",
        gatewayCallsitesGuard,
      ],
      ["src/cron"],
    );
    expect(targets).not.toContain("src/infra/device-bootstrap.test.ts");
  });

  it("keeps a focused source job beside its canonical source scanner", () => {
    const shards = createChangedNodeTestShards(["src/agents/live-provider-owner.ts"]);
    const sourceTargets = [
      "src/agents/live-model-dynamic-candidates.test.ts",
      "src/agents/live-model-filter.test.ts",
      "src/agents/live-target-matcher.test.ts",
      "src/agents/model-compat.test.ts",
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
    "src/node-host/node-worker-bundle-installer.test.ts",
    "src/plugin-sdk/config-runtime.test.ts",
    "src/plugins/contracts/registry.retry.test.ts",
    "src/channels/plugins/config-schema.test.ts",
  ])("keeps exact test leaf %s focused while retaining boundary coverage", (target) => {
    expect(hasCoreExtensionImpact([target])).toBe(false);
    expect(createChangedExtensionFallbackShards([target])).toEqual([]);
    const dedicatedContractShards = [{ task: "contracts-channels", includePatterns: [target] }];
    const shards = createChangedNodeTestShards([target], { dedicatedContractShards });
    expect(shards).toEqual([
      {
        checkName: "checks-node-changed",
        configs: [],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed",
        targets: [target],
        predictedSeconds: expect.any(Number),
      },
      {
        checkName: "checks-node-changed-boundary",
        configs: ["test/vitest/vitest.boundary.config.ts"],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed-boundary",
      },
    ]);
    expect(shards?.every((shard) => (shard.predictedSeconds ?? 0) <= 300)).toBe(true);
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

  it("keeps uncovered and deleted-path coverage beside a dedicated contract target", () => {
    const target = "src/plugins/contracts/registry.retry.test.ts";
    const remaining = [
      "src/plugin-sdk/config-runtime.test.ts",
      "src/channels/plugins/config-schema.test.ts",
      "src/plugins/contracts/deleted.test.ts",
    ];
    const options = {
      dedicatedContractShards: [{ task: "contracts-plugins", includePatterns: [target] }],
    };
    expect(createChangedNodeTestShards([target, ...remaining], options)).toEqual(
      createChangedNodeTestShards(remaining),
    );
    for (const companion of ["src/deleted.ts", "tsconfig.json"]) {
      const mixed = createChangedNodeTestShards([target, companion], options);
      expect(mixed).not.toBeNull();
      expect(selectedFiles(mixed)).not.toContain(target);
      expect(selectedFiles(mixed)).not.toContain(
        "extensions/acpx/src/runtime-advertised-model.process.test.ts",
      );
    }
  });

  it("requires dedicated config ownership and retains independent source scanners", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-contract-coverage-"));
    const target = "src/plugins/contracts/fixture.test.ts";
    const source = "src/test-utils/fixture.ts";
    const unrelated = [
      "src/plugins/contracts/fixture.e2e.test.ts",
      "src/channels/plugins/contracts/unowned.test.ts",
    ];
    try {
      for (const file of [target, source, sourcePolicyTest, ...unrelated]) {
        mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        writeFileSync(
          path.join(cwd, file),
          file === target ? 'import "../../test-utils/fixture.js";\nexport {};\n' : "export {};\n",
        );
      }
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

  it.each(
    [[], ["extensions/matrix/src/matrix/actions/verification.test.ts"]].map((companions) => ({
      companions,
    })),
  )(
    "retains max-lines owner regressions beside its dedicated guard and $companions",
    ({ companions }) => {
      const paths = ["config/max-lines-baseline.txt", ...companions];
      for (const options of [{}, { dedicatedMaxLinesRatchet: false }]) {
        const uncredited = createChangedNodeTestShards(paths, options);
        expect(uncredited).not.toBeNull();
        const groups = fallbackGroups(uncredited ?? []);
        const targets = groups.flatMap((group) => group.includePatterns ?? []);
        expectProtectedOwnerExpansion(
          uncredited,
          [
            "test/scripts/check-max-lines-ratchet.test.ts",
            "test/scripts/ci-changed-node-test-plan.test.ts",
            "test/scripts/ci-workflow-planning.test.ts",
            ...companions,
          ],
          ["scripts", "src/scripts", "test/scripts"],
        );
        expect(targets).toEqual(expect.arrayContaining(companions));
      }
      const shards = createChangedNodeTestShards(paths, { dedicatedMaxLinesRatchet: true });
      expect(shards).not.toBeNull();
      const groups = fallbackGroups(shards ?? []);
      const targets = groups.flatMap((group) => group.includePatterns ?? []);
      const configs = groups.flatMap((group) => group.configs);
      expect(configs).toContain("test/vitest/vitest.tooling.config.ts");
      expect(shards).toEqual(createChangedNodeTestShards(paths));
      if (companions.length) {
        expect(targets).toContain("test/scripts/check-max-lines-ratchet.test.ts");
        expect(targets).toContain("extensions/matrix/src/matrix/actions/verification.test.ts");
      } else {
        expect(configs).toContain("test/vitest/vitest.boundary.config.ts");
        expect(targets).not.toContain("src/infra/device-bootstrap.test.ts");
      }
    },
  );

  it.each([
    {
      owner: "scripts/check-max-lines-ratchet.mts",
      tests: ["test/scripts/check-max-lines-ratchet.test.ts"],
    },
    { owner: "scripts/lib/shrink-ratchet.mts", tests: ["test/scripts/shrink-ratchet.test.ts"] },
    {
      owner: ".github/workflows/ci.yml",
      tests: [
        "test/scripts/check-workflows.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
        "test/scripts/ci-workflow-planning.test.ts",
        "test/scripts/ci-workflow-evidence.test.ts",
        "test/scripts/ci-changed-node-test-plan.test.ts",
      ],
    },
  ])("retains owner coverage for max-lines baseline mixed with $owner", ({ owner, tests }) => {
    const shards = createChangedNodeTestShards(["config/max-lines-baseline.txt", owner], {
      dedicatedMaxLinesRatchet: true,
    });
    expect(shards).not.toBeNull();
    const groups = fallbackGroups(shards ?? []);
    const targets = groups.flatMap((group) => group.includePatterns ?? []);
    const configs = groups.flatMap((group) => group.configs);
    expect(targets).toEqual(expect.arrayContaining(tests));
    expect(configs).toContain("test/vitest/vitest.boundary.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.tui-pty.config.ts");
    expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
  });

  it("retains planner regression coverage beside a dedicated max-lines guard", () => {
    const shards = createChangedNodeTestShards(
      ["config/max-lines-baseline.txt", "scripts/lib/ci-changed-node-test-plan.mts"],
      { dedicatedMaxLinesRatchet: true },
    );
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toContain("test/scripts/ci-changed-node-test-plan.test.ts");
  });

  it("does not expand other config data or a missing max-lines baseline", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ratchet-routing-"));
    try {
      mkdirSync(path.join(cwd, "config"));
      const baseline = "config/max-lines-baseline.txt";
      const unknown = "config/max-lines-baseline-other.txt";
      writeFileSync(path.join(cwd, baseline), "");
      writeFileSync(path.join(cwd, unknown), "");
      const options = { cwd, dedicatedMaxLinesRatchet: true };
      const live = createChangedNodeTestShards([baseline, unknown], options);
      expect(live).toEqual([
        expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
      ]);
      rmSync(path.join(cwd, baseline));
      expect(createChangedNodeTestShards([baseline], options)).toEqual(live);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(
    (["blacksmith", "hybrid", "github"] as const).flatMap((runnerBackend) =>
      boundaryTestFiles.map((target) => ({ runnerBackend, target })),
    ),
  )(
    "runs $target once through the local boundary owner on $runnerBackend",
    ({ runnerBackend, target }) => {
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
    },
  );

  it.each([
    "src/agents/embedded-agent-runner/run/attempt-yield-handoff.test.ts",
    "test/scripts/ci-linux-git.test.ts",
  ])("retains the other test owner alongside a boundary target: %s", (companion) => {
    expect(
      createChangedNodeTestShards(["test/extension-import-boundaries.test.ts", companion]),
    ).toEqual(createChangedNodeTestShards([companion]));
  });

  it("leaves explicit boundary coverage with the selected artifact owner", () => {
    const companion = "src/agents/live-provider-owner.ts";
    const target = "test/extension-import-boundaries.test.ts";
    const options = { dedicatedBuildArtifacts: true };
    const shards = createChangedNodeTestShards([target, companion], options);
    expect(shards).not.toBeNull();
    expect(hasBuildArtifactAffectingChange([companion])).toBe(true);
    expect(shards).toEqual(createChangedNodeTestShards([companion], options));
    expect(selectedFiles(shards)).not.toContain(target);
    expect(shards?.map((shard) => shard.checkName)).not.toContain("checks-node-changed-boundary");
  });

  it.each(["docs/help/index.md", "src/infra/deleted-boundary.test.ts"])(
    "retains the local boundary owner with an ignored companion: %s",
    (companion) => {
      const target = "test/extension-import-boundaries.test.ts";
      expect(createChangedNodeTestShards([target, companion])).toEqual(
        createChangedNodeTestShards([target]),
      );
    },
  );

  it.each(["src/infra/deleted-boundary.ts", "tsconfig.json"])(
    "keeps boundary coverage beside a deleted source or hub input: %s",
    (companion) => {
      const shards = createChangedNodeTestShards(
        ["test/extension-import-boundaries.test.ts", companion],
        { dedicatedBuildArtifacts: false },
      );
      expect(shards).not.toBeNull();
      expect(shards).toContainEqual(
        expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
      );
      expect(selectedFiles(shards)).not.toContain(
        "extensions/acpx/src/runtime-advertised-model.process.test.ts",
      );
    },
  );

  it("retains the complete boundary owner when its leaf config changes", () => {
    const shards = createChangedNodeTestShards([
      "test/extension-import-boundaries.test.ts",
      "test/vitest/vitest.boundary.config.ts",
    ]);
    expect(shards).not.toBeNull();
    expect(fallbackGroups(shards ?? [])).toContainEqual(
      expect.objectContaining({
        configs: ["test/vitest/vitest.boundary.config.ts"],
      }),
    );
    expect(
      fallbackGroups(shards ?? []).find((group) =>
        group.configs.includes("test/vitest/vitest.boundary.config.ts"),
      )?.includePatterns,
    ).toBeUndefined();
  });

  it("keeps direct helper readers and owner-bounded transitive contracts", () => {
    const cwd = argvTempDirs.make("changed-helper-consumers-");
    const helper = "test/helpers/local-fixture.ts";
    const direct = "src/example/direct-consumer.test.ts";
    const indirect = "src/example/indirect-consumer.test.ts";
    const e2e = "extensions/example/proof.e2e.test.ts";
    for (const [file, source] of [
      [helper, "export const fixture = 1;\n"],
      [direct, 'import "../../test/helpers/local-fixture.js";\n'],
      [indirect, 'import "./direct-consumer.test.js";\n'],
      [e2e, 'import "../../test/helpers/local-fixture.js";\n'],
      ["src/example/unrelated.test.ts", "export {};\n"],
    ] as const) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), source);
    }
    for (const [changedPath, expected] of [
      [helper, [direct, e2e]],
      [direct, [direct, indirect]],
    ] as const) {
      const shards = createChangedNodeTestShards([changedPath], { cwd });
      expect(shards).not.toBeNull();
      expect(selectedFiles(shards).toSorted()).toEqual([...expected].toSorted());
      expect(selectedFiles(shards)).not.toContain("src/example/unrelated.test.ts");
    }
    const explicit = createChangedNodeTestShards([helper, e2e], { cwd });
    expect(explicit).not.toBeNull();
    expect(selectedFiles(explicit).toSorted()).toEqual([e2e, direct].toSorted());
    expect(selectedFiles(explicit)).not.toContain(indirect);
  });

  it("retains protected configuration consumers while bounding ordinary cross-area consumers", () => {
    const cwd = argvTempDirs.make("changed-bounded-owner-contracts-");
    const source = "src/config/mutate.ts";
    const sibling = "src/config/mutate.test.ts";
    const contract = "src/config/owner-contract.test.ts";
    const directReader = "src/other/direct-reader.test.ts";
    const unrelated = "src/other/unrelated-contract.test.ts";
    const protectedConsumer = "src/state/local-onboarding-state.test.ts";
    expect(PR_PROTECTED_RUNTIME_TEST_FILES).toContain(protectedConsumer);
    expect(PR_PROTECTED_RUNTIME_TEST_FILES).not.toContain(unrelated);
    for (const [file, content] of Object.entries({
      [source]: "export const value = 1;\n",
      [sibling]: "export {};\n",
      "src/config/config.ts": 'export { value } from "./mutate.js";\n',
      [contract]: 'import { value } from "./config.js";\nexport const contract = value;\n',
      [directReader]: 'import "../config/mutate.js";\n',
      [unrelated]: 'import "../config/config.js";\n',
      [protectedConsumer]: 'import "../config/config.js";\n',
    })) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), content);
    }
    const shards = createChangedNodeTestShards([source], {
      cwd,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyRuntimeTests: false,
    });
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards).toSorted()).toEqual(
      [sibling, contract, directReader, protectedConsumer].toSorted(),
    );
    expect(selectedFiles(shards)).not.toContain(unrelated);
  });

  it("keeps policy scanners beside ordinary importers without claiming complete source ownership", () => {
    const source = "src/test-utils/runtime.ts";
    const consumer = "src/example/runtime.test.ts";
    const unowned = "src/test-utils/unowned.ts";
    const createFixture = () => {
      const cwd = argvTempDirs.make("changed-policy-scanner-");
      for (const [file, content] of [
        [source, "export const value = 1;\n"],
        [consumer, 'import "../test-utils/runtime.js";\n'],
        [unowned, "export {};\n"],
      ] as const) {
        mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        writeFileSync(path.join(cwd, file), content);
      }
      return cwd;
    };
    const cwd = createFixture();
    materializeGatewayCallsitesFixture(cwd);
    mkdirSync(path.dirname(path.join(cwd, sourcePolicyTest)), { recursive: true });
    writeFileSync(path.join(cwd, sourcePolicyTest), "export {};\n");
    const shards = createChangedNodeTestShards([source], { cwd });
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards).toSorted()).toEqual(
      [consumer, gatewayCallsitesGuard, sourcePolicyTest].toSorted(),
    );
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

    expect(resolvePolicyTestTargets([source])).toEqual([gatewayCallsitesGuard, sourcePolicyTest]);
    expect(resolvePolicyTestTargets([source], { completeOwnersOnly: true })).toEqual([]);
    expect(resolvePolicyTestTargets(["src/example/runtime.ts"])).toEqual([gatewayCallsitesGuard]);
  });

  it("selects erased core sources through their concrete owner tests", () => {
    const fixture = createErasedCoreSourceFixture();
    const reasons: string[] = [];
    const options = {
      ...fixture,
      dedicatedCoreTypeChecks: true,
      onFallback: (reason: string) => reasons.push(reason),
    };
    for (const source of ["src/example/entry.ts", "src/example/new-entry.ts"]) {
      const shards = createChangedNodeTestShards([source], options);
      expect(shards, source).not.toBeNull();
      expect(selectedFiles(shards).toSorted(), source).toEqual(
        [
          "src/example/entry-sibling.test.ts",
          "src/example/import-consumer.test.ts",
          "src/example/runtime-consumer.test.ts",
          "src/example/source-reader.test.ts",
          gatewayCallsitesGuard,
        ].toSorted(),
      );
    }
    const shards = createChangedNodeTestShards(
      [
        "src/example/entry.ts",
        "src/test-utils/entry.ts",
        "src/example/entry-sibling.ts",
        "src/example/entry-imported.ts",
        "src/example/entry-read.ts",
        "src/example/runtime.ts",
      ],
      options,
    );
    expect(shards, reasons.join("\n")).not.toBeNull();
    expect(selectedFiles(shards).toSorted()).toEqual(
      [
        "src/example/entry-sibling.test.ts",
        "src/example/import-consumer.test.ts",
        "src/example/runtime-consumer.test.ts",
        "src/example/source-reader.test.ts",
        gatewayCallsitesGuard,
        sourcePolicyTest,
      ].toSorted(),
    );
  });

  it("keeps erased-source owner selection independent of history and dedicated type gates", () => {
    const fixture = createErasedCoreSourceFixture();
    const options = { ...fixture, dedicatedCoreTypeChecks: true };
    for (const [label, paths, overrides] of [
      ["missing gate", ["src/example/entry.ts"], { dedicatedCoreTypeChecks: undefined }],
      ["disabled gate", ["src/example/entry.ts"], { dedicatedCoreTypeChecks: false }],
      ["policy-only owner", ["src/test-utils/entry.ts"], { dedicatedCoreTypeChecks: false }],
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
      expect(shards, label).not.toBeNull();
      expect(selectedFiles(shards).toSorted(), label).toEqual(
        (paths.some((file) => file === "src/test-utils/entry.ts")
          ? [gatewayCallsitesGuard, sourcePolicyTest]
          : [
              "src/example/entry-sibling.test.ts",
              "src/example/import-consumer.test.ts",
              "src/example/runtime-consumer.test.ts",
              "src/example/source-reader.test.ts",
              gatewayCallsitesGuard,
            ]
        ).toSorted(),
      );
    }
  });

  it("keeps actionlint consumers bounded to direct importers and changed owner areas", () => {
    for (const withConfigConsumer of [false, true]) {
      const cwd = argvTempDirs.make("changed-actionlint-consumers-");
      const files = {
        ".github/actionlint.yaml": "self-hosted-runner: {}\n",
        "src/example/runtime.ts": "export const value = 1;\n",
        "src/example/runtime-consumer.test.ts": 'import "./runtime.js";\n',
        "src/example/unknown.ts": "export const value = 1;\n",
        ...(withConfigConsumer
          ? {
              "scripts/actionlint-reader.mts":
                'export const config = new URL("../.github/actionlint.yaml", import.meta.url);\n',
              "src/example/actionlint-reader.test.ts":
                'import "../../scripts/actionlint-reader.mts";\n',
            }
          : {}),
      };
      for (const [file, source] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        writeFileSync(path.join(cwd, file), source);
      }
      materializeGatewayCallsitesFixture(cwd);
      const reasons: string[] = [];
      const shards = createChangedNodeTestShards(
        [".github/actionlint.yaml", "src/example/runtime.ts"],
        { cwd, onFallback: (reason) => reasons.push(reason) },
      );
      expect(shards, reasons.join("\n")).not.toBeNull();
      const runtimeOwners = ["src/example/runtime-consumer.test.ts", gatewayCallsitesGuard];
      const configReader = "src/example/actionlint-reader.test.ts";
      expect(selectedFiles(shards).toSorted()).toEqual(
        [...runtimeOwners, ...(withConfigConsumer ? [configReader] : [])].toSorted(),
      );
      expect(selectedFiles(shards).includes(configReader)).toBe(withConfigConsumer);
      const unknown = createChangedNodeTestShards(
        [".github/actionlint.yaml", "src/example/unknown.ts"],
        { cwd },
      );
      expect(unknown).not.toBeNull();
      expect(selectedFiles(unknown).toSorted()).toEqual(
        [...runtimeOwners, ...(withConfigConsumer ? [configReader] : [])].toSorted(),
      );
      if (withConfigConsumer) {
        const directHelper = createChangedNodeTestShards(["scripts/actionlint-reader.mts"], {
          cwd,
        });
        expect(directHelper).not.toBeNull();
        expect(selectedFiles(directHelper)).toEqual([configReader]);
      }
    }
  });

  it("keeps mixed native changes with concrete readers independently of native jobs", () => {
    const swift = "apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift";
    const android = "apps/android/app/src/main/java/Example.kt";
    const runtime = "src/example/runtime.ts";
    const runtimeConsumer = "src/example/runtime-consumer.test.ts";
    const sourceReader = "src/example/native-source-reader.test.ts";
    for (const withSourceReader of [false, true]) {
      const cwd = argvTempDirs.make("changed-native-consumers-");
      const files = {
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
      };
      for (const [file, source] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        writeFileSync(path.join(cwd, file), source);
      }
      materializeGatewayCallsitesFixture(cwd);
      const dedicatedNativeChecks = { macos: true, ios: true, android: true };
      const reasons: string[] = [];
      const options = {
        cwd,
        dedicatedNativeChecks,
        onFallback: (reason: string) => reasons.push(reason),
      };
      const expected = [
        runtimeConsumer,
        gatewayCallsitesGuard,
        ...(withSourceReader ? [sourceReader] : []),
      ].toSorted();
      const shards = createChangedNodeTestShards([swift, android, runtime], options);
      expect(shards, reasons.join("\n")).not.toBeNull();
      expect(selectedFiles(shards).toSorted()).toEqual(expected);
      expect(createChangedNodeTestShards([swift, android, runtime], { cwd })).toEqual(shards);
      expect(
        createChangedNodeTestShards(
          [swift, android, runtime, "apps/unknown/Example.swift"],
          options,
        ),
      ).toEqual(shards);
      if (withSourceReader) {
        const readerOwned = createChangedNodeTestShards([swift, runtime], { cwd });
        expect(readerOwned).not.toBeNull();
        expect(selectedFiles(readerOwned).toSorted()).toEqual(expected);
      } else {
        for (const missing of ["macos", "ios", "android"] as const) {
          expect(
            createChangedNodeTestShards([swift, android, runtime], {
              cwd,
              dedicatedNativeChecks: { ...dedicatedNativeChecks, [missing]: false },
            }),
            missing,
          ).toEqual(shards);
        }
      }
    }
  });

  it("routes the native source inventory to both readers in a mixed Android PR", () => {
    const changedPaths = [
      "apps/.i18n/native-source.json",
      "apps/android/README.md",
      "apps/android/app/src/main/java/ai/openclaw/app/MainViewModel.kt",
      "apps/android/app/src/main/java/ai/openclaw/app/NodeRuntime.kt",
      "apps/android/app/src/main/java/ai/openclaw/app/ui/chat/ChatRealtimeTalk.kt",
      "apps/android/app/src/main/java/ai/openclaw/app/ui/chat/ChatScreen.kt",
      "apps/android/app/src/main/java/ai/openclaw/app/voice/TalkModeManager.kt",
      "apps/android/app/src/test/java/ai/openclaw/app/ui/chat/ChatComposerLayoutTest.kt",
      "apps/android/app/src/test/java/ai/openclaw/app/voice/TalkModeManagerTest.kt",
    ];
    const onFallback = vi.fn();
    const dedicatedNativeChecks = { macos: false, ios: false, android: true };
    const shards = createChangedNodeTestShards(changedPaths, {
      dedicatedNativeChecks,
      includeReleaseOnlyToolingShards: false,
      onFallback,
    });
    expect(onFallback).not.toHaveBeenCalled();
    expect(shards).not.toBeNull();
    const files = selectedFiles(shards);
    expect(files.filter((file) => file === "test/scripts/android-app-i18n.test.ts")).toHaveLength(
      1,
    );
    expect(files.filter((file) => file === "test/scripts/apple-app-i18n.test.ts")).toHaveLength(1);
    expect(files).toHaveLength(2);
    expect(
      createChangedNodeTestShards([...changedPaths, "apps/.i18n/unowned.json"], {
        dedicatedNativeChecks,
      }),
    ).toEqual(shards);
    expect(
      createChangedNodeTestShards(changedPaths, {
        dedicatedNativeChecks: { ...dedicatedNativeChecks, android: false },
      }),
    ).toEqual(shards);
  });

  it.each([
    {
      changedPath: "src/auto-reply/reply/abort.test.ts",
      expected: ["test/scripts/tsgo-core-test-shards.test.ts"],
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
          includeReleaseOnlyToolingShards: false,
          includeReleaseOnlyRuntimeTests: false,
          onFallback: (reason) => reasons.push(reason),
        });
        expect(shards, reasons.join("\n")).not.toBeNull();
        const files = selectedFiles(shards);
        for (const guard of expected) {
          expect(files.filter((file) => file === guard)).toHaveLength(1);
        }
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
    const cwd = argvTempDirs.make("changed-extension-scanner-");
    const source = "extensions/example/src/runtime.ts";
    const importer = "src/infra/extension-consumer.test.ts";
    for (const [file, content] of [
      [source, "export {};\n"],
      [importer, `import "../../${source}";\n`],
      [gatewayCallsitesGuard, "export {};\n"],
    ] as const) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), content);
    }
    const shards = createChangedNodeTestShards([source], { cwd });
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards).toSorted()).toEqual([gatewayCallsitesGuard, importer].toSorted());
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
    const cwd = argvTempDirs.make("changed-alias-consumers-");
    const target = "src/infra/alias-consumer.test.ts";
    for (const [file, source] of [
      [fixture.source, "export const value = 1;\n"],
      [fixture.manifest, JSON.stringify(fixture.document)],
      [target, `import "${fixture.specifier}";\n`],
      ["src/infra/unrelated.test.ts", "export {};\n"],
    ] as const) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), source);
    }
    materializeGatewayCallsitesFixture(cwd);
    const shards = createChangedNodeTestShards([fixture.source], { cwd });
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards).toSorted()).toEqual(
      (fixture.source.startsWith("src/") ? [target, gatewayCallsitesGuard] : [target]).toSorted(),
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

  it("keeps targeting when a diff only deletes test files alongside live source", () => {
    const shards = createChangedNodeTestShards([
      "src/agents/deleted-obsolete.test.ts",
      "src/agents/live-provider-owner.ts",
    ]);
    expect(shards).not.toBeNull();
    const targets = selectedFiles(shards);
    expect(targets).toContain("src/agents/live-model-filter.test.ts");
  });

  it.each(["src/gone.test.ts", "src/plugin-sdk/gone.test.ts"])(
    "runs only the boundary shard when a diff deletes %s",
    (target) => {
      const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ci-deleted-test-"));
      try {
        expect(createChangedExtensionFallbackShards([target], { cwd })).toEqual([]);
        expect(createChangedNodeTestShards([target], { cwd })).toEqual([
          {
            checkName: "checks-node-changed-boundary",
            configs: ["test/vitest/vitest.boundary.config.ts"],
            requiresDist: false,
            runner: "blacksmith-8vcpu-ubuntu-2404",
            shardName: "changed-boundary",
          },
        ]);
      } finally {
        rmSync(cwd, { force: true, recursive: true });
      }
    },
  );

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
});
