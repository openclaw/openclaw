import { describe, expect, it, vi } from "vitest";
import * as listsModule from "../../infra/jira-cli-lists.js";
import {
  createJiraListApplicationsTool,
  createJiraListAssigneesTool,
  createJiraListBoardsTool,
  createJiraListProjectsTool,
  createJiraListSprintsTool,
} from "./jira-list-tool.js";

describe("Jira list tools", () => {
  it("jira_list_projects has correct name and lists projects", async () => {
    const tool = createJiraListProjectsTool();
    expect(tool.name).toBe("jira_list_projects");
    vi.spyOn(listsModule, "listJiraProjects").mockResolvedValue([
      { key: "BRLB", name: "BRI Lab Board" },
    ]);
    const result = await tool.execute("tid", {});
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toEqual({
      projects: [{ key: "BRLB", name: "BRI Lab Board" }],
    });
  });

  it("jira_list_boards requires projectKey", async () => {
    const tool = createJiraListBoardsTool();
    vi.spyOn(listsModule, "listJiraBoards").mockResolvedValue([
      { id: "1", name: "Board", type: "scrum" },
    ]);
    await expect(tool.execute("tid", {})).rejects.toThrow("projectKey required");
    const result = await tool.execute("tid", { projectKey: "BRLB" });
    expect(JSON.parse((result.content[0] as { text: string }).text).boards).toHaveLength(1);
  });

  it("jira_list_sprints accepts optional boardId", async () => {
    const tool = createJiraListSprintsTool();
    const listSprints = vi
      .spyOn(listsModule, "listJiraSprints")
      .mockResolvedValue([{ id: "101", name: "Sprint 1", state: "active" }]);
    await tool.execute("tid", {});
    expect(listSprints).toHaveBeenCalledWith(undefined);
    listSprints.mockClear();
    await tool.execute("tid", { boardId: "5" });
    expect(listSprints).toHaveBeenCalledWith({ boardId: "5" });
  });

  it("jira_list_applications requires projectKey", async () => {
    const tool = createJiraListApplicationsTool();
    vi.spyOn(listsModule, "listJiraApplicationsFromLabels").mockResolvedValue([
      { value: "ai_language", label: "ai_language" },
    ]);
    await expect(tool.execute("tid", {})).rejects.toThrow("projectKey required");
    const result = await tool.execute("tid", { projectKey: "BRLB" });
    expect(JSON.parse((result.content[0] as { text: string }).text).applications).toHaveLength(1);
  });

  it("jira_list_assignees requires query", async () => {
    const tool = createJiraListAssigneesTool();
    vi.spyOn(listsModule, "listJiraAssignees").mockResolvedValue([{ displayName: "Alice" }]);
    await expect(tool.execute("tid", {})).rejects.toThrow("query required");
    const result = await tool.execute("tid", { query: "alice" });
    expect(JSON.parse((result.content[0] as { text: string }).text).assignees).toHaveLength(1);
  });
});
