import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readCiWorkflow,
  requiredWorkflowStep,
  runWorkflowShellScript,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const memoryStep = requiredWorkflowStep(
  readCiWorkflow().jobs["checks-node-core-test-nondist-shard"].steps,
  "Record runner memory peak",
);

it.each([
  { name: "nested runner", group: "/runner/job", peak: "900\n", expected: "bytes=900" },
  { name: "namespace root", group: "/", peak: "1200\n", expected: "bytes=1200" },
  { name: "unreadable leaf", group: "/runner/job", peak: null, expected: "unavailable" },
  { name: "malformed counter", group: "/runner/job", peak: "invalid", expected: "unavailable" },
  {
    name: "failed checkout",
    group: "/runner/job",
    peak: "900\n",
    expected: "unavailable",
    missing: true,
  },
])("reports runner memory from the real workflow ($name)", (fixture) => {
  const root = tempDirs.make("ci-runner-memory-");
  if (!fixture.missing) {
    for (const file of [
      "scripts/lib/process-memory.mts",
      "packages/normalization-core/src/mountinfo-path.ts",
    ]) {
      const target = path.join(root, ".ci-harness", file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(file, target);
    }
  }
  const files: Record<string, string | null> = {
    "/proc/self/cgroup": `0::${fixture.group}\n`,
    "/proc/self/mountinfo": "30 25 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n",
    "/sys/fs/cgroup/runner/memory.peak": "2400\n",
    [`/sys/fs/cgroup${fixture.group === "/" ? "" : fixture.group}/memory.peak`]: fixture.peak,
  };
  const preload = path.join(root, "proc-fixture.mjs");
  writeFileSync(
    preload,
    `
    import fs from "node:fs";
    Object.defineProperty(process, "platform", { value: "linux" });
    const files = ${JSON.stringify(files)};
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (typeof file === "string" && (file.startsWith("/proc/") || file.startsWith("/sys/fs/cgroup"))) {
        if (files[file] != null) return files[file];
        throw Object.assign(new Error("fixture file missing"), { code: "ENOENT" });
      }
      return read.call(this, file, ...args);
    };
  `,
  );
  const result = runWorkflowShellScript(memoryStep.run, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(`runner cgroup peak memory ${fixture.expected}`);
  expect(result.stderr).toBe("");
});
