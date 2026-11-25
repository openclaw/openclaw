import { expect, it } from "vitest";
import { describeSeamKinds, determineSeamTestStatus } from "../../scripts/audit-seams.mts";

it.each([
  [
    "src/cron/service/ops-lifecycle.ts",
    `
      import { recomputeNextRunsForMaintenance, computeJobNextRunAtMs } from "./jobs-scheduling.js";
      import { ensureLoaded, persist } from "./store.js";
      import { armTimer, runMissedJobs } from "./timer.js";
    `,
    expect.arrayContaining(["cron-scheduler-state"]),
  ],
  [
    "src/agents/subagents/spawn/subagent-spawn.ts",
    `
      import { callGateway } from "../../../gateway/call.js";
      import { registerSubagentRun } from "../../subagent-registry.js";
      import { emitSessionLifecycleEvent } from "./subagent-spawn.runtime.js";
      await callGateway({ method: "sessions.delete" });
    `,
    ["subagent-lifecycle-registry", "subagent-session-cleanup", "subagent-session-spawn"],
  ],
  [
    "src/agents/subagents/registry/subagent-registry.ts",
    `
      import { resolveContextEngine } from "../context-engine/registry.js";
      import { captureSubagentCompletionReply, runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
      import { emitSubagentEndedHookOnce } from "./subagent-registry-completion.js";
      import { persistSubagentRunsToDisk } from "./subagent-registry-state.js";
    `,
    ["subagent-announce-delivery", "subagent-lifecycle-registry"],
  ],
  [
    "src/agents/subagents/spawn/acp-spawn-parent-stream.ts",
    `
      import { onAgentEvent } from "../../../infra/agent-events.js";
      import { requestHeartbeat } from "../../../infra/heartbeat-wake.js";
      import { enqueueSystemEvent } from "../../../infra/system-events.js";
    `,
    ["subagent-parent-stream"],
  ],
] as const)("classifies seams in %s", (file, source, expected) =>
  expect(describeSeamKinds(file, source)).toEqual(expected),
);
it("keeps subagent seam statuses conservative when nearby tests exist", () => {
  expect(
    determineSeamTestStatus(
      ["subagent-session-spawn"],
      [
        {
          file: "src/agents/subagents/spawn/subagent-spawn.workspace.test.ts",
          matchQuality: "direct-import",
        },
      ],
    ),
  ).toEqual({
    status: "partial",
    reason:
      "Nearby tests exist (best match: direct-import), but this inventory does not prove cross-layer seam coverage end to end.",
  });
});
