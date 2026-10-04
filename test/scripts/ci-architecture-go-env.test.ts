import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readCiWorkflow,
  runWorkflowShellScript,
  writeExecutable,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("architecture CI Go memory environment", () => {
  it.each<[string, string | undefined, string | undefined, string, string, number]>([
    ["defaults", undefined, undefined, "30", "3GiB", 0],
    ["caller overrides", "70", "8GiB", "70", "8GiB", 0],
    ["partial override", "off", undefined, "off", "3GiB", 0],
    ["blocking command failure", undefined, undefined, "30", "3GiB", 17],
  ])(
    "passes %s to the architecture command",
    (_name, gogc, limit, expectedGc, expectedLimit, exit) => {
      const script = readCiWorkflow().jobs["check-additional-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Run additional check shard",
      )?.run;
      if (typeof script !== "string") {
        throw new Error("Architecture CI command owner is missing");
      }
      const root = tempDirs.make("openclaw-architecture-go-env-");
      const bin = join(root, "bin");
      const capture = join(root, "command.json");
      mkdirSync(bin);
      const harness = join(root, ".ci-harness/scripts");
      mkdirSync(harness, { recursive: true });
      copyFileSync(
        new URL("../../scripts/ci-additional-checks.sh", import.meta.url),
        join(harness, "ci-additional-checks.sh"),
      );
      writeExecutable(join(bin, "pnpm"), [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.env.ARCHITECTURE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), gogc: process.env.GOGC ?? null, limit: process.env.GOMEMLIMIT ?? null, cpus: process.env.GOMAXPROCS, workers: process.env.OPENCLAW_VITEST_MAX_WORKERS }));",
        "process.exit(Number(process.env.ARCHITECTURE_EXIT));",
      ]);
      const result = runWorkflowShellScript(script, {
        cwd: root,
        linuxWorkflow: true,
        env: {
          ...process.env,
          PATH: [bin, process.env.PATH ?? ""].join(delimiter),
          ADDITIONAL_CHECK_GROUP: "runtime-topology-architecture",
          GOGC: gogc,
          GOMEMLIMIT: limit,
          GOMAXPROCS: "3",
          OPENCLAW_VITEST_MAX_WORKERS: "8",
          ARCHITECTURE_CAPTURE: capture,
          ARCHITECTURE_EXIT: String(exit),
        },
      });
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
        args: ["check:architecture"],
        gogc: expectedGc,
        limit: expectedLimit,
        cpus: "3",
        workers: "8",
      });
      expect(result.status, result.stderr).toBe(exit === 0 ? 0 : 1);
      if (exit !== 0) {
        expect(result.stdout).toContain("::error title=check:architecture failed::");
      }
    },
  );
});
