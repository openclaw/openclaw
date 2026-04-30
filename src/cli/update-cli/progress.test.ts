import { describe, expect, it } from "vitest";
import type { UpdateRunResult, UpdateStepCompletion } from "../../infra/update-runner.js";
import { inferUpdateFailureHints, resolveStepDisplay } from "./progress.js";

function makeStep(overrides: Partial<UpdateStepCompletion>): UpdateStepCompletion {
  return {
    name: "clean check",
    command: "git -C . status --porcelain",
    index: 0,
    total: 1,
    durationMs: 1,
    exitCode: 0,
    stdoutTail: "",
    stderrTail: "",
    ...overrides,
  };
}

function makeResult(
  stepName: string,
  stderrTail: string,
  mode: UpdateRunResult["mode"] = "npm",
): UpdateRunResult {
  return {
    status: "error",
    mode,
    reason: stepName,
    steps: [
      {
        name: stepName,
        command: "npm i -g openclaw@latest",
        cwd: "/tmp",
        durationMs: 1,
        exitCode: 1,
        stderrTail,
      },
    ],
    durationMs: 1,
  };
}

describe("resolveStepDisplay", () => {
  it("treats an empty clean-check stdout as a clean working tree", () => {
    const display = resolveStepDisplay(makeStep({ stdoutTail: "" }));
    expect(display).toEqual({ label: "Working directory is clean", outcome: "ok" });
  });

  it("treats whitespace-only clean-check stdout as a clean working tree", () => {
    const display = resolveStepDisplay(makeStep({ stdoutTail: "\n  \t\n" }));
    expect(display.outcome).toBe("ok");
    expect(display.label).toBe("Working directory is clean");
  });

  it("flags clean-check stdout with porcelain entries as dirty even when exit code is 0", () => {
    const display = resolveStepDisplay(
      makeStep({ stdoutTail: "?? 2026-04-29T06-12-16.838Z-openclaw-backup.tar.gz\n" }),
    );
    expect(display).toEqual({
      label: "Working directory has uncommitted changes",
      outcome: "warn",
    });
  });

  it("does not apply the dirty override to other steps", () => {
    const display = resolveStepDisplay(makeStep({ name: "git fetch", stdoutTail: "fetched main" }));
    expect(display.outcome).toBe("ok");
    expect(display.label).toBe("Fetching latest changes");
  });

  it("marks non-zero exit codes as failures", () => {
    const display = resolveStepDisplay(makeStep({ name: "git fetch", exitCode: 1 }));
    expect(display.outcome).toBe("fail");
  });
});

describe("inferUpdateFailureHints", () => {
  it("returns a package-manager bootstrap hint for pnpm npm-bootstrap failures", () => {
    const result = {
      status: "error",
      mode: "git",
      reason: "pnpm-npm-bootstrap-failed",
      steps: [],
      durationMs: 1,
    } satisfies UpdateRunResult;

    const hints = inferUpdateFailureHints(result);

    expect(hints.join("\n")).toContain("bootstrap pnpm from npm");
    expect(hints.join("\n")).toContain("Install pnpm manually");
  });

  it("returns a corepack hint when corepack is missing", () => {
    const result = {
      status: "error",
      mode: "git",
      reason: "pnpm-corepack-missing",
      steps: [],
      durationMs: 1,
    } satisfies UpdateRunResult;

    const hints = inferUpdateFailureHints(result);

    expect(hints.join("\n")).toContain("corepack is missing");
    expect(hints.join("\n")).toContain("Install pnpm manually");
  });

  it("returns EACCES hint for global update permission failures", () => {
    const result = makeResult(
      "global update",
      "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied",
    );
    const hints = inferUpdateFailureHints(result);
    expect(hints.join("\n")).toContain("EACCES");
    expect(hints.join("\n")).toContain("npm config set prefix ~/.local");
  });

  it("returns EACCES hint for staged package permission failures", () => {
    const result = makeResult(
      "global install stage",
      "EACCES: permission denied, mkdtemp '/usr/local/lib/node_modules/.openclaw-update-stage-'",
    );
    const hints = inferUpdateFailureHints(result);
    expect(hints.join("\n")).toContain("EACCES");
    expect(hints.join("\n")).toContain("npm config set prefix ~/.local");
  });

  it("returns native optional dependency hint for node-gyp failures", () => {
    const result = makeResult("global update", "node-pre-gyp ERR!\nnode-gyp rebuild failed");
    const hints = inferUpdateFailureHints(result);
    expect(hints.join("\n")).toContain("--omit=optional");
  });

  it("does not return npm hints for non-npm install modes", () => {
    const result = makeResult(
      "global update",
      "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied",
      "pnpm",
    );
    expect(inferUpdateFailureHints(result)).toEqual([]);
  });
});
