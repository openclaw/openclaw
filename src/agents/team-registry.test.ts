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
    });
    expect(created.teamId).toBe("ops");
    expect(created.members).toEqual(["alice", "bob"]);
    expect(created.labels).toEqual(["oncall", "infra"]);

    const teams = listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]?.teamId).toBe("ops");
  });

  it("updates and deletes teams", () => {
    createTeam({ teamId: "eng", name: "Engineering" });
    const updated = updateTeam("eng", {
      description: "Core engineering",
      members: ["dev-a", "dev-b"],
    });
    expect(updated.description).toBe("Core engineering");
    expect(updated.members).toEqual(["dev-a", "dev-b"]);

    expect(getTeam("eng")?.description).toBe("Core engineering");
    expect(deleteTeam("eng")).toBe(true);
    expect(getTeam("eng")).toBeNull();
  });
});
