import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadGoalFile, saveGoalFile, updatePhaseStatus } from "../goal.js";

describe("goal schema compatibility", () => {
  it("loads legacy passes-only phases", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claw-loop-vnext-goal-"));
    const file = path.join(dir, "goal.json");
    await writeFile(
      file,
      JSON.stringify({
        title: "x",
        workdir: "/tmp",
        status: "pending",
        phases: [
          { id: "P1", name: "Plan", passes: true },
          { id: "P2", name: "Implement", passes: false },
        ],
      }),
      "utf8",
    );

    const goal = await loadGoalFile(file);
    expect(goal.phases[0].status).toBe("complete");
    expect(goal.phases[1].status).toBe("pending");
  });

  it("prefers status when status and passes conflict", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claw-loop-vnext-goal-"));
    const file = path.join(dir, "goal.json");
    await writeFile(
      file,
      JSON.stringify({
        title: "x",
        workdir: "/tmp",
        status: "pending",
        phases: [{ id: "P1", name: "Plan", status: "pending", passes: true }],
      }),
      "utf8",
    );

    const goal = await loadGoalFile(file);
    expect(goal.phases[0].status).toBe("pending");
    expect(goal.phases[0].passes).toBe(false);
  });

  it("writes status and passes together", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claw-loop-vnext-goal-"));
    const file = path.join(dir, "goal.json");
    await writeFile(
      file,
      JSON.stringify({
        title: "x",
        workdir: "/tmp",
        status: "pending",
        phases: [{ id: "P1", name: "Plan", status: "pending" }],
      }),
      "utf8",
    );

    const goal = await loadGoalFile(file);
    const next = updatePhaseStatus(goal, "P1", "complete");
    await saveGoalFile(file, next);
    const saved = JSON.parse(await readFile(file, "utf8")) as {
      phases: Array<{ status: string; passes: boolean }>;
    };
    expect(saved.phases[0].status).toBe("complete");
    expect(saved.phases[0].passes).toBe(true);
  });
});
