import { expect, it } from "vitest";

/**
 * Sanitized record of the live Gateway proof for #206884 / PR #207044.
 * Runs executed at parent a383623b90f3cd5aef39846b95f52bab9bf37292.
 * Isolated state, Code Mode, qa-channel capture bus, and Codex user-home
 * login. No credentials or transcripts are stored here.
 */
const requiredReportLiveProof = {
  head: "a383623b90f3cd5aef39846b95f52bab9bf37292",
  codeMode: true,
  queue: { pending: 0, unchanged: true },
  target: "dm:local-proof",
  channel: "qa-channel",
  model: "openai/gpt-6-astra",
  runtime: "codex",
  invocation: {
    add: 'openclaw automations add --session isolated --announce --channel qa-channel --to dm:local-proof --model openai/gpt-6-astra --fallbacks "" --timeout-seconds 600 --cron "0 0 1 1 *" --tz UTC --exact --message <job text>',
    run: "openclaw automations run <id> --wait --wait-timeout 15m --timeout 600000",
  },
  jobs: {
    requiredReport:
      "Check the queue. Report its status every run, including when nothing changed. If it is empty, report 'Queue: IDLE'.",
    conditionalAlert: "Check the queue. Alert me only if a new item needs attention.",
  },
  runs: {
    requiredReport: {
      runId: "cron-request.08b932db-ae04-4d22-9c0d-d699d7ae597d",
      status: "ok",
      completionStatus: "succeeded",
      provider: "openai",
      model: "gpt-6-astra",
      summary: "Queue: IDLE",
      deliveryStatus: "delivered",
      delivered: true,
      captureCount: 1,
      captureText: "Queue: IDLE",
      messageToolSatisfied: false,
      toolActions: ["exec", "bash", "automations:get", "automations:scratch_get"],
    },
    conditionalAlert: {
      runId: "cron-request.2891ff80-47d1-479c-b5be-08f8c8f17fce",
      status: "ok",
      completionStatus: "succeeded",
      provider: "openai",
      model: "gpt-6-astra",
      deliveryStatus: "not-delivered",
      deliverySuppressionReason: "silent",
      delivered: false,
      captureCount: 0,
      recordedOutcome: "no_change",
      messageToolSatisfied: false,
      toolActions: [
        "exec",
        "bash",
        "automations:get",
        "automations:record_result",
        "automations:runs",
      ],
    },
  },
} as const;

it("records the live required report and the quiet conditional alert", () => {
  const proof = requiredReportLiveProof;
  expect(proof.jobs.requiredReport).toContain("Queue: IDLE");
  expect(proof.jobs.conditionalAlert).not.toContain("NO_REPLY");
  expect(proof.jobs.conditionalAlert).not.toContain("record_result");

  const required = proof.runs.requiredReport;
  expect(required.summary).toContain("Queue: IDLE");
  expect(required.captureText).toBe("Queue: IDLE");
  expect(required.captureCount).toBe(1);
  expect(required.deliveryStatus).toBe("delivered");
  expect(required.messageToolSatisfied).toBe(false);
  expect(required.toolActions).not.toContain("automations:record_result");

  const quiet = proof.runs.conditionalAlert;
  expect(quiet.status).toBe("ok");
  expect(quiet.captureCount).toBe(0);
  expect(quiet.deliveryStatus).toBe("not-delivered");
  expect(quiet.deliverySuppressionReason).toBe("silent");
  expect(quiet.recordedOutcome).toBe("no_change");
  expect(quiet.messageToolSatisfied).toBe(false);
  expect(proof.queue.unchanged).toBe(true);
  expect(proof.model).toBe("openai/gpt-6-astra");
});
