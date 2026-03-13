import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";

const runtimeLog = vi.fn();

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: runtimeLog,
  },
}));

const { inferUpdateFailureHints, printResult } = await import("./progress.js");

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

describe("inferUpdateFailureHints", () => {
  beforeEach(() => {
    runtimeLog.mockReset();
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

  it("shortens result root paths in human output", () => {
    const home = os.homedir();
    printResult(
      {
        status: "ok",
        mode: "npm",
        root: `${home}/.local/share/openclaw`,
        steps: [],
        durationMs: 1,
      },
      { json: false },
    );

    const lines = runtimeLog.mock.calls.map((call) => String(call[0]));
    expect(lines.join("\n")).toContain("Root:");
    expect(lines.join("\n")).toContain("~/.local/share/openclaw");
    expect(lines.join("\n")).not.toContain(`${home}/.local/share/openclaw`);
  });
});
