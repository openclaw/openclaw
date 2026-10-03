import {
  appendCronJobScratchPrompt,
  appendCronUnattendedRunPreamble,
} from "../../../src/cron/run-prompt.js";
import {
  claimAgentRunContext,
  releaseAgentRunContext,
} from "../../../src/infra/agent-run-registry.js";

const AUTOMATION_JOB_ID = "nightly-build-check";

export const AUTOMATION_SNAPSHOT_PROMPT = appendCronJobScratchPrompt(
  appendCronUnattendedRunPreamble("Check whether the nightly build needs attention.", {
    externalHook: false,
  }),
  {
    content: "Report a newly failed build once; keep the last checked build here.",
    revision: 1,
    updatedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
  },
);

/** Build the real tool schema inside a claimed invocation; no host tool is executed. */
export function withPromptSnapshotRun<T>(
  trigger: "user" | "cron",
  build: (identity: { runId: string; jobId?: string }) => T,
): T {
  const runId = `run-tools-${trigger}`;
  if (trigger !== "cron") {
    return build({ runId });
  }
  const invocation = {
    pacingEnabled: false,
    closed: false,
    assertCurrent() {
      if (invocation.closed) {
        throw new Error("Prompt snapshot automation is closed");
      }
    },
  };
  const claim = claimAgentRunContext(
    runId,
    { cronRunsByJobId: new Map([[AUTOMATION_JOB_ID, invocation]]) },
    { trackOwner: true, ownsContext: true },
  );
  try {
    return build({ runId, jobId: AUTOMATION_JOB_ID });
  } finally {
    invocation.closed = true;
    releaseAgentRunContext(runId, claim);
  }
}
