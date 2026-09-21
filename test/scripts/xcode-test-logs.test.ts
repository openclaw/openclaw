import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/lib/swift-toolchain.sh");

describe.skipIf(process.platform === "win32")("Apple command log spool", () => {
  it.each([0, 65])(
    "retains complete file output and exit %s with a bounded console tail",
    (code) => {
      const root = tempDirs.make("openclaw-xcode-test-logs-");
      const bin = path.join(root, "tools with spaces");
      const log = path.join(root, "results with spaces", "test.log");
      const trace = path.join(root, "trace.json");
      const args = ["test", "-scheme", "Scheme With Spaces", "-only-testing:Tests/cleanup"];
      mkdirSync(bin);
      const executable = path.join(bin, "apple-command-fixture");
      writeFileSync(
        executable,
        `#!/usr/bin/env node
const fs = require("node:fs");
const regularFiles = [1, 2].every((fd) => fs.fstatSync(fd).isFile());
fs.writeFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ regularFiles, args: process.argv.slice(2) }));
if (!regularFiles) process.exit(99);
fs.writeSync(1, "STDOUT_START\\n" + "o".repeat(200000) + "\\nSTDOUT_END\\n");
fs.writeSync(2, "STDERR_START\\n" + "e".repeat(200000) + "\\nSTDERR_END\\n");
process.exit(${code});
`,
      );
      chmodSync(executable, 0o755);

      const result = spawnSync(
        "/bin/bash",
        [
          "-euo",
          "pipefail",
          "-c",
          'source "$1"; shift; run_apple_command_logged "$@"',
          "fixture",
          helper,
          log,
          executable,
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 20_000,
          env: {
            ...process.env,
            FIXTURE_TRACE: trace,
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(code);
      expect(JSON.parse(readFileSync(trace, "utf8"))).toEqual({ regularFiles: true, args });
      expect(readFileSync(log, "utf8")).toBe(
        `STDOUT_START\n${"o".repeat(200000)}\nSTDOUT_END\nSTDERR_START\n${"e".repeat(200000)}\nSTDERR_END\n`,
      );
      expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThan(9000);
      expect(result.stdout).toContain("STDERR_END");
      expect(result.stdout).toContain(`[apple-command] Exit ${code}; full log: ${log}`);
    },
  );
});

it("routes each iOS simulator test through workflow-owned log capture and retains failure evidence", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<
      string,
      { steps: { name: string; run?: string; if?: string; with?: { path?: string } }[] }
    >;
  };
  const steps = workflow.jobs["ios-build"].steps;
  for (const [name, logPaths] of [
    ["Run focused iOS voice cleanup simulator tests", ["OpenClawVoiceCleanupTests.log"]],
    [
      "Run focused iOS lifecycle simulator tests",
      ["${result_bundle%.xcresult}.log", "OpenClawWatchDeliveryUITests.log"],
    ],
    [
      "Run focused Apple Watch operation simulator tests",
      ["OpenClawWatchBuild.log", "OpenClawWatchOperationTests.log"],
    ],
  ] as const) {
    const run = steps.find((step) => step.name === name)?.run;
    expect(run, name).toContain("source .ci-harness/scripts/lib/swift-toolchain.sh");
    expect(run?.match(/\brun_apple_command_logged\b/gu), name).toHaveLength(logPaths.length);
    expect(run?.match(/\brun_apple_command_logged [^\n]+ xcodebuild \\/gu), name).toHaveLength(
      logPaths.length,
    );
    for (const logPath of logPaths) expect(run, name).toContain(logPath);
    // The Watch product-path query must keep its JSON output contract.
    expect(run?.match(/^\s*xcodebuild /gmu) ?? [], name).toHaveLength(
      name.includes("Apple Watch") ? 1 : 0,
    );
    if (name.includes("Apple Watch")) expect(run).toContain("-showBuildSettings -json |");
  }

  const upload = steps.find((step) => step.name === "Upload iOS lifecycle simulator evidence");
  expect(upload?.if).toContain("always()");
  expect(upload?.with?.path?.trim().split("\n")).toEqual([
    "apps/ios/build/LifecycleTestResults/*.xcresult",
    "apps/ios/build/LifecycleTestResults/*.log",
  ]);
});
