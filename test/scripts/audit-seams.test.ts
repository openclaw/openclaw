import { describe, expect, it } from "vitest";
import {
  HELP_TEXT,
  describeSeamKinds,
  determineSeamTestStatus,
} from "../../scripts/audit-seams.mjs";

describe("audit-seams cron seam classification", () => {
  it("detects cron agent handoff and outbound delivery boundaries", () => {
    const source = `
      import { runCliAgent } from "../../agents/cli-runner.js";
      import { runWithModelFallback } from "../../agents/model-fallback.js";
      import { registerAgentRunContext } from "../../infra/agent-events.js";
      import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
      import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";

      export async function runCronIsolatedAgentTurn() {
        registerAgentRunContext({});
        await runWithModelFallback(() => runCliAgent({}));
        await deliverOutboundPayloads({ payloads: [{ text: "done" }] });
        return buildOutboundSessionContext({});
      }
    `;

    expect(describeSeamKinds("src/cron/isolated-agent/run.ts", source)).toEqual([
      "cron-agent-handoff",
      "cron-outbound-delivery",
    ]);
  });

  it("detects scheduler-state seams in cron service orchestration", () => {
    const source = `
      import { recomputeNextRuns, computeJobNextRunAtMs } from "./jobs.js";
      import { ensureLoaded, persist } from "./store.js";
      import { armTimer, runMissedJobs } from "./timer.js";

      export async function start(state) {
        await ensureLoaded(state);
        recomputeNextRuns(state);
        await persist(state);
        armTimer(state);
        await runMissedJobs(state);
        return computeJobNextRunAtMs(state.store.jobs[0], Date.now());
      }
    `;

    expect(describeSeamKinds("src/cron/service/ops.ts", source)).toContain("cron-scheduler-state");
  });

  it("detects heartbeat, media, and followup handoff seams", () => {
    const source = `
      import { stripHeartbeatToken } from "../../auto-reply/heartbeat.js";
      import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
      import { callGateway } from "../../gateway/call.js";
      import { waitForDescendantSubagentSummary } from "./subagent-followup.js";

      export async function dispatchCronDelivery(payloads) {
        const heartbeat = stripHeartbeatToken(payloads[0]?.text ?? "", { mode: "heartbeat" });
        await waitForDescendantSubagentSummary({ sessionKey: "agent:main:cron:job-1", timeoutMs: 1 });
        await callGateway({ method: "agent.wait", params: { runId: "run-1" } });
        return { heartbeat, mediaUrl: payloads[0]?.mediaUrl, sent: deliverOutboundPayloads };
      }
    `;

    expect(describeSeamKinds("src/cron/isolated-agent/delivery-dispatch.ts", source)).toEqual([
      "cron-followup-handoff",
      "cron-heartbeat-handoff",
      "cron-media-delivery",
      "cron-outbound-delivery",
    ]);
  });

  it("ignores pure cron helpers without subsystem crossings", () => {
    const source = `
      import { truncateUtf16Safe } from "../../utils.js";

      export function normalizeOptionalText(raw) {
        if (typeof raw !== "string") return undefined;
        return truncateUtf16Safe(raw.trim(), 40);
      }
    `;

    expect(describeSeamKinds("src/cron/service/normalize.ts", source)).toEqual([]);
  });
});

describe("audit-seams cron status/help", () => {
  it("keeps cron seam statuses conservative when nearby tests exist", () => {
    expect(
      determineSeamTestStatus(
        ["cron-agent-handoff"],
        [{ file: "src/cron/service.issue-regressions.test.ts", matchQuality: "path-nearby" }],
      ),
    ).toEqual({
      status: "partial",
      reason:
        "Nearby tests exist (best match: path-nearby), but this inventory does not prove cross-layer seam coverage end to end.",
    });
  });

  it("documents cron seam coverage in help text", () => {
    expect(HELP_TEXT).toContain("cron orchestration seams");
    expect(HELP_TEXT).toContain("agent handoff");
    expect(HELP_TEXT).toContain("heartbeat/followup handoff");
  });
});
