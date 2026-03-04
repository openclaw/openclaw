import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmTask } from "./swarm.js";

const mocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: mocks.readFileSync,
  },
  readFileSync: mocks.readFileSync,
}));

const { swarmHandlers } = await import("./swarm.js");

type SwarmListPayload = {
  tasks: SwarmTask[];
  total: number;
  activeTasks: SwarmTask[];
  inactiveTasks: SwarmTask[];
  defaultStatusFilter: "active";
  inactiveCollapsedByDefault: true;
  sort: { field: "startedAt"; order: "desc" };
};

function makeTask(
  task: Partial<SwarmTask> & Pick<SwarmTask, "id" | "status" | "startedAt">,
): SwarmTask {
  return {
    id: task.id,
    agent: task.agent ?? "codex",
    repo: task.repo ?? "/tmp/repo",
    branch: task.branch ?? `agent-task/${task.id}`,
    worktree: task.worktree ?? `/tmp/worktrees/${task.id}`,
    host: task.host ?? "local",
    tmuxSession: task.tmuxSession ?? `agent-${task.id}`,
    description: task.description ?? task.id,
    startedAt: task.startedAt,
    status: task.status,
    notifyOnComplete: task.notifyOnComplete ?? true,
    pr: task.pr,
    checks: task.checks,
    completedAt: task.completedAt,
    note: task.note,
  };
}

function setRegistry(tasks: SwarmTask[]) {
  mocks.readFileSync.mockReturnValue(JSON.stringify({ tasks }));
}

async function invokeSwarmList(status?: string) {
  const respond = vi.fn();
  await swarmHandlers["swarm.list"]({
    req: {} as never,
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
    params: status ? { status } : {},
    respond: respond as never,
  });
  return respond;
}

function getPayload(respond: ReturnType<typeof vi.fn>): SwarmListPayload {
  return respond.mock.calls[0]?.[1] as SwarmListPayload;
}

describe("swarm.list", () => {
  beforeEach(() => {
    mocks.readFileSync.mockReset();
  });

  it("defaults to active tasks and includes sectioned lists sorted by startedAt desc", async () => {
    setRegistry([
      makeTask({ id: "running-old", status: "running", startedAt: 10 }),
      makeTask({ id: "failed-new", status: "failed", startedAt: 90 }),
      makeTask({ id: "running-new", status: "running", startedAt: 80 }),
      makeTask({ id: "done-mid", status: "done", startedAt: 50 }),
      makeTask({ id: "cleaned-old", status: "cleaned", startedAt: 20 }),
    ]);

    const respond = await invokeSwarmList();
    const payload = getPayload(respond);

    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(payload.tasks.map((task) => task.id)).toEqual(["running-new", "running-old"]);
    expect(payload.activeTasks.map((task) => task.id)).toEqual(["running-new", "running-old"]);
    expect(payload.inactiveTasks.map((task) => task.id)).toEqual([
      "failed-new",
      "done-mid",
      "cleaned-old",
    ]);
    expect(payload.defaultStatusFilter).toBe("active");
    expect(payload.inactiveCollapsedByDefault).toBe(true);
    expect(payload.sort).toEqual({ field: "startedAt", order: "desc" });
    expect(payload.total).toBe(5);
  });

  it("keeps done filter behavior as inactive tasks and includes cleaned status", async () => {
    setRegistry([
      makeTask({ id: "running", status: "running", startedAt: 100 }),
      makeTask({ id: "done", status: "done", startedAt: 300 }),
      makeTask({ id: "failed", status: "failed", startedAt: 200 }),
      makeTask({ id: "cleaned", status: "cleaned", startedAt: 400 }),
    ]);

    const respond = await invokeSwarmList("done");
    const payload = getPayload(respond);

    expect(payload.tasks.map((task) => task.id)).toEqual(["cleaned", "done", "failed"]);
  });

  it("returns all tasks newest-first when status=all", async () => {
    setRegistry([
      makeTask({ id: "old", status: "running", startedAt: 1 }),
      makeTask({ id: "newest", status: "done", startedAt: 3 }),
      makeTask({ id: "mid", status: "failed", startedAt: 2 }),
    ]);

    const respond = await invokeSwarmList("all");
    const payload = getPayload(respond);

    expect(payload.tasks.map((task) => task.id)).toEqual(["newest", "mid", "old"]);
  });

  it("returns empty sectioned payload when task registry is missing", async () => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error("missing");
    });

    const respond = await invokeSwarmList();
    const payload = getPayload(respond);

    expect(payload).toEqual({
      tasks: [],
      total: 0,
      activeTasks: [],
      inactiveTasks: [],
      defaultStatusFilter: "active",
      inactiveCollapsedByDefault: true,
      sort: { field: "startedAt", order: "desc" },
    });
  });
});
