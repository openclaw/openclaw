import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../../cron/agent-id.js";
import type { CronStoredJob } from "../../cron/types.js";
import { captureCronUpdatedInferenceBinding } from "./cron-input-validation.js";

// An agent-less stored job: the scheduler runs it under the ambient owner.
const agentlessJob = {
  id: "job-1",
  name: "status",
  enabled: true,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "check status" },
  createdAtMs: 0,
  updatedAtMs: 0,
} as unknown as CronStoredJob;

const explicitFleet = (systemAgentId?: string): OpenClawConfig =>
  ({
    agents: {
      ownership: "explicit",
      ...(systemAgentId ? { defaults: { systemAgent: { agentId: systemAgentId } } } : {}),
      entries: { main: {}, worker: {} },
    },
  }) as OpenClawConfig;

const caller = {} as Parameters<typeof captureCronUpdatedInferenceBinding>[3];

describe("captureCronUpdatedInferenceBinding owner resolution", () => {
  it("edits an agent-less job on the configured system agent of a multi-agent gateway", async () => {
    await expect(
      captureCronUpdatedInferenceBinding(
        agentlessJob,
        { enabled: false },
        explicitFleet("main"),
        caller,
      ),
    ).resolves.toBeUndefined();
  });

  it("reports the cron ownership hint when no system agent is configured", async () => {
    await expect(
      captureCronUpdatedInferenceBinding(agentlessJob, { enabled: false }, explicitFleet(), caller),
    ).rejects.toThrow(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
  });
});
