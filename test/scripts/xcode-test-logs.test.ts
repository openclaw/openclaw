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

it("spools simulator commands and retains iOS failure evidence", () => {
  type Step = { name: string; run?: string; if?: string; with?: { path?: string } };
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = workflow.jobs["ios-build"]!.steps;
  // Suite selection and execution belong to ios-lifecycle-workflow.test.ts.
  const commands = steps
    .filter((step) => step.name.endsWith("simulator tests"))
    .flatMap((step) => (step.run ?? "").split("\n"))
    .filter((line) => /\bxcodebuild\b/u.test(line) && !line.includes("-showBuildSettings"));
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) {
    expect(command).toMatch(/\brun_apple_command_logged \S+ xcodebuild \\/u);
  }
  const upload = steps.find((step) => step.name === "Upload iOS lifecycle simulator evidence");
  expect(upload?.if).toContain("always()");
  expect(upload?.if).toContain("steps.ios_attachment_tests.outcome");
  // Preserve logs and result bundles; attachment-specific artifacts have their own owner.
  expect(upload?.with?.path).toContain("apps/ios/build/LifecycleTestResults/*.log");
  expect(upload?.with?.path).toContain("apps/ios/build/LifecycleTestResults/*.xcresult");
});
