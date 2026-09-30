import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { resolveDistArtifactLockPath } from "../../scripts/lib/dist-artifact-ownership.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { runOxlint } from "../../scripts/run-oxlint.mts";
import { createScriptTestHarness } from "./test-helpers.js";

vi.mock("../../scripts/lib/managed-child-process.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: vi.fn(async () => 0),
}));
afterEach(() => vi.clearAllMocks());
const { createTempDir } = createScriptTestHarness();
const env = {
  ...process.env,
  GITHUB_ACTIONS: "false",
  OPENCLAW_CI_STATIC_EVIDENCE: "0",
  OPENCLAW_OXLINT_SKIP_PREPARE: "1",
};

it.for([false, true].flatMap((evidence) => [0, 1].map((status) => ({ evidence, status }))))(
  "bounds advisory capture, preserves warnings, and respects stdout backpressure: %j",
  async ({ evidence, status }) => {
    const root = createTempDir("oxlint-report-memory-");
    const config = path.join(root, "config.json");
    fs.writeFileSync(config, JSON.stringify({ rules: { "max-lines": "error" } }));
    const summary = path.join(root, "summary.md");
    // Multibyte output crosses the byte budget below the old character limit.
    // A warning-only success must remain visible; malformed failures still stream.
    const chunks =
      status === 0
        ? [
            '{"diagnostics":[{"filename":"sample.ts","severity":"warning","code":"eslint(max-lines)","message":"',
            `${"é".repeat(600_000)}"}]}`,
          ]
        : ["report:", "é".repeat(600_000)];
    const forwarded: string[] = [];
    const drains = process.stdout.listenerCount("drain");
    const writer = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      forwarded.push(String(chunk));
      return false;
    });
    const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runManagedCommand).mockImplementationOnce(async (options) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const finished = once(stdout, "end");
      options.onReady?.(Object.assign(new ChildProcess(), { stdout, stderr }));
      for (const chunk of chunks) {
        stdout.write(chunk);
      }
      expect(stdout.isPaused()).toBe(true);
      process.stdout.emit("drain");
      expect(stdout.isPaused()).toBe(false);
      stdout.end();
      stderr.end();
      await finished;
      return status;
    });
    try {
      expect(
        await runOxlint(["--config", config, "scripts/run-oxlint.mts"], {
          ...env,
          GITHUB_ACTIONS: "true",
          GITHUB_STEP_SUMMARY: summary,
          OPENCLAW_CI_STATIC_EVIDENCE: evidence ? "1" : "0",
          OPENCLAW_CI_STATIC_EVIDENCE_ID: "bounded-report",
        }),
      ).toEqual({ status });
      expect(forwarded.join("")).toBe(chunks.join(""));
      expect(process.stdout.listenerCount("drain")).toBe(drains);
      expect(warnings).toHaveBeenCalledWith(
        expect.stringMatching(/::warning .*::The report exceeded 1 MiB/u),
      );
      expect(fs.readFileSync(summary, "utf8")).toContain(
        "Individual advisory annotations and static evidence were skipped",
      );
      expect(fs.readdirSync(root).filter((name) => name !== ".artifacts")).toEqual([
        "config.json",
        "summary.md",
      ]);
      expect(fs.existsSync(path.join(resolveDistArtifactLockPath(root), "owner.json"))).toBe(false);
    } finally {
      writer.mockRestore();
      warnings.mockRestore();
    }
  },
);
