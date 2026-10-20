import { describe, expect, it } from "vitest";
import { describeSeamKinds, determineSeamTestStatus } from "../../scripts/audit-seams.mts";

describe("audit-seams classification and status", () => {
  it("detects scheduler-state seams in cron service orchestration", () => {
    const source = `
      import { recomputeNextRunsForMaintenance, computeJobNextRunAtMs } from "./jobs-scheduling.js";
      import { ensureLoaded, persist } from "./store.js";
      import { armTimer, runMissedJobs } from "./timer.js";
    `;

    expect(describeSeamKinds("src/cron/service/ops-lifecycle.ts", source)).toContain(
      "cron-scheduler-state",
    );
  });
  it("detects relocated native spawn executor seams", () => {
    const source = `
      import { callGateway } from "../../../gateway/call.js";
      import { registerSubagentRun } from "../../subagent-registry.js";
      import { emitSessionLifecycleEvent } from "./subagent-spawn.runtime.js";
      await callGateway({ method: "sessions.delete" });
    `;

    expect(describeSeamKinds("src/agents/subagents/spawn/subagent-spawn.ts", source)).toEqual([
      "subagent-lifecycle-registry",
      "subagent-session-cleanup",
      "subagent-session-spawn",
    ]);
  });

  it("detects subagent lifecycle registry and announce delivery seams", () => {
    const source = `
      import { resolveContextEngine } from "../context-engine/registry.js";
      import { captureSubagentCompletionReply, runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
      import { emitSubagentEndedHookOnce } from "./subagent-registry-completion.js";
      import { persistSubagentRunsToDisk } from "./subagent-registry-state.js";
    `;

    expect(describeSeamKinds("src/agents/subagents/registry/subagent-registry.ts", source)).toEqual(
      ["subagent-announce-delivery", "subagent-lifecycle-registry"],
    );
  });

  it("detects parent-stream seams for ACP spawn relays", () => {
    const source = `
      import { onAgentEvent } from "../../../infra/agent-events.js";
      import { requestHeartbeat } from "../../../infra/heartbeat-wake.js";
      import { enqueueSystemEvent } from "../../../infra/system-events.js";
    `;

    expect(
      describeSeamKinds("src/agents/subagents/spawn/acp-spawn-parent-stream.ts", source),
    ).toEqual(["subagent-parent-stream"]);
  });
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
});
