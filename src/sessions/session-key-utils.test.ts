import { describe, expect, it } from "vitest";
import { extractCronRunIdFromSessionKey, isCronRunSessionKey } from "./session-key-utils.js";

describe("extractCronRunIdFromSessionKey", () => {
  it("extracts the runId from a canonical cron-run sessionKey", () => {
    expect(extractCronRunIdFromSessionKey("agent:main:cron:job-1:run:run-1")).toBe("run-1");
    expect(
      extractCronRunIdFromSessionKey(
        "agent:email:cron:" +
          "ad576449-51d3-40ad-8a36-504dc6e933d4" +
          ":run:9463050f-1f77-4fa6-a02b-4222a5857462",
      ),
    ).toBe("9463050f-1f77-4fa6-a02b-4222a5857462");
  });

  it("returns null for non-cron-run keys", () => {
    expect(extractCronRunIdFromSessionKey("agent:main:main")).toBeNull();
    expect(extractCronRunIdFromSessionKey("agent:main:cron:job-1")).toBeNull();
    expect(extractCronRunIdFromSessionKey("agent:main:dreaming-narrative-light-abc")).toBeNull();
    expect(extractCronRunIdFromSessionKey("agent:main:healthcheck")).toBeNull();
    expect(extractCronRunIdFromSessionKey(undefined)).toBeNull();
    expect(extractCronRunIdFromSessionKey(null)).toBeNull();
    expect(extractCronRunIdFromSessionKey("")).toBeNull();
  });

  it("agrees with isCronRunSessionKey on accept/reject boundary", () => {
    const samples = [
      "agent:main:cron:job-1:run:run-1",
      "agent:main:cron:job-1",
      "agent:main:main",
      "agent:main:cron:job-1:run:",
      "not-an-agent-key",
    ];
    for (const sk of samples) {
      const isRun = isCronRunSessionKey(sk);
      const runId = extractCronRunIdFromSessionKey(sk);
      expect(runId === null).toBe(!isRun);
    }
  });
});
