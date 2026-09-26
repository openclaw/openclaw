import { execFileSync } from "node:child_process";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as ts from "typescript/unstable/ast";
import { expect } from "vitest";
import type { NativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { sharedVitestConfig } from "../vitest/vitest.shared.config.ts";
import {
  createUiE2eVitestConfig,
  uiE2ePrivateServerTestFiles,
  uiE2eRuntimeBudgetTestFile,
  uiE2eSerialTestFiles,
} from "../vitest/vitest.ui-e2e.config.ts";
import { uiE2eRealGatewayTestFiles } from "../vitest/vitest.ui-paths.mjs";

/** Verify private-server discovery, serial ownership, and exact E2E selection. */
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
  const helperPrivateServerFiles = trackedUiE2eFiles.filter((file) => {
    const sourceFile = parser.parseSourceFile(file, readFileSync(file, "utf8"));
    let ownsPrivateServer = false;
    const visit = (node: ts.Node, inSuiteServer = false) => {
      if (ownsPrivateServer) {
        return;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        // A Gateway or Vite proxy acquired by the suite owns its UI server;
        // a separate backend in a test can still use the shared UI bundle.
        if (
          inSuiteServer &&
          (node.expression.text === "createOpenClawTestInstance" ||
            node.expression.text === "startBuiltControlUiE2eServer" ||
            node.expression.text === "startProductionControlUiE2eServer" ||
            node.expression.text === "startProviderBrowserLoginFixture" ||
            node.expression.text === "createServer")
        ) {
          ownsPrivateServer = true;
          return;
        }
        const options = node.arguments[0];
        if (
          node.expression.text === "createControlUiE2eSuite" &&
          options &&
          ts.isObjectLiteralExpression(options)
        ) {
          for (const property of options.properties) {
            if (
              (ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property)) &&
              (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
              property.name.text === "startServer"
            ) {
              visit(property, true);
            }
          }
        }
        if (
          node.expression.text === "createQuotaResetFixture" ||
          (node.expression.text === "createSessionManagementE2eSuite" &&
            node.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword)
        ) {
          ownsPrivateServer = true;
          return;
        }
        const buildInfo = node.arguments[1];
        if (
          node.expression.text === "createSidebarFooterProofSuite" &&
          buildInfo &&
          !(ts.isIdentifier(buildInfo) && buildInfo.text === "undefined")
        ) {
          ownsPrivateServer = true;
          return;
        }
      }
      node.forEachChild((child) => visit(child, inSuiteServer));
    };
    visit(sourceFile);
    return ownsPrivateServer;
  });
  const directPrivateServerFiles = trackedUiE2eFiles.filter((file) => {
    const source = readFileSync(file, "utf8");
    return /\bsource:\s*true\b/u.test(source) || /\bstartControlUiE2eServer\(\s*\{/u.test(source);
  });
  const privateServerFiles = [
    ...new Set([...directPrivateServerFiles, ...helperPrivateServerFiles]),
  ].toSorted();

  expect(privateServerFiles).toEqual(uiE2ePrivateServerTestFiles);
  expect(helperPrivateServerFiles.toSorted()).toEqual([
    "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
    "ui/src/e2e/agent-switch-roster.e2e.test.ts",
    "ui/src/e2e/chat-agent-avatar.real-gateway.e2e.test.ts",
    "ui/src/e2e/chat-collaborator-scroll.real-gateway.e2e.test.ts",
    "ui/src/e2e/chat-composer-websearch-kill-switch.real-gateway.e2e.test.ts",
    "ui/src/e2e/chat-loading-performance.real-gateway.e2e.test.ts",
    "ui/src/e2e/chat-project-media.real-gateway.e2e.test.ts",
    "ui/src/e2e/chat-stop-finished-run.real-gateway.e2e.test.ts",
    "ui/src/e2e/chat-thinking-metadata.real-gateway.e2e.test.ts",
    "ui/src/e2e/chat-tts-supplement.real-gateway.e2e.test.ts",
    "ui/src/e2e/chat-widget-sandbox.real-gateway.e2e.test.ts",
    "ui/src/e2e/child-session-load-errors.e2e.test.ts",
    "ui/src/e2e/command-palette-catalog.real-gateway.e2e.test.ts",
    "ui/src/e2e/command-palette-search.real-gateway.e2e.test.ts",
    "ui/src/e2e/cron-duration-save.real-gateway.e2e.test.ts",
    "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
    "ui/src/e2e/device-platform-family.real-gateway.e2e.test.ts",
    "ui/src/e2e/mobile-chat-session-menu.e2e.test.ts",
    "ui/src/e2e/mobile-sidebar-session-menu.e2e.test.ts",
    "ui/src/e2e/model-api-keys.real-gateway.e2e.test.ts",
    "ui/src/e2e/model-catalog-partial-refresh.real-gateway.e2e.test.ts",
    "ui/src/e2e/model-picker-search.real-gateway.e2e.test.ts",
    "ui/src/e2e/new-session-page.cloud-startup.runtime-load.e2e.test.ts",
    "ui/src/e2e/provider-browser-login.real-gateway.e2e.test.ts",
    "ui/src/e2e/quota-reset-status.real-gateway.e2e.test.ts",
    "ui/src/e2e/session-management.delete.e2e.test.ts",
    "ui/src/e2e/session-mention-involvement.e2e.test.ts",
    "ui/src/e2e/session-roster-request-rate.real-gateway.e2e.test.ts",
    "ui/src/e2e/sidebar-account-footer.e2e.test.ts",
    "ui/src/e2e/sidebar-cached-list-stability.e2e.test.ts",
  ]);
  expect(uiE2eRealGatewayTestFiles.every((file) => uiE2eSerialTestFiles.includes(file))).toBe(true);
  expect(uiE2eSerialTestFiles).toContain(uiE2eRuntimeBudgetTestFile);

  const config = createUiE2eVitestConfig({}, []);
  const projects = config.test?.projects as Array<{
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
  }>;
  const selectedFiles = (test: { exclude: string[]; include: string[] }) =>
    globSync(test.include, { cwd: process.cwd(), exclude: test.exclude }).toSorted();
  const rootTest = config.test as { exclude: string[]; include: string[] };
  expect(config.test?.globalSetup).toEqual([]);
  expect(projects.map((project) => project.test.name)).toEqual([
    "ui-e2e-bundled",
    "ui-e2e-standalone",
    "ui-e2e-serial",
    "ui-e2e-serial-standalone",
  ]);
  const chromiumSetup = "test/vitest/vitest.ui-e2e.global-setup.ts";
  const bundledSetup = "test/vitest/vitest.ui-e2e.bundled.global-setup.ts";
  expect(projects.map((project) => project.test.globalSetup)).toEqual([
    [chromiumSetup, bundledSetup],
    [chromiumSetup],
    [chromiumSetup, bundledSetup],
    [chromiumSetup],
  ]);
  expect(new Set(projects.map((project) => project.cacheDir)).size).toBe(projects.length);
  expect(config.test?.maxWorkers).toBe(Math.min(2, sharedVitestConfig.test.maxWorkers));
  expect(projects[0]?.test).toMatchObject({
    fileParallelism: sharedVitestConfig.test.fileParallelism,
    maxWorkers: undefined,
    sequence: { groupOrder: 0 },
  });
  expect(projects[1]?.test).toMatchObject({
    fileParallelism: sharedVitestConfig.test.fileParallelism,
    maxWorkers: undefined,
    sequence: { groupOrder: 0 },
  });
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
  const localSelected = projects.map((project) => selectedFiles(project.test));
  expect(selectedFiles(rootTest)).toEqual(trackedUiE2eFiles);
  expect(localSelected.slice(0, 2).flat().toSorted()).toEqual(
    trackedUiE2eFiles.filter((file) => !serial.has(file)),
  );
  expect(localSelected.slice(2).flat().toSorted()).toEqual(uiE2eSerialTestFiles);
  expect(localSelected[1]).toEqual([
    "ui/src/e2e/board-fixture.e2e.test.ts",
    "ui/src/e2e/control-ui-build-publication.e2e.test.ts",
    "ui/src/e2e/control-ui-retained-assets.e2e.test.ts",
    "ui/src/e2e/service-worker-update.e2e.test.ts",
  ]);
  expect(localSelected[3]).toEqual(uiE2ePrivateServerTestFiles);
  expect(localSelected.flat().toSorted()).toEqual(trackedUiE2eFiles);
  expect(new Set(localSelected.flat()).size).toBe(trackedUiE2eFiles.length);

  const ordinaryConfig = createUiE2eVitestConfig({ OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1" }, []);
  const ordinaryProjects = ordinaryConfig.test?.projects as typeof projects;
  const ordinarySelected = ordinaryProjects.map((project) => selectedFiles(project.test));
  expect(selectedFiles(ordinaryConfig.test as typeof rootTest)).toEqual(ordinary);
  expect(ordinarySelected.slice(0, 2).flat().toSorted()).toEqual(
    ordinary.filter((file) => !serial.has(file)),
  );
  expect(ordinarySelected.slice(2).flat().toSorted()).toEqual(
    ordinary.filter((file) => serial.has(file)),
  );
  expect(ordinarySelected.flat().toSorted()).toEqual(ordinary);
  expect(new Set(ordinarySelected.flat()).size).toBe(ordinary.length);

  const bundledFile = expectDefined(ordinarySelected[0]?.[0], "bundled Control UI E2E file");
  const serialFile = expectDefined(ordinarySelected[3]?.[0], "serial Control UI E2E file");
  const narrowedByArgv = createUiE2eVitestConfig({}, ["node", "vitest", serialFile]);
  const argvProjects = narrowedByArgv.test?.projects as typeof projects;
  expect(argvProjects.map((project) => selectedFiles(project.test))).toEqual([
    [],
    [],
    [],
    [serialFile],
  ]);

  const includeDir = makeTempDirectory("openclaw-ui-e2e-project-includes-");
  const includeFile = path.join(includeDir, "include.json");
  writeFileSync(includeFile, JSON.stringify([bundledFile, serialFile]));
  const narrowedByFile = createUiE2eVitestConfig(
    { OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1", OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
    [],
  );
  const includeProjects = narrowedByFile.test?.projects as typeof projects;
  expect(includeProjects.map((project) => selectedFiles(project.test))).toEqual([
    [bundledFile],
    [],
    [],
    [serialFile],
  ]);

  writeFileSync(includeFile, JSON.stringify(["ui/src/e2e/*.e2e.test.ts"]));
  const narrowedByGlob = createUiE2eVitestConfig(
    { OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1", OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
    [],
  );
  const globProjects = narrowedByGlob.test?.projects as typeof projects;
  const expectedGlobFiles = ordinary.filter((file) =>
    path.matchesGlob(file, "ui/src/e2e/*.e2e.test.ts"),
  );
  expect(globProjects.flatMap((project) => selectedFiles(project.test)).toSorted()).toEqual(
    expectedGlobFiles,
  );
  expect(new Set(globProjects.flatMap((project) => selectedFiles(project.test))).size).toBe(
    expectedGlobFiles.length,
  );
}
