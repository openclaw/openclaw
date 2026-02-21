import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";

describe("schedule/lock", () => {
  it("prevents overlapping runs", async () => {
    await withTempHome(async () => {
      const { acquireJobLock, JobLockedError } = await import("./lock.js");

      const lock1 = await acquireJobLock("job1");
      await expect(acquireJobLock("job1")).rejects.toBeInstanceOf(JobLockedError);
      await lock1.release();

      const lock2 = await acquireJobLock("job1");
      await lock2.release();
    });
  });
});
