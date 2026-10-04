// Legacy jobs retain authenticated owner context while using current agent tools.
import { beforeEach, describe, expect, it } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import type { CronStoredJob } from "../types.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const policy: NonNullable<CronStoredJob["scheduledToolPolicy"]> = {
  version: 1,
  mode: "account",
  ownerSessionKey: "agent:main:whatsapp:group:team",
  ownerAccountId: "default",
};

function makeParams(job: Partial<CronStoredJob> = {}) {
  return makeIsolatedAgentParamsFixture({
    message: "check allowed tools",
    sessionKey: "cron:tools-allow",
    job: {
      id: "tools-allow",
      name: "Tools Allow",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      owner: { agentId: "main", sessionKey: policy.ownerSessionKey, accountId: "default" },
      scheduledToolPolicy: policy,
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "external", channel: "whatsapp" },
      },
      payload: { kind: "agentTurn", message: "check allowed tools", toolsAllow: ["cron"] },
      ...job,
    },
  });
}

describe("legacy scheduled owner context", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });
  beforeEach(mockRunCronFallbackPassthrough);

  it("keeps accountless legacy jobs on the sender-policy path", async () => {
    await runCronIsolatedAgentTurn(
      makeParams({ owner: { agentId: "main", sessionKey: policy.ownerSessionKey } }),
    );
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.scheduledToolPolicy).toBeUndefined();
  });

  it("retains the exact self-management job scope and authenticated owner", async () => {
    await runCronIsolatedAgentTurn(makeParams());
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      jobId: "tools-allow",
      scheduledToolPolicy: { ...policy, ownerOrigin: { kind: "external", channel: "whatsapp" } },
    });
  });

  it("preserves local provenance for scheduled message tools", async () => {
    await runCronIsolatedAgentTurn(
      makeParams({
        toolsAllowProvenance: {
          version: 1,
          source: "final-executable-surface",
          callerOrigin: { kind: "local" },
        },
      }),
    );
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]?.scheduledToolPolicy).toEqual({
      ...policy,
      ownerOrigin: { kind: "local" },
    });
  });
});
