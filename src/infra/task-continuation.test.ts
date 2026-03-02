import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    readdir: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn().mockReturnValue(["main", "eden", "seum"]),
  resolveAgentWorkspaceDir: vi.fn((cfg, agentId) => `/workspace/${agentId}`),
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: vi.fn(() => "/tmp/test-state"),
}));

vi.mock("../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../routing/bindings.js", () => ({
  resolveAgentBoundAccountId: vi.fn(() => "test-account-id"),
}));

vi.mock("../routing/session-key.js", () => ({
  buildAgentMainSessionKey: vi.fn(({ agentId }) => `agent:${agentId}:main`),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {},
}));

import fs from "node:fs/promises";
import { listAgentIds } from "../agents/agent-scope.js";
import { agentCommand } from "../commands/agent.js";

function makeTaskMd(opts: {
  id: string;
  status: string;
  description: string;
  context?: string;
  progress?: string[];
}): string {
  const lines = [
    `# Task: ${opts.id}`,
    "",
    "## Metadata",
    `- **Status:** ${opts.status}`,
    `- **Priority:** high`,
    `- **Created:** 2026-02-05T10:00:00Z`,
    "",
    "## Description",
    opts.description,
    "",
  ];
  if (opts.context) {
    lines.push("## Context", opts.context, "");
  }
  lines.push("## Progress");
  for (const p of opts.progress ?? ["Task started"]) {
    lines.push(`- ${p}`);
  }
  lines.push("", "## Last Activity", "2026-02-05T10:00:00Z", "", "---", "*Managed by task tools*");
  return lines.join("\n");
}

describe("task-continuation", () => {
  describe("loadPendingTasks - scans tasks/*.md files", () => {
    it("returns empty when tasks dir has no task files", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(fs.readdir).mockResolvedValue([] as string[]);
      vi.mocked(listAgentIds).mockReturnValue(["main"]);

      const tasks = await loadPendingTasks({} as never);
      expect(tasks).toHaveLength(0);
    });

    it("returns empty when tasks dir does not exist", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(listAgentIds).mockReturnValue(["main"]);

      const tasks = await loadPendingTasks({} as never);
      expect(tasks).toHaveLength(0);
    });

    it("skips non-task files and completed tasks", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(listAgentIds).mockReturnValue(["main"]);
      vi.mocked(fs.readdir).mockResolvedValue([
        "task_abc.md",
        "README.md",
        "task_def.md",
      ] as string[]);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          makeTaskMd({ id: "task_abc", status: "completed", description: "Done task" }),
        )
        .mockResolvedValueOnce(
          makeTaskMd({ id: "task_def", status: "in_progress", description: "Active task" }),
        );

      const tasks = await loadPendingTasks({} as never);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].task).toBe("Active task");
    });

    it("finds in_progress tasks with all fields", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(listAgentIds).mockReturnValue(["main"]);
      vi.mocked(fs.readdir).mockResolvedValue(["task_abc.md"] as string[]);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        makeTaskMd({
          id: "task_abc",
          status: "in_progress",
          description: "Implement feature X",
          context: "User requested new button",
          progress: ["Create component", "Add tests"],
        }),
      );

      const tasks = await loadPendingTasks({} as never);

      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        agentId: "main",
        task: "Implement feature X",
        context: "User requested new button",
      });
      expect(tasks[0].progress).toContain("Create component");
      expect(tasks[0].progress).toContain("Add tests");
    });

    it("finds blocked tasks too", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(listAgentIds).mockReturnValue(["eden"]);
      vi.mocked(fs.readdir).mockResolvedValue(["task_blocked1.md"] as string[]);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        makeTaskMd({ id: "task_blocked1", status: "blocked", description: "Blocked task" }),
      );

      const tasks = await loadPendingTasks({} as never);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].agentId).toBe("eden");
      expect(tasks[0].task).toBe("Blocked task");
    });

    it("supports legacy metadata description/context format for backward compatibility", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(listAgentIds).mockReturnValue(["main"]);
      vi.mocked(fs.readdir).mockResolvedValue(["task_legacy.md"] as string[]);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        [
          "# Task: task_legacy",
          "",
          "## Metadata",
          "- **Status:** in_progress",
          "- **Priority:** high",
          "- **Description:** Legacy description",
          "- **Context:** Legacy context",
          "",
          "## Progress",
          "- Legacy step",
        ].join("\n"),
      );

      const tasks = await loadPendingTasks({} as never);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        task: "Legacy description",
        context: "Legacy context",
      });
    });

    it("returns tasks for multiple agents", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(listAgentIds).mockReturnValue(["main", "eden"]);
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce(["task_1.md"] as string[])
        .mockResolvedValueOnce(["task_2.md"] as string[]);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          makeTaskMd({ id: "task_1", status: "in_progress", description: "Main task" }),
        )
        .mockResolvedValueOnce(
          makeTaskMd({ id: "task_2", status: "in_progress", description: "Eden task" }),
        );

      const tasks = await loadPendingTasks({} as never);

      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.agentId)).toEqual(["main", "eden"]);
    });

    it("skips agents with missing tasks dir", async () => {
      const { loadPendingTasks } = await import("./task-continuation.js");

      vi.mocked(listAgentIds).mockReturnValue(["main", "eden", "seum"]);
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce(["task_1.md"] as string[])
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce(["task_3.md"] as string[]);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          makeTaskMd({ id: "task_1", status: "in_progress", description: "Main task" }),
        )
        .mockResolvedValueOnce(
          makeTaskMd({ id: "task_3", status: "in_progress", description: "Seum task" }),
        );

      const tasks = await loadPendingTasks({} as never);

      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.agentId)).toEqual(["main", "seum"]);
    });
  });

  describe("resumePendingTasks", () => {
    it("calls agentCommand for each pending task", async () => {
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce('{"version":1,"lastResumeAt":0}')
        .mockResolvedValueOnce(
          makeTaskMd({ id: "task_resume1", status: "in_progress", description: "Test task" }),
        );
      vi.mocked(fs.readdir).mockResolvedValue(["task_resume1.md"] as string[]);

      vi.mocked(listAgentIds).mockReturnValue(["main"]);

      const { resumePendingTasks } = await import("./task-continuation.js");

      const result = await resumePendingTasks({
        cfg: {} as never,
        deps: {} as never,
      });

      expect(agentCommand).toHaveBeenCalled();
      expect(result.resumed).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it("returns correct counts on failure", async () => {
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce('{"version":1,"lastResumeAt":0}')
        .mockResolvedValueOnce(
          makeTaskMd({ id: "task_fail1", status: "in_progress", description: "Test task" }),
        );
      vi.mocked(fs.readdir).mockResolvedValue(["task_fail1.md"] as string[]);

      vi.mocked(listAgentIds).mockReturnValue(["main"]);
      vi.mocked(agentCommand).mockRejectedValueOnce(new Error("Failed"));

      const { resumePendingTasks } = await import("./task-continuation.js");

      const result = await resumePendingTasks({
        cfg: {} as never,
        deps: {} as never,
      });

      expect(result.resumed).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });
});
