import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as processExec from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import * as updateGlobal from "./update-global.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { buildUpdateCommandRunner, runStep } from "./update-runner-command.js";

describe("update download progress", () => {
  beforeEach(() => {
    vi.spyOn(updateGlobal, "createGlobalInstallEnv").mockResolvedValue({});
  });
  afterEach(() => vi.restoreAllMocks());

  it("reports only numeric Git stderr progress before the fetch completes", async () => {
    const messages: string[] = [];
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      expect(argv).toEqual([
        "git",
        "-C",
        "/fixture",
        "fetch",
        "origin",
        "--progress",
        "--",
        "main",
      ]);
      if (typeof options === "number") {
        throw new Error("Expected streaming command options");
      }
      expect(options.env?.LC_ALL).toBe("C");
      options.onOutputChunk?.(Buffer.from("Receiving objects: 99% (99/100)\n"), "stdout");
      options.onOutputChunk?.(
        Buffer.from("remote: private diagnostic token=fixture-secret\nReceiving obj"),
        "stderr",
      );
      options.onOutputChunk?.(Buffer.from("ects:  25% (1/4), 64.00 KiB | 8.00 KiB/s\r"), "stderr");
      expect(messages).toEqual(["Receiving objects: 25% (1/4), 64.00 KiB | 8.00 KiB/s"]);
      options.onOutputChunk?.(Buffer.from("Resolving deltas: 100% (2/2), done."), "stderr");
      return createCommandResult();
    });
    const { runCommand } = await buildUpdateCommandRunner();
    const result = await runStep({
      name: "git-target-inspection-fetch",
      argv: ["git", "-C", "/fixture", "fetch", "origin", "--", "main"],
      cwd: "/fixture",
      runCommand,
      stepIndex: 0,
      totalSteps: 1,
      progress: { onStepProgress: ({ message }) => messages.push(message) },
    });
    expect(result.exitCode).toBe(0);
    expect(messages).toEqual([
      "Receiving objects: 25% (1/4), 64.00 KiB | 8.00 KiB/s",
      "Resolving deltas: 100% (2/2), done.",
    ]);
  });

  it("leaves non-displayed commands and existing output observers unchanged", async () => {
    const observer = vi.fn(() => false);
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      expect(argv).toEqual(["git", "fetch", "origin"]);
      if (typeof options === "number") {
        throw new Error("Expected command options");
      }
      expect(options.env?.LC_ALL).toBe("fr_FR.UTF-8");
      expect(options.onOutputChunk?.(Buffer.from("captured output"), "stderr")).toBe(false);
      return createCommandResult();
    });
    const { runCommand } = await buildUpdateCommandRunner();
    await runCommand(["git", "fetch", "origin"], {
      env: { LC_ALL: "fr_FR.UTF-8" },
      onOutputChunk: observer,
    });
    expect(observer).toHaveBeenCalledOnce();
  });

  it("keeps downloading and preserves output observers when rendering fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const observer = vi.fn(() => false);
    const display = vi.fn(() => {
      throw new Error("terminal closed");
    });
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (_, options) => {
      if (typeof options === "number") {
        throw new Error("Expected streaming command options");
      }
      for (let index = 0; index < 2; index++) {
        expect(
          options.onOutputChunk?.(Buffer.from("Receiving objects: 50% (1/2)\r"), "stderr"),
        ).toBe(false);
      }
      return createCommandResult();
    });
    const { runCommand } = await buildUpdateCommandRunner();
    const result = await runCommand(["git", "fetch", "origin"], {
      onUpdateProgress: display,
      onOutputChunk: observer,
    });
    expect(result.code).toBe(0);
    expect(display).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledOnce();
  });
});

describe("update command failure diagnostics", () => {
  it.each([
    {
      diagnostic:
        "error: cannot lock ref 'refs/tags/release/child': 'refs/tags/release' exists; cannot create 'refs/tags/release/child'",
    },
    { diagnostic: "fatal: unable to update local ref" },
    { diagnostic: " ! [rejected] release -> release (would clobber existing tag)" },
    {
      diagnostic: "fatal: Could not read from remote repository.",
      before: "fixture@git.example.invalid: Permission denied (publickey).\n",
      cause: "Permission denied (publickey)",
    },
    {
      diagnostic: "fatal: Could not read from remote repository.",
      before: "Host key verification failed.\n",
      cause: "Host key verification failed.",
    },
  ])(
    "retains Git failure causes in saved history and reports: $diagnostic",
    async ({
      diagnostic,
      before = "remote: Enumerating objects: 4, done.\nReceiving objects: 100% (4/4), done.\r",
      cause,
    }) => {
      const stderr = `${before}${diagnostic}\n`;
      const result = await runStep({
        name: "git fetch",
        argv: ["git", "fetch", "--tags", "--force", "--prune", "origin"],
        cwd: "/fixture",
        stepIndex: 0,
        totalSteps: 1,
        runCommand: async () => ({ code: 1, stdout: "", stderr }),
      });
      expect(result.stderrTail).toBe(stderr.trimEnd());
      const expected = cause ?? diagnostic.trim();
      if (cause) {
        expect(result.failureFacts?.[0]?.message).toContain(cause);
      } else {
        expect(result.failureFacts?.[0]?.message).toBe(expected);
      }
      const [saved] = updateRunStepsFromResultStep(result);
      expect(saved?.detail).toContain(expected.slice(0, 60));
      expect(saved?.failureFacts).toEqual(result.failureFacts);
      const report = renderUpdateRunReport(
        updateRunReportInputFromResult({
          status: "error",
          mode: "git",
          reason: "fetch-failed",
          steps: [result],
          durationMs: 0,
        }),
      );
      expect(report.markdown).toContain(expected);
      expect(report.markdown).not.toContain("Enumerating objects");
    },
  );

  it.each(["stderr", "stdout"] as const)(
    "keeps the sanitized child cause below a package-manager banner in %s",
    async (stream) => {
      const diagnostic = `\u001b[31mError: Candidate build refused; token=fixture-private-token ${"detail ".repeat(50)}\u001b[0m`;
      const result = await runStep({
        name: "preflight-build",
        argv: ["pnpm", "build"],
        cwd: "/fixture",
        timeoutMs: 1000,
        stepIndex: 0,
        totalSteps: 1,
        runCommand: async () => ({
          code: 17,
          stdout: stream === "stdout" ? diagnostic : "",
          stderr:
            stream === "stderr"
              ? `$ node scripts/build-all.mts\n${diagnostic}\n`
              : "$ node scripts/build-all.mts\n",
        }),
      });
      expect(result.exitCode).toBe(17);
      expect(result.failureFacts?.[0]?.message).toContain("Candidate build refused");
      expect(result.failureFacts?.[0]?.message).not.toContain("fixture-private-token");
      expect(result.failureFacts?.[0]?.message).not.toContain("\u001b");
      expect(result.failureFacts?.[0]?.message?.length).toBeLessThanOrEqual(200);
    },
  );
  it.each([
    {
      name: "non-banner",
      stderr: "Compiler rejected candidate\nError: secondary context",
      stdout: "Error: later output",
      expected: "Compiler rejected candidate",
    },
    {
      name: "banner without an error header",
      stderr: "$ node scripts/build-all.mts\ncompiler status: failed",
      stdout: "",
      expected: "$ node scripts/build-all.mts",
    },
  ])("preserves the $name diagnostic fallback", async ({ stderr, stdout, expected }) => {
    const result = await runStep({
      name: "preflight-build",
      argv: ["pnpm", "build"],
      cwd: "/fixture",
      timeoutMs: 1000,
      stepIndex: 0,
      totalSteps: 1,
      runCommand: async () => ({ code: 17, stderr, stdout }),
    });
    expect(result.failureFacts?.[0]?.message).toBe(expected);
  });
});
