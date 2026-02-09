import { describe, expect, it, vi } from "vitest";
import * as issuesModule from "../../infra/jira-cli-issues.js";
import * as listsModule from "../../infra/jira-cli-lists.js";
import { createJiraCreateIssueTool } from "./jira-create-issue-tool.js";

describe("jira_create_issue tool", () => {
  const tool = createJiraCreateIssueTool();

  it("has expected name and schema", () => {
    expect(tool.name).toBe("jira_create_issue");
    expect(tool.parameters).toBeDefined();
    expect(tool.description).toContain("Create a Jira issue");
  });

  it("creates issue and returns key", async () => {
    vi.spyOn(issuesModule, "createJiraIssue").mockResolvedValue("BRLB-999");
    vi.spyOn(issuesModule, "assignJiraIssue").mockResolvedValue();
    vi.spyOn(listsModule, "listJiraSprints").mockResolvedValue([]);

    const result = await tool.execute("call-1", {
      summary: "Test task",
      projectKey: "BRLB",
    });

    expect(issuesModule.createJiraIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Test task",
        projectKey: "BRLB",
      }),
    );
    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    const textPart = content.find((c) => c.type === "text");
    expect(textPart?.text).toBeDefined();
    const parsed = JSON.parse(textPart!.text!) as { key: string };
    expect(parsed.key).toBe("BRLB-999");
  });

  it("assigns and adds to sprint when provided", async () => {
    vi.spyOn(issuesModule, "createJiraIssue").mockResolvedValue("BRLB-1");
    vi.spyOn(issuesModule, "assignJiraIssue").mockResolvedValue();
    vi.spyOn(issuesModule, "addJiraIssueToSprint").mockResolvedValue();
    vi.spyOn(listsModule, "listJiraSprints").mockResolvedValue([
      { id: "101", name: "Sprint 1", state: "active" },
    ]);

    const result = await tool.execute("call-2", {
      summary: "Sprint task",
      projectKey: "BRLB",
      assignee: "me",
      sprintName: "Sprint 1",
    });

    expect(issuesModule.assignJiraIssue).toHaveBeenCalledWith("BRLB-1", "me");
    expect(listsModule.listJiraSprints).toHaveBeenCalled();
    expect(issuesModule.addJiraIssueToSprint).toHaveBeenCalledWith("101", "BRLB-1");
    const content = result.content as Array<{ type: string; text?: string }>;
    const textPart = content.find((c) => c.type === "text");
    const parsed = JSON.parse(textPart!.text!) as {
      key: string;
      assignee?: string;
      sprintName?: string;
    };
    expect(parsed.key).toBe("BRLB-1");
    expect(parsed.assignee).toBe("me");
    expect(parsed.sprintName).toBe("Sprint 1");
  });
});
