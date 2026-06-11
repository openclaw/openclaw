import { describe, expect, it } from "vitest";
import { runWorkflowChecks } from "../../scripts/check-workflows.mjs";

type SpawnCall = {
  command: string;
  args: readonly string[];
};

function createSpawn(availableCommands: ReadonlySet<string>, statuses = new Map<string, number>()) {
  const calls: SpawnCall[] = [];
  const spawn = (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    if (command === "bash" && args[0] === "-lc") {
      const checkedCommand = String(args[1]).replace("command -v ", "");
      return { status: availableCommands.has(checkedCommand) ? 0 : 1 };
    }
    return { status: statuses.get(command) ?? 0 };
  };
  return { calls, spawn };
}

describe("check-workflows", () => {
  it("explains how to unblock workflow linting when actionlint and go are unavailable", () => {
    const { spawn } = createSpawn(new Set());
    let stderr = "";

    const status = runWorkflowChecks({
      spawn: spawn as never,
      stderr: { write: (message: string) => (stderr += message) } as never,
    });

    expect(status).toBe(127);
    expect(stderr).toContain("install actionlint or Go");
  });

  it("uses actionlint directly when it is installed", () => {
    const { calls, spawn } = createSpawn(new Set(["actionlint"]));

    const status = runWorkflowChecks({ spawn: spawn as never });

    expect(status).toBe(0);
    expect(calls.map((call) => call.command)).toEqual(["bash", "actionlint", "python3", "node"]);
  });

  it("falls back to the pinned actionlint go runner", () => {
    const { calls, spawn } = createSpawn(new Set(["go"]));

    const status = runWorkflowChecks({ spawn: spawn as never });

    expect(status).toBe(0);
    expect(calls).toContainEqual(
      expect.objectContaining({
        command: "go",
        args: expect.arrayContaining(["github.com/rhysd/actionlint/cmd/actionlint@v1.7.11"]),
      }),
    );
  });
});
