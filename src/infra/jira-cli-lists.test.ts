import { describe, expect, it, vi } from "vitest";
import type { JiraCliResult } from "./jira-cli.js";
import {
  listJiraApplicationsFromLabels,
  listJiraAssignees,
  listJiraBoards,
  listJiraProjects,
  listJiraSprints,
} from "./jira-cli-lists.js";
import * as jiraCliModule from "./jira-cli.js";

describe("jira-cli list helpers", () => {
  const runJiraCli = vi.spyOn(jiraCliModule, "runJiraCli");

  it("lists projects", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "BRLB|BRI Lab Board\nABC|Another Project\n",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    const projects = await listJiraProjects();

    expect(projects).toEqual([
      { key: "BRLB", name: "BRI Lab Board" },
      { key: "ABC", name: "Another Project" },
    ]);
  });

  it("lists boards for a project", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "1|AI Vision Language|scrum\n2|Another Board|kanban\n",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    const boards = await listJiraBoards("BRLB");

    expect(boards).toEqual([
      { id: "1", name: "AI Vision Language", type: "scrum" },
      { id: "2", name: "Another Board", type: "kanban" },
    ]);
  });

  it("lists sprints", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "101|Sprint 1|active\n102|Sprint 2|future\n",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    const sprints = await listJiraSprints();

    expect(sprints).toEqual([
      { id: "101", name: "Sprint 1", state: "active" },
      { id: "102", name: "Sprint 2", state: "future" },
    ]);
  });

  it("lists sprints scoped to board when boardId provided", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "201|Sprint A|active\n",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    const sprints = await listJiraSprints({ boardId: "5" });

    expect(sprints).toEqual([{ id: "201", name: "Sprint A", state: "active" }]);
    expect(runJiraCli).toHaveBeenCalledWith(
      expect.arrayContaining(["sprint", "list", "--board", "5"]),
    );
  });

  it("lists applications from labels", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "ai_language,backend\nai_vision backend\n",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    const apps = await listJiraApplicationsFromLabels("BRLB");

    expect(apps).toEqual(
      expect.arrayContaining([
        { value: "ai_language", label: "ai_language" },
        { value: "backend", label: "backend" },
        { value: "ai_vision", label: "ai_vision" },
      ]),
    );
  });

  it("lists assignees by query", async () => {
    runJiraCli.mockResolvedValueOnce({
      stdout: "Alice\nBob\nAlice\n",
      stderr: "",
      exitCode: 0,
    } satisfies JiraCliResult);

    const assignees = await listJiraAssignees("ali");

    expect(assignees).toEqual([{ displayName: "Alice" }, { displayName: "Bob" }]);
  });
});
