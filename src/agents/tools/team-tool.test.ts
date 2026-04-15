import { afterEach, describe, expect, it } from "vitest";
import { resetTeamRegistryForTests } from "../team-registry.js";
import { createTeamTool } from "./team-tool.js";

describe("team tool", () => {
  afterEach(() => {
    resetTeamRegistryForTests();
  });

  it("creates and lists teams", async () => {
    const tool = createTeamTool();

    const created = await tool.execute("call-create", {
      action: "create",
      teamId: "ops",
      name: "Ops",
      members: ["alice", "bob"],
    });
    const createdDetails = created.details as {
      status: string;
      action: string;
      team?: { teamId?: string; members?: string[] };
    };
    expect(createdDetails.status).toBe("ok");
    expect(createdDetails.action).toBe("create");
    expect(createdDetails.team?.teamId).toBe("ops");

    const listed = await tool.execute("call-list", { action: "list" });
    const listedDetails = listed.details as {
      status: string;
      action: string;
      count: number;
      teams: Array<{ teamId: string }>;
    };
    expect(listedDetails.status).toBe("ok");
    expect(listedDetails.action).toBe("list");
    expect(listedDetails.count).toBe(1);
    expect(listedDetails.teams.map((entry) => entry.teamId)).toEqual(["ops"]);
  });

  it("updates and deletes teams", async () => {
    const tool = createTeamTool();
    await tool.execute("call-create", {
      action: "create",
      teamId: "eng",
      name: "Engineering",
    });

    const updated = await tool.execute("call-update", {
      action: "update",
      teamId: "eng",
      description: "Build core runtime",
      labels: ["runtime", "parity"],
    });
    const updatedDetails = updated.details as {
      status: string;
      action: string;
      team?: { description?: string; labels?: string[] };
    };
    expect(updatedDetails.status).toBe("ok");
    expect(updatedDetails.action).toBe("update");
    expect(updatedDetails.team?.description).toBe("Build core runtime");
    expect(updatedDetails.team?.labels).toEqual(["runtime", "parity"]);

    const removed = await tool.execute("call-delete", {
      action: "delete",
      teamId: "eng",
    });
    const removedDetails = removed.details as {
      status: string;
      action: string;
      deleted: boolean;
    };
    expect(removedDetails.status).toBe("ok");
    expect(removedDetails.action).toBe("delete");
    expect(removedDetails.deleted).toBe(true);
  });
});
