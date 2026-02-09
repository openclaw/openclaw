import { describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec.js";
import * as execModule from "../process/exec.js";
import * as configModule from "./jira-cli-config.js";
import { runJiraCli } from "./jira-cli.js";

describe("runJiraCli", () => {
  it("runs jira in configured docker container and returns result", async () => {
    const runCommandWithTimeout = vi.spyOn(execModule, "runCommandWithTimeout").mockResolvedValue({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    } satisfies SpawnResult);

    vi.spyOn(configModule, "getJiraCliConfig").mockReturnValue({
      containerName: "my-jira-cli",
      defaultIssueType: "Task",
      defaultPriority: "Medium",
      applicationFieldType: "label",
      applicationFieldKey: "application",
      favoriteProjects: [],
      defaultBoards: {},
    });

    const result = await runJiraCli(["project", "list", "--plain"]);

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
    const call = runCommandWithTimeout.mock.calls[0];
    expect(call).toBeDefined();
    const [argv, opts] = call;
    expect(argv).toEqual(["docker", "exec", "my-jira-cli", "jira", "project", "list", "--plain"]);
    expect((opts as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);

    expect(result).toEqual({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    });
  });

  it("propagates non-zero exit code", async () => {
    vi.spyOn(configModule, "getJiraCliConfig").mockReturnValue({
      containerName: "jira-cli",
      defaultIssueType: "Task",
      defaultPriority: "Medium",
      applicationFieldType: "label",
      applicationFieldKey: "application",
      favoriteProjects: [],
      defaultBoards: {},
    });

    vi.spyOn(execModule, "runCommandWithTimeout").mockResolvedValue({
      stdout: "",
      stderr: "boom",
      code: 1,
      signal: null,
      killed: false,
    } satisfies SpawnResult);

    const result = await runJiraCli(["issue", "list"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("boom");
  });
});
