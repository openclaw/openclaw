import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { toolingMtsEntrypoints } from "./tooling-mts-runtime.test-support.mts";

type Outcome = "failure" | "finding" | "success";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("deadcode command reporting", () => {
  it.for<{
    wrapper: "exports" | "unused-files";
    outcomes: Outcome[];
  }>([
    { wrapper: "exports", outcomes: ["failure", "finding", "success"] },
    { wrapper: "unused-files", outcomes: ["failure", "finding"] },
    { wrapper: "unused-files", outcomes: ["success", "finding"] },
    { wrapper: "exports", outcomes: ["success", "success", "success"] },
    { wrapper: "unused-files", outcomes: ["success", "success"] },
  ])("reports every $wrapper outcome: $outcomes", async ({ wrapper, outcomes }, { signal }) => {
    const root = tempDirs.make("openclaw-deadcode-reporting-");
    const pnpm = path.join(root, "pnpm.mjs");
    const scopes = ["production", "full-tree", "script"].slice(0, outcomes.length);
    const configs = [
      "config/knip.config.ts",
      "config/knip.all-exports.config.ts",
      "config/knip.scripts-exports.config.ts",
    ].slice(0, outcomes.length);
    const kind = wrapper === "exports" ? "unused-export" : "unused-file";
    const receipts = await openFixtureReceiptChannel();
    let child: ChildProcess | undefined;
    let completion: ReturnType<typeof runNodeScript> | undefined;

    try {
      // Synthetic Knip output only: keep the real CLI, launcher and child processes.
      // No child completes until all scopes start, so serial launch fails the barrier.
      writeFileSync(
        pnpm,
        `
${fixtureReceiptClientSource(receipts.endpoint)}
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const configs = ${JSON.stringify(configs)};
const outcomes = ${JSON.stringify(outcomes)};
const index = configs.indexOf(args[args.indexOf("--config") + 1]);
if (index < 0) throw new Error("Unexpected scan config");
const marker = (i, phase) => path.join(${JSON.stringify(root)}, i + "." + phase);
fs.writeFileSync(marker(index, "started"), JSON.stringify(args));
sendReceipt(String(index), "started");
await awaitRelease(String(index), "run");
const outcome = outcomes[index];
if (outcome === "failure") {
  console.error("SYNTHETIC_SCAN_FAILURE_" + index);
  process.exitCode = 2;
} else if (outcome === "finding") {
  console.log(args.includes("--files")
    ? "Unused files (1)\\nsrc/diagnostic-fixture.ts: src/diagnostic-fixture.ts"
    : "Unused exports (1)\\nsrc/diagnostic-fixture.ts: syntheticFinding");
  process.exitCode = 1;
}
fs.writeFileSync(marker(index, "completed"), outcome);
sendReceipt(String(index), "completed");
`,
      );
      completion = runNodeScript(
        resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(
            wrapper === "exports"
              ? toolingMtsEntrypoints.deadcodeExports
              : toolingMtsEntrypoints.deadcodeUnusedFiles,
          ),
        ),
        { ...process.env, npm_execpath: pnpm },
        undefined,
        {
          cwd: process.cwd(),
          executable: process.execPath,
          signal,
          onReady: (process) => {
            child = process;
          },
        },
      );
      const completed = completion;
      const waitForPhase = (index: number, phase: string) =>
        awaitGateBeforeSettlement(
          receipts.waitFor(String(index), phase),
          completed,
          "Fixture concurrency barrier timed out",
        ).catch((error: unknown) => {
          // Scan output and receipts use different pipes; its durable marker wins the race.
          if (!existsSync(path.join(root, `${index}.${phase}`))) {
            throw error;
          }
        });
      await withinTest(
        Promise.all(outcomes.map((_, index) => waitForPhase(index, "started"))),
        signal,
      );
      for (const index of outcomes.keys()) {
        receipts.release(String(index), "run");
        await withinTest(waitForPhase(index, "completed"), signal);
      }
      const result = await withinTest(completed, signal);
      const output = result.stdout + result.stderr;
      expect(result.error, output).toBeUndefined();
      expect(child?.signalCode, output).toBeNull();
      expect(result.status, output).toBe(
        outcomes.every((outcome) => outcome === "success") ? 0 : 1,
      );

      for (const [index, outcome] of outcomes.entries()) {
        expect(readFileSync(path.join(root, `${index}.completed`), "utf8")).toBe(outcome);
        const scanArgs = ["--config", configs[index]];
        if (index === 0) {
          scanArgs.push("--production");
        }
        if (index === 2) {
          scanArgs.push("--include-entry-exports");
        }
        expect(JSON.parse(readFileSync(path.join(root, `${index}.started`), "utf8"))).toEqual([
          "dlx",
          "--package",
          "knip@6.40.0",
          "knip",
          ...scanArgs,
          "--no-progress",
          "--reporter",
          "compact",
          ...(wrapper === "exports"
            ? ["--include", "exports,nsExports,types,nsTypes,enumMembers,namespaceMembers"]
            : ["--files"]),
          "--no-config-hints",
        ]);
        const scanName = `${scopes[index]} ${kind} scan`;
        expect(
          output.split("\n").filter((line) => line.includes(scanName)),
          output,
        ).toHaveLength(1);
        if (outcome === "success") {
          expect(result.stdout).toContain(`[deadcode] Knip ${scanName} passed with 0 entries.`);
        } else {
          expect(result.stdout).not.toContain(scanName);
          expect(result.stderr).toContain(
            outcome === "failure" ? `SYNTHETIC_SCAN_FAILURE_${index}` : "src/diagnostic-fixture.ts",
          );
        }
      }
    } finally {
      for (const index of outcomes.keys()) {
        receipts.release(String(index), "run");
      }
      if (child?.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await completion;
      await receipts.close();
    }
  });
});
