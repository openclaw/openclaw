import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JiraCliResult } from "./jira-cli.js";
import * as configModule from "./jira-cli-config.js";
import { addJiraIssueToSprint, assignJiraIssue, createJiraIssue } from "./jira-cli-issues.js";
import * as jiraCliModule from "./jira-cli.js";

describe("jira-cli issue primitives", () => {
  const runJiraCli = vi.spyOn(jiraCliModule, "runJiraCli");

  beforeEach(() => {
    runJiraCli.mockClear();
    vi.spyOn(configModule, "getJiraCliConfig").mockReturnValue({
      containerName: "jira-cli",
      defaultIssueType: "Task",
      defaultPriority: "Medium",
      applicationFieldType: "label",
      applicationFieldKey: "application",
      favoriteProjects: [],
      defaultBoards: {},
    });
  });

  it("createJiraIssue returns parsed issue key", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "Created issue BRLB-123. https://jira.example.com/browse/BRLB-123",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    const key = await createJiraIssue({
      projectKey: "BRLB",
      summary: "Test task",
    });

    expect(key).toBe("BRLB-123");
    expect(runJiraCli).toHaveBeenCalledWith(
      expect.arrayContaining([
        "issue",
        "create",
        "-pBRLB",
        "-tTask",
        "-sTest task",
        "-yMedium",
        "--no-input",
      ]),
      {},
    );
  });

  it("createJiraIssue adds label when application provided", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "Created issue BRLB-456.",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    await createJiraIssue({
      projectKey: "BRLB",
      summary: "App task",
      application: "ai_language",
    });

    expect(runJiraCli).toHaveBeenCalledWith(expect.arrayContaining(["-lai_language"]), {});
  });

  it("createJiraIssue sanitizes double-quotes in summary and args", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "Created issue BRLB-111.",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    await createJiraIssue({
      projectKey: "BRLB",
      summary: 'Say "hello" to the world',
    });

    expect(runJiraCli).toHaveBeenCalledWith(
      expect.arrayContaining(["-sSay hello to the world"]),
      {},
    );
  });

  it("createJiraIssue passes description via input when provided", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "Created issue BRLB-789.",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    await createJiraIssue({
      projectKey: "BRLB",
      summary: "With body",
      description: "Line one\nLine two",
    });

    expect(runJiraCli).toHaveBeenCalledWith(expect.arrayContaining(["--template", "-"]), {
      input: "Line one\nLine two",
    });
  });

  it("assignJiraIssue calls issue assign with given assignee", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    await assignJiraIssue("BRLB-123", "Alice");

    expect(runJiraCli).toHaveBeenCalledWith(["issue", "assign", "BRLB-123", "Alice"]);
  });

  it('assignJiraIssue resolves "me" via jira me', async () => {
    runJiraCli
      .mockResolvedValueOnce({
        stdout: "current.user@example.com",
        stderr: "",
        exitCode: 0,
      } satisfies JiraCliResult)
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      } satisfies JiraCliResult);

    await assignJiraIssue("BRLB-123", "me");

    expect(runJiraCli).toHaveBeenCalledTimes(2);
    expect(runJiraCli).toHaveBeenNthCalledWith(1, ["me"]);
    expect(runJiraCli).toHaveBeenNthCalledWith(2, [
      "issue",
      "assign",
      "BRLB-123",
      "current.user@example.com",
    ]);
  });

  it("addJiraIssueToSprint calls sprint add", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    await addJiraIssueToSprint("101", "BRLB-123");

    expect(runJiraCli).toHaveBeenCalledWith(["sprint", "add", "101", "BRLB-123"]);
  });
});
