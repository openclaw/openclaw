import { z } from "zod";

/** Pattern for task IDs: TASK-001, TASK-042, etc. */
export const TASK_ID_PATTERN = /^TASK-\d+$/;

export const ProjectFrontmatterSchema = z.object({
  name: z.string(),
  status: z.enum(["active", "paused", "complete"]).default("active"),
  description: z.string().optional(),
  owner: z.string().optional(),
  tags: z.array(z.string()).default([]),
  columns: z.array(z.string()).default(["Backlog", "In Progress", "Review", "Done"]),
  dashboard: z
    .object({
      widgets: z
        .array(z.string())
        .default([
          "project-status",
          "task-counts",
          "active-agents",
          "sub-project-status",
          "recent-activity",
          "blockers",
        ]),
    })
    .default({
      widgets: [
        "project-status",
        "task-counts",
        "active-agents",
        "sub-project-status",
        "recent-activity",
        "blockers",
      ],
    }),
  created: z.string().optional(),
  updated: z.string().optional(),
});

export const TaskFrontmatterSchema = z.object({
  id: z.string().regex(TASK_ID_PATTERN),
  title: z.string(),
  status: z.enum(["backlog", "in-progress", "review", "done", "blocked"]).default("backlog"),
  column: z.string().default("Backlog"),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  capabilities: z.array(z.string()).default([]),
  depends_on: z.array(z.string().regex(TASK_ID_PATTERN)).default([]),
  claimed_by: z.string().nullable().default(null),
  claimed_at: z.string().nullable().default(null),
  created: z.string().optional(),
  updated: z.string().optional(),
  parent: z.string().nullable().default(null),
});

export const QueueFrontmatterSchema = z.object({
  updated: z.string().optional(),
});
