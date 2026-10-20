import { execFileSync } from "node:child_process";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as ts from "typescript/ast";
import { expect } from "vitest";
import {
  createUiRealGatewayTestShards,
  createUiTestShardGroups,
} from "../../scripts/lib/ci-node-test-plan.mts";
import type { NativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { sharedVitestConfig } from "../vitest/vitest.shared.config.ts";
import { createPrebuiltUiE2eVitestConfig } from "../vitest/vitest.ui-e2e-prebuilt.config.ts";
import {
  createUiE2eVitestConfig,
  uiE2ePrivateServerTestFiles,
  uiE2eRuntimeBudgetTestFile,
  uiE2eSerialTestFiles,
} from "../vitest/vitest.ui-e2e.config.ts";
import { uiE2eRealGatewayTestFiles } from "../vitest/vitest.ui-paths.mjs";

export function assertControlUiE2eOwnership(
  makeTempDirectory: (prefix: string) => string,
  parser: NativeTypeScriptParser,
): void {
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
  expect(uiE2eRealGatewayTestFiles.every((file) => uiE2eSerialTestFiles.includes(file))).toBe(true);
  expect(uiE2eSerialTestFiles).toContain(uiE2eRuntimeBudgetTestFile);

  const config = createUiE2eVitestConfig({}, []);
  type Project = {
    cacheDir: string;
    test: {
      exclude: string[];
      fileParallelism: boolean;
      globalSetup?: string[];
      include: string[];
      maxWorkers?: number;
      name: string;
      sequence: { groupOrder: number };
    };
  };
  const projectsOf = (value: typeof config) => value.test?.projects as Project[];
  const projects = projectsOf(config);
  const selectedFiles = (test: { exclude: string[]; include: string[] }) =>
    globSync(test.include, { cwd: process.cwd(), exclude: test.exclude }).toSorted();
  const select = (value: typeof config) => projectsOf(value).map(({ test }) => selectedFiles(test));
  const rootTest = config.test as { exclude: string[]; include: string[] };
  expect(config.test?.globalSetup).toEqual([]);
  const chromiumSetup = "test/vitest/vitest.ui-e2e.global-setup.ts";
  const bundledSetup = "test/vitest/vitest.ui-e2e.bundled.global-setup.ts";
  expect(projects.map(({ test }) => [test.name, test.globalSetup])).toEqual([
    ["ui-e2e-bundled", [chromiumSetup, bundledSetup]],
    ["ui-e2e-standalone", [chromiumSetup]],
    ["ui-e2e-serial", [chromiumSetup, bundledSetup]],
    ["ui-e2e-serial-standalone", [chromiumSetup]],
  ]);
  expect(new Set(projects.map((project) => project.cacheDir)).size).toBe(projects.length);
  expect(config.test?.maxWorkers).toBe(Math.min(2, sharedVitestConfig.test.maxWorkers));
  for (const project of projects.slice(0, 2)) {
    expect(project.test).toMatchObject({
      fileParallelism: sharedVitestConfig.test.fileParallelism,
      maxWorkers: undefined,
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
    expect(new Set(selection.flat()).size).toBe(files.length);
  };
  const localSelected = select(config);
  expect(selectedFiles(rootTest)).toEqual(trackedUiE2eFiles);
  assertPartition(localSelected, trackedUiE2eFiles);
  expect(localSelected.slice(2).flat().toSorted()).toEqual(uiE2eSerialTestFiles);
  expect(localSelected[1]).toEqual([
    "ui/src/e2e/board-fixture.e2e.test.ts",
    "ui/src/e2e/control-ui-build-publication.e2e.test.ts",
    "ui/src/e2e/control-ui-stale-build-reload.e2e.test.ts",
    "ui/src/e2e/service-worker-update.e2e.test.ts",
  ]);
  expect(localSelected[3]).toEqual(uiE2ePrivateServerTestFiles);
  // Keep packaged asset proof on the production bundle and source proof on its own server.
  expect(localSelected[0]).toContain("ui/src/e2e/memory-overview-plugin.e2e.test.ts");
  expect(localSelected[3]).toContain("ui/src/e2e/memory-overview-source.e2e.test.ts");

  const ordinaryConfig = createUiE2eVitestConfig({ OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1" }, []);
  const ordinarySelected = select(ordinaryConfig);
  expect(selectedFiles(ordinaryConfig.test as typeof rootTest)).toEqual(ordinary);
  assertPartition(ordinarySelected, ordinary);

  // The packaged delivery proof needs the runtime build owned by the prebuilt lane.
  const packagedWorkboard = "ui/src/pages/workboard/workboard-distribution.e2e.test.ts";
  expect(ordinarySelected.flat()).not.toContain(packagedWorkboard);
  const prebuilt = createPrebuiltUiE2eVitestConfig({}, ["node", "vitest", packagedWorkboard]);
  expect(
    projectsOf(prebuilt)
      .map((project) => ({ name: project.test.name, files: selectedFiles(project.test) }))
      .filter((project) => project.files.length > 0),
  ).toEqual([{ name: "ui-e2e-serial-standalone", files: [packagedWorkboard] }]);
  expect(
    createUiRealGatewayTestShards(createUiTestShardGroups({ uiE2eFiles: [packagedWorkboard] }).e2e)
      .flatMap((shard) => shard.groups.flatMap((group) => group.includePatterns))
      .filter((file) => file === packagedWorkboard),
  ).toEqual([packagedWorkboard]);

  const bundledFile = expectDefined(ordinarySelected[0]?.[0], "bundled Control UI E2E file");
  const serialFile = expectDefined(ordinarySelected[3]?.[0], "serial Control UI E2E file");
  expect(select(createUiE2eVitestConfig({}, ["node", "vitest", serialFile]))).toEqual([
    [],
    [],
    [],
    [serialFile],
  ]);

  const includeDir = makeTempDirectory("openclaw-ui-e2e-project-includes-");
  const includeFile = path.join(includeDir, "include.json");
  writeFileSync(includeFile, JSON.stringify([bundledFile, serialFile]));
  const includeEnv = {
    OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1",
    OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
  };
  const selectIncludeFile = () => select(createUiE2eVitestConfig(includeEnv, []));
  expect(selectIncludeFile()).toEqual([[bundledFile], [], [], [serialFile]]);

  writeFileSync(includeFile, JSON.stringify(["ui/src/e2e/*.e2e.test.ts"]));
  const globSelected = selectIncludeFile().flat();
  const expectedGlobFiles = ordinary.filter((file) =>
    path.matchesGlob(file, "ui/src/e2e/*.e2e.test.ts"),
  );
  expect(globSelected.toSorted()).toEqual(expectedGlobFiles);
  expect(new Set(globSelected).size).toBe(expectedGlobFiles.length);
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
