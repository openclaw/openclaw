import { describe, expect, it } from "vitest";
import { resolveTurnAuthorityAuthorization } from "../../plugins/turn-authority.js";
import { createCronTurnAuthoritySnapshot } from "./turn-authority.js";

function createAuthority(jobId: string, runId: string) {
  return createCronTurnAuthoritySnapshot({
    jobId,
    agentId: "main",
    sessionKey: `agent:main:cron:${jobId}:run:${runId}`,
    sessionId: runId,
    runId,
  });
}

describe("createCronTurnAuthoritySnapshot", () => {
  it("keeps controller identity stable per job while freezing each run scope", () => {
    const first = createAuthority("job-a", "run-1");
    const next = createAuthority("job-a", "run-2");
    const other = createAuthority("job-b", "run-1");

    expect(first.controllerKey).toBe("service:cron:job-a");
    expect(next.controllerKey).toBe(first.controllerKey);
    expect(other.controllerKey).not.toBe(first.controllerKey);
    expect(resolveTurnAuthorityAuthorization(first)).toEqual({
      principal: { kind: "service", serviceId: "cron" },
      agentId: "main",
      sessionKey: "agent:main:cron:job-a:run:run-1",
      sessionId: "run-1",
      runId: "run-1",
      conversationId: "agent:main:cron:job-a:run:run-1",
      trigger: "cron",
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.authorization)).toBe(true);
    expect(Object.isFrozen(first.authorization.principal)).toBe(true);
  });

  it("rejects an empty job identity", () => {
    expect(() => createAuthority(" ", "run-1")).toThrow(/requires a job id/u);
  });
});
