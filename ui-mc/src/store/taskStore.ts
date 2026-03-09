import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TaskStatus = "todo" | "in_progress" | "review" | "done";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface ActivityEntry {
  id: string;
  text: string;
  timestamp: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgent: string;
  dueDate: string;
  tags: string[];
  project?: string;
  createdAt: string;
  subtasks: Subtask[];
  activity: ActivityEntry[];
}

const mkActivity = (text: string): ActivityEntry => ({
  id: crypto.randomUUID(),
  text,
  timestamp: new Date().toISOString(),
});

const SEED_TASKS: Task[] = [
  // YETOMO — aria, vance, sage
  {
    id: "1",
    title: "Finalize Q2 Revenue Report",
    description: "Compile all revenue data",
    status: "in_progress",
    priority: "high",
    assignedAgent: "vance",
    dueDate: "2026-03-10",
    tags: ["finance", "report"],
    project: "YETOMO",
    createdAt: "2026-03-01",
    subtasks: [
      { id: "s1", title: "Gather Q2 numbers", done: true },
      { id: "s2", title: "Build spreadsheet", done: false },
    ],
    activity: [
      { id: "a1", text: "Task created", timestamp: "2026-03-01T09:00:00Z" },
      { id: "a2", text: "Moved to In Progress", timestamp: "2026-03-06T14:00:00Z" },
    ],
  },
  {
    id: "7",
    title: "Prepare investor deck",
    description: "Update slides with Q1 metrics",
    status: "in_progress",
    priority: "urgent",
    assignedAgent: "aria",
    dueDate: "2026-03-09",
    tags: ["business", "presentation"],
    project: "YETOMO",
    createdAt: "2026-03-03",
    subtasks: [
      { id: "s7", title: "Update financials slide", done: true },
      { id: "s8", title: "Add growth chart", done: false },
    ],
    activity: [{ id: "a9", text: "Task created", timestamp: "2026-03-03T08:00:00Z" }],
  },
  {
    id: "12",
    title: "Market analysis for YETOMO expansion",
    description: "Research new verticals",
    status: "in_progress",
    priority: "high",
    assignedAgent: "sage",
    dueDate: "2026-03-14",
    tags: ["research", "strategy"],
    project: "YETOMO",
    createdAt: "2026-03-05",
    subtasks: [],
    activity: [{ id: "a14", text: "Task created", timestamp: "2026-03-05T10:00:00Z" }],
  },
  // BION — dev, sage, aria
  {
    id: "2",
    title: "Deploy API v2.3",
    description: "Push new endpoints to production",
    status: "review",
    priority: "urgent",
    assignedAgent: "dev",
    dueDate: "2026-03-09",
    tags: ["dev", "deploy"],
    project: "BION",
    createdAt: "2026-03-05",
    subtasks: [
      { id: "s3", title: "Run test suite", done: true },
      { id: "s4", title: "Stage deploy", done: true },
      { id: "s5", title: "Prod deploy", done: false },
    ],
    activity: [{ id: "a3", text: "Task created", timestamp: "2026-03-05T10:00:00Z" }],
  },
  {
    id: "13",
    title: "BION security audit report",
    description: "Compile vulnerability findings",
    status: "in_progress",
    priority: "high",
    assignedAgent: "sage",
    dueDate: "2026-03-11",
    tags: ["security", "research"],
    project: "BION",
    createdAt: "2026-03-06",
    subtasks: [],
    activity: [{ id: "a15", text: "Task created", timestamp: "2026-03-06T09:00:00Z" }],
  },
  {
    id: "14",
    title: "Coordinate BION launch timeline",
    description: "Align teams for release",
    status: "todo",
    priority: "urgent",
    assignedAgent: "aria",
    dueDate: "2026-03-10",
    tags: ["coordination"],
    project: "BION",
    createdAt: "2026-03-07",
    subtasks: [],
    activity: [{ id: "a16", text: "Task created", timestamp: "2026-03-07T08:00:00Z" }],
  },
  // ECHO//ONE — flux, echo, vance
  {
    id: "4",
    title: "Campaign A/B test review",
    description: "Analyze email variants",
    status: "in_progress",
    priority: "high",
    assignedAgent: "flux",
    dueDate: "2026-03-11",
    tags: ["marketing"],
    project: "ECHO//ONE",
    createdAt: "2026-03-06",
    subtasks: [{ id: "s6", title: "Pull metrics", done: true }],
    activity: [{ id: "a6", text: "Task created", timestamp: "2026-03-06T09:00:00Z" }],
  },
  {
    id: "15",
    title: "Write ECHO//ONE launch copy",
    description: "Landing page and email sequence",
    status: "in_progress",
    priority: "high",
    assignedAgent: "echo",
    dueDate: "2026-03-10",
    tags: ["content", "marketing"],
    project: "ECHO//ONE",
    createdAt: "2026-03-05",
    subtasks: [],
    activity: [{ id: "a17", text: "Task created", timestamp: "2026-03-05T11:00:00Z" }],
  },
  {
    id: "16",
    title: "ECHO//ONE pricing strategy",
    description: "Finalize tier structure",
    status: "todo",
    priority: "medium",
    assignedAgent: "vance",
    dueDate: "2026-03-13",
    tags: ["strategy", "pricing"],
    project: "ECHO//ONE",
    createdAt: "2026-03-07",
    subtasks: [],
    activity: [{ id: "a18", text: "Task created", timestamp: "2026-03-07T10:00:00Z" }],
  },
  // ITSON FSM — vance, dev, nova
  {
    id: "8",
    title: "Optimize staffing workflow",
    description: "Reduce onboarding time by 30%",
    status: "todo",
    priority: "high",
    assignedAgent: "vance",
    dueDate: "2026-03-15",
    tags: ["operations"],
    project: "ITSON FSM",
    createdAt: "2026-03-06",
    subtasks: [],
    activity: [{ id: "a10", text: "Task created", timestamp: "2026-03-06T11:00:00Z" }],
  },
  {
    id: "17",
    title: "Build FSM scheduling module",
    description: "Automated shift assignment",
    status: "in_progress",
    priority: "high",
    assignedAgent: "dev",
    dueDate: "2026-03-14",
    tags: ["dev", "automation"],
    project: "ITSON FSM",
    createdAt: "2026-03-06",
    subtasks: [],
    activity: [{ id: "a19", text: "Task created", timestamp: "2026-03-06T14:00:00Z" }],
  },
  {
    id: "18",
    title: "Setup FSM team calendar",
    description: "Sync field team availability",
    status: "todo",
    priority: "medium",
    assignedAgent: "nova",
    dueDate: "2026-03-12",
    tags: ["calendar", "operations"],
    project: "ITSON FSM",
    createdAt: "2026-03-07",
    subtasks: [],
    activity: [{ id: "a20", text: "Task created", timestamp: "2026-03-07T09:00:00Z" }],
  },
  // HELIX — flux, ember, echo
  {
    id: "19",
    title: "Plan HELIX community event",
    description: "Quarterly meetup organization",
    status: "in_progress",
    priority: "medium",
    assignedAgent: "ember",
    dueDate: "2026-03-16",
    tags: ["events", "community"],
    project: "HELIX",
    createdAt: "2026-03-04",
    subtasks: [],
    activity: [{ id: "a21", text: "Task created", timestamp: "2026-03-04T10:00:00Z" }],
  },
  {
    id: "20",
    title: "HELIX social media campaign",
    description: "Pre-event buzz content",
    status: "in_progress",
    priority: "medium",
    assignedAgent: "flux",
    dueDate: "2026-03-13",
    tags: ["marketing", "social"],
    project: "HELIX",
    createdAt: "2026-03-05",
    subtasks: [],
    activity: [{ id: "a22", text: "Task created", timestamp: "2026-03-05T11:00:00Z" }],
  },
  {
    id: "21",
    title: "Draft HELIX newsletter",
    description: "Monthly update for subscribers",
    status: "todo",
    priority: "low",
    assignedAgent: "echo",
    dueDate: "2026-03-14",
    tags: ["content"],
    project: "HELIX",
    createdAt: "2026-03-06",
    subtasks: [],
    activity: [{ id: "a23", text: "Task created", timestamp: "2026-03-06T12:00:00Z" }],
  },
  // Standalone tasks
  {
    id: "3",
    title: "Write LinkedIn thought piece",
    description: "AI in business operations",
    status: "done",
    priority: "medium",
    assignedAgent: "echo",
    dueDate: "2026-03-08",
    tags: ["content", "social"],
    createdAt: "2026-03-04",
    subtasks: [],
    activity: [
      { id: "a4", text: "Task created", timestamp: "2026-03-04T08:00:00Z" },
      { id: "a5", text: "Published", timestamp: "2026-03-08T11:00:00Z" },
    ],
  },
  {
    id: "5",
    title: "Research competitor pricing",
    description: "Deep dive into market rates",
    status: "todo",
    priority: "medium",
    assignedAgent: "sage",
    dueDate: "2026-03-12",
    tags: ["research"],
    createdAt: "2026-03-07",
    subtasks: [],
    activity: [{ id: "a7", text: "Task created", timestamp: "2026-03-07T10:00:00Z" }],
  },
  {
    id: "6",
    title: "Schedule family dinner",
    description: "Book restaurant for Saturday",
    status: "todo",
    priority: "low",
    assignedAgent: "ember",
    dueDate: "2026-03-09",
    tags: ["personal"],
    createdAt: "2026-03-07",
    subtasks: [],
    activity: [{ id: "a8", text: "Task created", timestamp: "2026-03-07T12:00:00Z" }],
  },
];

interface TaskStore {
  tasks: Task[];
  addTask: (task: Omit<Task, "id" | "createdAt" | "subtasks" | "activity">) => void;
  updateTaskStatus: (id: string, status: TaskStatus) => void;
  updateTask: (
    id: string,
    updates: Partial<
      Pick<
        Task,
        "title" | "description" | "priority" | "assignedAgent" | "dueDate" | "tags" | "project"
      >
    >,
  ) => void;
  addSubtask: (taskId: string, title: string) => void;
  toggleSubtask: (taskId: string, subtaskId: string) => void;
  deleteSubtask: (taskId: string, subtaskId: string) => void;
  deleteTask: (id: string) => void;
}

export const useTaskStore = create<TaskStore>()(
  persist(
    (set) => ({
      tasks: SEED_TASKS,
      addTask: (task) =>
        set((state) => ({
          tasks: [
            ...state.tasks,
            {
              ...task,
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
              subtasks: [],
              activity: [mkActivity("Task created")],
            },
          ],
        })),
      updateTaskStatus: (id, status) =>
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === id
              ? {
                  ...t,
                  status,
                  activity: [
                    ...t.activity,
                    mkActivity(`Status changed to ${status.replace("_", " ")}`),
                  ],
                }
              : t,
          ),
        })),
      updateTask: (id, updates) =>
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === id
              ? { ...t, ...updates, activity: [...t.activity, mkActivity(`Task updated`)] }
              : t,
          ),
        })),
      addSubtask: (taskId, title) =>
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  subtasks: [...t.subtasks, { id: crypto.randomUUID(), title, done: false }],
                  activity: [...t.activity, mkActivity(`Subtask added: ${title}`)],
                }
              : t,
          ),
        })),
      toggleSubtask: (taskId, subtaskId) =>
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  subtasks: t.subtasks.map((s) =>
                    s.id === subtaskId ? { ...s, done: !s.done } : s,
                  ),
                }
              : t,
          ),
        })),
      deleteSubtask: (taskId, subtaskId) =>
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId ? { ...t, subtasks: t.subtasks.filter((s) => s.id !== subtaskId) } : t,
          ),
        })),
      deleteTask: (id) => set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) })),
    }),
    { name: "mavis-tasks" },
  ),
);
