import { afterEach, describe, expect, it } from "vitest";
import {
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  resetTeamRegistryForTests,
  updateTeam,
} from "./team-registry.js";

describe("team registry", () => {
  afterEach(() => {
    resetTeamRegistryForTests();
  });

  it("creates and lists teams", () => {
    const created = createTeam({
      teamId: "ops",
      name: "Ops Team",
      members: ["alice", "bob", "alice"],
      labels: ["oncall", "infra", "oncall"],
      taskIds: ["task_a", "task_b", "task_a"],
    });
    expect(created.teamId).toBe("ops");
    expect(created.status).toBe("active");
    expect(created.members).toEqual(["alice", "bob"]);
    expect(created.labels).toEqual(["oncall", "infra"]);
    expect(created.taskIds).toEqual(["task_a", "task_b"]);

    const teams = listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]?.teamId).toBe("ops");
  });

  it("updates and deletes teams", () => {
    createTeam({ teamId: "eng", name: "Engineering" });
    const updated = updateTeam("eng", {
      description: "Core engineering",
      members: ["dev-a", "dev-b"],
      taskIds: ["task_1"],
    });
    expect(updated.description).toBe("Core engineering");
    expect(updated.members).toEqual(["dev-a", "dev-b"]);
    expect(updated.taskIds).toEqual(["task_1"]);

    expect(getTeam("eng")?.description).toBe("Core engineering");
    expect(deleteTeam("eng")).toBe(true);
    expect(getTeam("eng")).toBeNull();
  });
});
