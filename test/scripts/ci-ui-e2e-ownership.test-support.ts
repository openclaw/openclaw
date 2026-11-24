import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as ts from "typescript/ast";
import { expect } from "vitest";
import { resolveConfig } from "vitest/node";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  createUiRealGatewayTestShards,
  createUiTestShardGroups,
} from "../../scripts/lib/ci-node-test-plan.mts";
import type { NativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { resolveRunVitestSpawnEnv } from "../../scripts/lib/vitest-process-env.mts";
import { sharedVitestConfig } from "../vitest/vitest.shared.config.ts";
import { createPrebuiltUiE2eVitestConfig } from "../vitest/vitest.ui-e2e-prebuilt.config.ts";
import {
  createUiE2eVitestConfig,
  uiE2ePrivateServerTestFiles,
  uiE2eRuntimeBudgetTestFile,
  uiE2eSerialTestFiles,
} from "../vitest/vitest.ui-e2e.config.ts";
import { uiE2eRealGatewayTestFiles } from "../vitest/vitest.ui-paths.mjs";
import {
  evaluateWorkflow as evaluateWorkflowExpression,
  expectExcludes,
  readCiWorkflow,
  requiredWorkflowStep,
  runWorkflowShellScript,
  testNodeExecPath,
  writeExecutable,
} from "./ci-workflow.test-support.js";

export async function assertControlUiE2eOwnership(
  makeTempDirectory: (prefix: string) => string,
  parser: NativeTypeScriptParser,
): Promise<void> {
  const trackedUiE2eFiles = execFileSync(
    "git",
    [
      "ls-files",
      "--",
      ":(glob)ui/src/**/*.e2e.test.ts",
      ":(glob)extensions/*/browser/**/*.e2e.test.ts",
      "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
      "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
      "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
      "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .toSorted();
  const privateServerFiles = trackedUiE2eFiles.filter((file) => {
    const source = readFileSync(file, "utf8");
    const visit = (node: ts.Node, inSuiteServer = false): boolean => {
      if (ts.isCallExpression(node)) {
        const callName = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : undefined;
        // A Gateway or Vite proxy acquired by the suite owns its UI server;
        // a separate backend in a test can still use the shared UI bundle.
        const buildInfo = node.arguments[1];
        if (
          callName === "createGatewayHttpServer" ||
          (inSuiteServer &&
            [
              "createOpenClawTestInstance",
              "createChatGatewayInstance",
              "createBackgroundWorkInstance",
              "createDesktopResizeProxy",
              "createWaitClockInstance",
              "startBuiltControlUiE2eServer",
              "startProductionControlUiE2eServer",
              "startProviderBrowserLoginFixture",
              "createServer",
            ].includes(callName ?? "")) ||
          callName === "createQuotaResetFixture" ||
          (callName === "createSessionManagementE2eSuite" &&
            node.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword) ||
          (callName === "createSidebarFooterProofSuite" &&
            buildInfo !== undefined &&
            !(ts.isIdentifier(buildInfo) && buildInfo.text === "undefined"))
        ) {
          return true;
        }
        const options = node.arguments[0];
        if (
          callName === "createControlUiE2eSuite" &&
          options &&
          ts.isObjectLiteralExpression(options)
        ) {
          for (const property of options.properties) {
            if (
              (ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property)) &&
              (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
              property.name.text === "startServer" &&
              visit(property, true)
            ) {
              return true;
            }
          }
        }
      }
      return node.forEachChild((child) => visit(child, inSuiteServer)) ?? false;
    };
    return (
      /\bsource:\s*true\b/u.test(source) ||
      /\bstartControlUiE2eServer\(\s*\{/u.test(source) ||
      visit(parser.parseSourceFile(file, source))
    );
  });

  expect(privateServerFiles).toEqual(uiE2ePrivateServerTestFiles);
  expect(uiE2eRealGatewayTestFiles).toEqual(
    expect.arrayContaining(
      trackedUiE2eFiles.filter((file) => file.endsWith(".real-gateway.e2e.test.ts")),
    ),
  );
  expect(uiE2eRealGatewayTestFiles.every((file) => uiE2eSerialTestFiles.includes(file))).toBe(true);
  expect(uiE2eSerialTestFiles).toContain(uiE2eRuntimeBudgetTestFile);

  const config = await resolveConfig({ config: false }, createUiE2eVitestConfig({}, []));
  const relativeGlobalSetup = (files: string | string[]) =>
    (Array.isArray(files) ? files : [files]).map((file) =>
      path.relative(process.cwd(), file).split(path.sep).join("/"),
    );
  const projectsOf = (value: typeof config) =>
    value.test.resolvedProjects.map(({ viteConfig, projectConfig }) => ({
      cacheDir: viteConfig.cacheDir,
      test: {
        ...projectConfig,
        globalSetup: relativeGlobalSetup(projectConfig.globalSetup),
      },
    }));
  const projects = projectsOf(config);
  const selectedFiles = (test: { exclude: string[]; include: string[] }) =>
    globSync(test.include, { cwd: process.cwd(), exclude: test.exclude }).toSorted();
  const select = (value: typeof config) => projectsOf(value).map(({ test }) => selectedFiles(test));
  const rootTest = config.test as { exclude: string[]; include: string[] };
  const nodePolicySetup = "test/vitest/vitest.node-policy.global-setup.ts";
  expect(relativeGlobalSetup(config.test.globalSetup)).toEqual([nodePolicySetup]);
  const chromiumSetup = "test/vitest/vitest.ui-e2e.global-setup.ts";
  const bundledSetup = "test/vitest/vitest.ui-e2e.bundled.global-setup.ts";
  expect(projects.map(({ test }) => [test.name, test.globalSetup])).toEqual([
    ["ui-e2e-bundled", [chromiumSetup, bundledSetup, nodePolicySetup]],
    ["ui-e2e-standalone", [chromiumSetup, nodePolicySetup]],
    ["ui-e2e-serial", [chromiumSetup, bundledSetup, nodePolicySetup]],
    ["ui-e2e-serial-standalone", [chromiumSetup, nodePolicySetup]],
  ]);
  expect(new Set(projects.map((project) => project.cacheDir)).size).toBe(projects.length);
  expect(config.test?.maxWorkers).toBe(Math.min(2, sharedVitestConfig.test.maxWorkers));
  for (const project of projects.slice(0, 2)) {
    expect(project.test).toMatchObject({
      fileParallelism: sharedVitestConfig.test.fileParallelism,
      maxWorkers: config.test?.maxWorkers,
      sequence: { groupOrder: 0 },
    });
  }
  for (const project of projects.slice(2)) {
    expect(project.test).toMatchObject({
      exclude: expect.not.arrayContaining(uiE2eRealGatewayTestFiles),
      fileParallelism: false,
      maxWorkers: 1,
      sequence: { groupOrder: 1 },
    });
  }
  expect(projects[0]?.test.exclude).toEqual(expect.arrayContaining(uiE2eSerialTestFiles));
  const realGateway = new Set(uiE2eRealGatewayTestFiles);
  const ordinary = trackedUiE2eFiles.filter((file) => !realGateway.has(file));
  const serial = new Set(uiE2eSerialTestFiles);
  const assertPartition = (selection: string[][], files: string[]) => {
    expect(selection.slice(0, 2).flat().toSorted()).toEqual(
      files.filter((file) => !serial.has(file)),
    );
    expect(selection.slice(2).flat().toSorted()).toEqual(files.filter((file) => serial.has(file)));
    expect(selection.flat().toSorted()).toEqual(files);
  };
  const localSelected = select(config);
  const readonlyHome = "ui/src/e2e/home-readonly.real-gateway.e2e.test.ts";
  expect(localSelected[2]).toContain(readonlyHome);
  expect(selectedFiles(rootTest)).toEqual(trackedUiE2eFiles);
  assertPartition(localSelected, trackedUiE2eFiles);
  expect(localSelected.slice(2).flat().toSorted()).toEqual(uiE2eSerialTestFiles);
  expect(localSelected[1]).toEqual([
    "ui/src/e2e/board-fixture.e2e.test.ts",
    "ui/src/e2e/boot-module-boundaries.e2e.test.ts",
    "ui/src/e2e/control-ui-build-publication.e2e.test.ts",
    "ui/src/e2e/control-ui-stale-build-reload.e2e.test.ts",
    "ui/src/e2e/gateway-fresh-visit.http.e2e.test.ts",
    "ui/src/e2e/phone-stale-build-recovery.e2e.test.ts",
    "ui/src/e2e/post-deploy-session-entry.e2e.test.ts",
    "ui/src/e2e/service-worker-update.e2e.test.ts",
    "ui/src/e2e/template-chat-review.e2e.test.ts",
    "ui/src/lib/openclaw-id/onepassword-save.retention.e2e.test.ts",
  ]);
  expect(localSelected[3]).toEqual(
    uiE2ePrivateServerTestFiles.filter((file) => uiE2eSerialTestFiles.includes(file)),
  );
  // Keep packaged asset proof on the production bundle and source proof on its own server.
  expect(localSelected[0]).toContain("ui/src/e2e/memory-overview-plugin.e2e.test.ts");
  expect(localSelected[3]).toContain("ui/src/e2e/memory-overview-source.e2e.test.ts");

  const ordinaryConfig = await resolveConfig(
    { config: false },
    createUiE2eVitestConfig({ OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1" }, []),
  );
  const ordinarySelected = select(ordinaryConfig);
  expect(ordinarySelected.flat()).not.toContain(readonlyHome);
  expect(selectedFiles(ordinaryConfig.test as typeof rootTest)).toEqual(ordinary);
  assertPartition(ordinarySelected, ordinary);

  const productionArtifactFiles = [
    "ui/src/e2e/gateway-fresh-visit.http.e2e.test.ts",
    "ui/src/e2e/phone-stale-build-recovery.e2e.test.ts",
    "ui/src/e2e/service-worker-update.e2e.test.ts",
    "ui/src/e2e/template-chat-review.e2e.test.ts",
  ];
  const delegated = await resolveConfig(
    { config: false },
    createUiE2eVitestConfig(
      { OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1", OPENCLAW_UI_E2E_SKIP_PRODUCTION_ARTIFACT: "1" },
      [],
    ),
  );
  assertPartition(
    select(delegated),
    ordinary.filter((file) => !productionArtifactFiles.includes(file)),
  );
  const production = await resolveConfig(
    { config: false },
    createUiE2eVitestConfig(
      { OPENCLAW_UI_E2E_PRODUCTION_ARTIFACT_ROOT: "/fixture/production-ui" },
      [],
    ),
  );
  expect(select(production)).toEqual([[], productionArtifactFiles, [], []]);

  // The packaged delivery proof needs the runtime build owned by the prebuilt lane.
  const packagedWorkboard = "ui/src/pages/workboard/workboard-distribution.e2e.test.ts";
  expect(ordinarySelected.flat()).not.toContain(packagedWorkboard);
  const prebuilt = await resolveConfig(
    { config: false },
    createPrebuiltUiE2eVitestConfig({}, ["node", "vitest", packagedWorkboard]),
  );
  expect(
    projectsOf(prebuilt)
      .map((project) => ({ name: project.test.name, files: selectedFiles(project.test) }))
      .filter((project) => project.files.length > 0),
  ).toEqual([{ name: "ui-e2e-real-gateway-standalone", files: [packagedWorkboard] }]);
  expect(
    createUiRealGatewayTestShards(createUiTestShardGroups({ uiE2eFiles: [packagedWorkboard] }).e2e)
      .flatMap((shard) => shard.groups.flatMap((group) => group.includePatterns))
      .filter((file) => file === packagedWorkboard),
  ).toEqual([packagedWorkboard]);
  expect(
    createUiRealGatewayTestShards(createUiTestShardGroups({ uiE2eFiles: [readonlyHome] }).e2e)
      .flatMap((shard) => shard.groups.flatMap((group) => group.includePatterns))
      .filter((file) => file === readonlyHome),
  ).toEqual([readonlyHome]);

  const bundledFile = expectDefined(ordinarySelected[0]?.[0], "bundled Control UI E2E file");
  const serialFile = expectDefined(ordinarySelected[3]?.[0], "serial Control UI E2E file");
  expect(
    select(
      await resolveConfig(
        { config: false },
        createUiE2eVitestConfig({}, ["node", "vitest", serialFile]),
      ),
    ),
  ).toEqual([[], [], [], [serialFile]]);

  const includeDir = makeTempDirectory("openclaw-ui-e2e-project-includes-");
  const includeFile = path.join(includeDir, "include.json");
  writeFileSync(includeFile, JSON.stringify([bundledFile, serialFile]));
  const includeEnv = {
    OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1",
    OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
  };
  const selectIncludeFile = async () =>
    select(await resolveConfig({ config: false }, createUiE2eVitestConfig(includeEnv, [])));
  expect(await selectIncludeFile()).toEqual([[bundledFile], [], [], [serialFile]]);

  writeFileSync(includeFile, JSON.stringify(["ui/src/e2e/*.e2e.test.ts"]));
  const globSelected = (await selectIncludeFile()).flat();
  const expectedGlobFiles = ordinary.filter((file) =>
    path.matchesGlob(file, "ui/src/e2e/*.e2e.test.ts"),
  );
  expect(globSelected.toSorted()).toEqual(expectedGlobFiles);
}

export async function assertRealGatewayWorkflowSelection(
  makeTempDirectory: (prefix: string) => string,
  {
    frozen,
    prebuilt,
    childExit,
    releaseTier,
    sharded,
  }: {
    frozen: boolean;
    prebuilt: boolean;
    childExit: number;
    releaseTier?: boolean;
    sharded?: boolean;
  },
): Promise<void> {
  const step = requiredWorkflowStep(
    readCiWorkflow().jobs["checks-ui-e2e-real-gateway"].steps,
    "Test Control UI suites with a real Gateway",
  );
  const directory = makeTempDirectory("openclaw-real-gateway-command-");
  const bin = path.join(directory, "bin");
  const prebuiltConfig = "test/vitest/vitest.ui-e2e-prebuilt.config.ts";
  const serialConfig = "test/vitest/vitest.ui-e2e.config.ts";
  mkdirSync(bin);
  mkdirSync(path.join(directory, "test/vitest"), { recursive: true });
  writeFileSync(path.join(directory, serialConfig), "export default {};\n");
  if (prebuilt) {
    writeFileSync(path.join(directory, prebuiltConfig), "export default {};\n");
  }
  mkdirSync(path.join(directory, "scripts/lib"), { recursive: true });
  copyFileSync(
    "scripts/lib/ci-node-test-groups-codec.mts",
    path.join(directory, "scripts/lib/ci-node-test-groups-codec.mts"),
  );
  writeExecutable(path.join(bin, "node"), [
    "#!/bin/sh",
    'if [ "$1" = "--import" ]; then shift; shift; if [ "$1" != "scripts/test-ui-real-gateway.mts" ]; then exec "$REAL_GATEWAY_NODE" "$@"; fi; fi',
    'printf "%s\\n" "$@" > "$REAL_GATEWAY_COMMAND_ARGS"',
    'printf "%s" "${OPENCLAW_VITEST_INCLUDE_FILE:-}" > "$REAL_GATEWAY_INCLUDE_PATH"',
    'printf "called\\n" >> "$REAL_GATEWAY_COMMAND_CALLS"',
    'exit "$REAL_GATEWAY_COMMAND_EXIT"',
  ]);
  const desktop = "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts";
  const groups =
    releaseTier === undefined
      ? undefined
      : createUiTestShardGroups({ includeReleaseOnlyTests: releaseTier }).e2e;
  const rows =
    groups && !frozen && sharded !== false
      ? createUiRealGatewayTestShards(groups)
      : [{ shard: 1, shard_count: 1, run_desktop: true, groups }];
  const selectedFiles: string[] = [];
  for (const row of rows) {
    const rowDirectory = path.join(directory, String(row.shard));
    mkdirSync(rowDirectory);
    const argsPath = path.join(rowDirectory, "args");
    const callsPath = path.join(rowDirectory, "calls");
    const includePath = path.join(rowDirectory, "include-path");
    const context = {
      eventName: "push" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      matrix: {
        ...row,
        test_groups_gzip_base64: row.groups ? encodeNodeTestGroups(row.groups) : "",
      },
      preflightOutputs: {
        frozen_target: String(frozen),
        ui_e2e_test_groups_gzip_base64: groups ? encodeNodeTestGroups(groups) : "",
      },
    };
    const result = runWorkflowShellScript(expectDefined(step.run, "real-Gateway script"), {
      linuxWorkflow: true,
      cwd: directory,
      env: {
        ...process.env,
        FROZEN_TARGET: String(evaluateWorkflowExpression(step.env.FROZEN_TARGET, context)),
        RUNNER_TEMP: rowDirectory,
        REAL_GATEWAY_NODE: testNodeExecPath,
        OPENCLAW_VITEST_INCLUDE_FILE: "",
        REAL_GATEWAY_INCLUDE_PATH: includePath,
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: String(
          evaluateWorkflowExpression(step.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64, context),
        ),
        REAL_GATEWAY_COMMAND_ARGS: argsPath,
        REAL_GATEWAY_COMMAND_CALLS: callsPath,
        REAL_GATEWAY_COMMAND_EXIT: String(childExit),
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    const missingCurrentConfig = !prebuilt && !frozen;
    expect(result.status, result.stdout + result.stderr).toBe(missingCurrentConfig ? 1 : childExit);
    if (missingCurrentConfig) {
      expect(result.stderr).toContain(`Current target is missing ${prebuiltConfig}`);
      expect(existsSync(callsPath)).toBe(false);
      return;
    }
    expect(readFileSync(callsPath, "utf8").trim().split("\n")).toEqual(["called"]);
    const args = readFileSync(argsPath, "utf8").trim().split("\n");
    const reporterArgs = frozen
      ? []
      : [
          "--reporter",
          "verbose",
          "--reporter",
          "github-actions",
          "--reporter",
          "default",
          "--reporter",
          "./scripts/lib/vitest-resource-reporter.mts",
        ];
    if (frozen) {
      expect(args.slice(0, 6)).toEqual([
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        prebuilt ? prebuiltConfig : serialConfig,
        "--configLoader",
        "runner",
      ]);
      expect(args.slice(6).toSorted()).toEqual(
        prebuilt ? ["--exclude", desktop] : frozenRealGatewayFiles.toSorted(),
      );
    } else {
      expect(args).toEqual(["scripts/test-ui-real-gateway.mts", ...reporterArgs]);
    }
    const selectedConfig = createPrebuiltUiE2eVitestConfig(
      { OPENCLAW_VITEST_INCLUDE_FILE: readFileSync(includePath, "utf8") },
      [testNodeExecPath, ...args],
    );
    selectedFiles.push(
      ...(await resolveConfig({ config: false }, selectedConfig)).test.include.filter(
        (file) => file !== desktop,
      ),
    );
    if (frozen) {
      expect(
        resolveRunVitestSpawnEnv(
          { CI: "true", OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000" },
          args.slice(1),
        ).OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS,
      ).toBe("300000");
    }
  }
  expect(new Set(selectedFiles).size).toBe(selectedFiles.length);
  expect(selectedFiles.toSorted()).toEqual(
    (prebuilt ? uiE2eRealGatewayTestFiles : frozenRealGatewayFiles)
      .filter(
        (file) =>
          file !== desktop &&
          (!groups ||
            groups.some((group) => !group.includePatterns || group.includePatterns.includes(file))),
      )
      .toSorted(),
  );
  if (releaseTier === false) {
    expect(selectedFiles).toHaveLength(uiE2eRealGatewayTestFiles.length - 13);
    expectExcludes(selectedFiles, [
      "ui/src/e2e/cron-duration-save.real-gateway.e2e.test.ts",
      "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
      "ui/src/e2e/chat-reconnect-continuity.real-gateway.e2e.test.ts",
      "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
    ]);
  }
}

// Historical fallback for frozen targets predating prebuilt E2E config.
// Intentionally independent of the current real-Gateway inventory.
export const frozenRealGatewayFiles = [
  "ui/src/e2e/mcp-app-conformance.e2e.test.ts",
  "ui/src/e2e/control-ui-auth-transports.e2e.test.ts",
  "ui/src/e2e/usage-sessions-owner-attribution.e2e.test.ts",
  "ui/src/e2e/profile-page.real-gateway.e2e.test.ts",
  "ui/src/e2e/quota-reset-status.real-gateway.e2e.test.ts",
  "ui/src/e2e/logs-lifecycle.e2e.test.ts",
  "ui/src/e2e/activity-run-inspector.real-gateway.e2e.test.ts",
  "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-collaborator-scroll.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-composer-websearch-kill-switch.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-flow.catalog-bootstrap.e2e.test.ts",
  "ui/src/e2e/chat-agent-avatar.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-loading-performance.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-project-media.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-reconnect-continuity.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-stop-finished-run.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-thinking-metadata.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-tts-supplement.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-widget-sandbox.real-gateway.e2e.test.ts",
  "ui/src/e2e/command-palette-catalog.real-gateway.e2e.test.ts",
  "ui/src/e2e/command-palette-search.real-gateway.e2e.test.ts",
  "ui/src/e2e/cron-duration-save.real-gateway.e2e.test.ts",
  "ui/src/e2e/model-api-keys.real-gateway.e2e.test.ts",
  "ui/src/e2e/model-catalog-partial-refresh.real-gateway.e2e.test.ts",
  "ui/src/e2e/model-picker-search.real-gateway.e2e.test.ts",
  "ui/src/e2e/provider-browser-login.real-gateway.e2e.test.ts",
  "ui/src/e2e/device-alias-rename.real-gateway.e2e.test.ts",
  "ui/src/e2e/device-platform-family.real-gateway.e2e.test.ts",
  "ui/src/e2e/session-roster-request-rate.real-gateway.e2e.test.ts",
  "ui/src/e2e/session-pr-reader-lifetime.real-gateway.e2e.test.ts",
  "ui/src/e2e/session-progress-hovercard.real-gateway.e2e.test.ts",
  "ui/src/e2e/worker-initial-setup.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
] as const;
