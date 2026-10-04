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

describe("scheduled work uses the owning agent's current permissions", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });
  beforeEach(mockRunCronFallbackPassthrough);

  it.each([
    { toolsAllow: [], message: "Read the project notes" },
    { toolsAllow: ["exec", "message"], message: "Read the project notes" },
    { toolsAllow: ["retired_plugin_tool"], message: "Command to run:\n- command: read-notes" },
  ])(
    "does not turn a stored tool snapshot $toolsAllow into a different runtime",
    async ({ toolsAllow, message }) => {
      // Existing jobs must recover without an owner recreating them. The retired
      // snapshot stays on the stored record for rollback, but is not executable policy.
      const job = {
        id: "existing-scheduled-work",
        name: "Existing scheduled work",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message, toolsAllow },
        delivery: { mode: "none" },
        owner: { agentId: "main", sessionKey: "agent:main:chat:group:team", accountId: "default" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:chat:group:team",
          ownerAccountId: "default",
        },
        runtimeAuthorityRecoveryRequired: true,
        runtimeAuthority: {
          version: 1,
          runtimeId: "retired-runtime",
          namespace: "retired.apps",
          payload: {},
        },
      } satisfies Partial<CronStoredJob>;
      const before = structuredClone(job);
      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg: { tools: { deny: ["browser"] } },
          job,
          message: job.payload.message,
          sessionKey: `cron:${job.id}`,
        }),
      );

      expect(result.status).toBe("ok");

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = runEmbeddedAgentMock.mock.calls[0]?.[0];
      expect(call?.config?.tools?.deny).toEqual(["browser"]);
      expect(call?.scheduledToolPolicy).toMatchObject({
        mode: "account",
        ownerSessionKey: job.owner.sessionKey,
        ownerAccountId: job.owner.accountId,
      });
      expect(job).toEqual(before);
    },
  );
});
