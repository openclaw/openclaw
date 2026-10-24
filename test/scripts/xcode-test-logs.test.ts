import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/lib/swift-toolchain.sh");
const invokeHelper = 'source "$1"; shift; run_apple_command_logged "$@"';

describe.skipIf(process.platform === "win32")("Apple command log spool", () => {
  it.each([0, 65])("spools complete output and exit %s with a bounded tail", (code) => {
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
      ["-euo", "pipefail", "-c", invokeHelper, "fixture", helper, log, executable, ...args],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 20_000,
        env: { ...process.env, FIXTURE_TRACE: trace },
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
  });
});

it("routes each iOS simulator test through workflow-owned log capture and retains failure evidence", () => {
  type Step = { name: string; run?: string; if?: string; with?: { path?: string } };
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const job = workflow.jobs["ios-build"];
  if (!job) {
    throw new Error("The workflow must include the iOS build job");
  }
  const steps = job.steps;
  const step = (name: string) => steps.find((candidate) => candidate.name === name);
  for (const [scope, logPaths] of [
    ["iOS voice cleanup", ["OpenClawVoiceCleanupTests.log"]],
    ["iOS lifecycle", ["${result_bundle%.xcresult}.log", "OpenClawWatchDeliveryUITests.log"]],
    ["Apple Watch operation", ["OpenClawWatchBuild.log", "OpenClawWatchOperationTests.log"]],
  ] as const) {
    const name = `Run focused ${scope} simulator tests`;
    const run = step(name)?.run;
    const count = (pattern: RegExp) => run?.match(pattern)?.length ?? 0;
    expect(run, name).toContain("source .ci-harness/scripts/lib/swift-toolchain.sh");
    expect(count(/\brun_apple_command_logged\b/gu), name).toBe(logPaths.length);
    expect(count(/\brun_apple_command_logged [^\n]+ xcodebuild \\/gu), name).toBe(logPaths.length);
    for (const logPath of logPaths) {
      expect(run, name).toContain(logPath);
    }
    // The Watch product-path query must keep its JSON output contract.
    expect(count(/^\s*xcodebuild /gmu), name).toBe(name.includes("Apple Watch") ? 1 : 0);
    if (name.includes("Apple Watch")) {
      expect(run).toContain("-showBuildSettings -json |");
    }
  }

  expect(step("Prove native managed document download and export")).toMatchObject({
    run: '/bin/bash scripts/test-ios-chat-attachments.sh "$BASELINE_SHA"',
    if: "${{ !cancelled() && steps.ios-swift-tools.outcome == 'success' && matrix.phase == 'tests' && needs.preflight.outputs.validation_tier != 'main' && needs.preflight.outputs.compatibility_target != 'true' }}",
  });
  const smoke = step("Run focused iOS voice cleanup simulator tests");
  expect(smoke?.if).toContain("matrix.phase == 'smoke'");
  for (const suite of [
    "ManagedDocumentEnvelopeTests",
    "IOSMediaArtifactLoaderTests",
    "OpenClawTypographyTests",
  ]) {
    expect(smoke?.run).toContain(`-only-testing:OpenClawTests/${suite}`);
  }

  const upload = step("Upload iOS lifecycle simulator evidence");
  expect(upload?.if).toContain("always()");
  expect(upload?.if).toContain("steps.ios_attachment_tests.outcome");
  expect(upload?.with?.path?.trim().split("\n")).toEqual(
    ["*.xcresult", "*.log", "Attachment-*", "attachments-*"].map(
      (glob) => `apps/ios/build/LifecycleTestResults/${glob}`,
    ),
  );
});
