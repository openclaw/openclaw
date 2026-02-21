import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";

describe("schedule/store", () => {
  it("adds, lists, and removes jobs", async () => {
    await withTempHome(async () => {
      const { loadScheduleFile, addOrUpdateJob, removeJob, getJob } = await import("./store.js");

      expect((await loadScheduleFile()).jobs).toEqual([]);

      const addRes = await addOrUpdateJob({
        id: "job1",
        cmd: "node",
        args: ["-v"],
        description: "test",
      });
      expect(addRes.created).toBe(true);

      const file = await loadScheduleFile();
      expect(file.jobs.map((j) => j.id)).toEqual(["job1"]);

      const job = await getJob("job1");
      expect(job?.cmd).toBe("node");

      const rm = await removeJob("job1");
      expect(rm.removed).toBe(true);
      expect((await loadScheduleFile()).jobs).toEqual([]);
    });
  });
});
