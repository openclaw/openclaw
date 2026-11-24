import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import { resolveConfig } from "vitest/node";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  createUiRealGatewayTestShards,
  createUiTestShardGroups,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { resolveRunVitestSpawnEnv } from "../../scripts/lib/vitest-process-env.mts";
import { createPrebuiltUiE2eVitestConfig } from "../vitest/vitest.ui-e2e-prebuilt.config.ts";
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
const frozenRealGatewayFiles = [
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
