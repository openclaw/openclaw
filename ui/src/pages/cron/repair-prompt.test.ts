import { describe, expect, it } from "vitest";
import type { CronRunLogEntry } from "../../api/types.ts";
import { buildCronRepairDraft, buildCronRepairPrompt } from "./repair-prompt.ts";

const failedRun: CronRunLogEntry = {
  ts: Date.UTC(2026, 9, 2, 19, 46),
  runAtMs: Date.UTC(2026, 9, 2, 19, 45),
  jobId: "orders4-hls-run5-completion",
  jobName: "orders4-hls-run5-completion",
  runId: "run-95",
  action: "finished",
  status: "error",
  error: "cron trigger evaluation failed: ReferenceError: exec is not defined",
};

describe("cron repair handoff", () => {
  it("identifies the exact failed run and keeps retry separate from repair", () => {
    const prompt = buildCronRepairPrompt(failedRun);
    const draft = buildCronRepairDraft(failedRun);

    for (const text of [prompt, draft]) {
      expect(text).toContain("orders4-hls-run5-completion");
      expect(text).toContain("run-95");
      expect(text).toContain("2026-10-02T19:46:00.000Z");
      expect(text).toContain("2026-10-02T19:45:00.000Z");
      expect(text).toContain("before rerunning");
    }
    expect(prompt).toContain("exec is not defined");
    expect(draft).not.toContain("exec is not defined");
    expect(prompt).toContain("source fix");
    expect(draft).toContain("automation");
  });

  it("redacts secrets in source fields before bounding copied diagnostics", () => {
    const privateKey =
      "-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----";
    const prompt = buildCronRepairPrompt({
      ...failedRun,
      jobName: "Bearer abcdefghijklmnopqrstuvwxyz",
      error: `Failed: ${"x".repeat(1_150)} ${privateKey}`,
      summary: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      deliveryError: "token=super-secret-value",
    });

    expect(prompt).toContain("[redacted private key]");
    expect(prompt).not.toContain("secret-key-material");
    expect(prompt).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(prompt).not.toContain("super-secret-value");
    expect(prompt.length).toBeLessThan(3_500);
  });

  it("copies bounded structured diagnostics with fully masked credentials", () => {
    const prompt = buildCronRepairPrompt({
      ...failedRun,
      error: "https://alice:abcdefghijk@example.test/check?token=abcdefghijk",
      diagnostics: {
        summary: "tool unavailable",
        entries: [
          {
            ts: failedRun.ts,
            source: "tool",
            severity: "error",
            message: "exec was unavailable: API_KEY=abcdefghijk",
            toolName: "exec",
          },
        ],
      },
    });
    expect(prompt).toContain("tool unavailable");
    expect(prompt).toContain("exec was unavailable");
    expect(prompt).toContain("[redacted]");
    expect(prompt).not.toContain("abcdef");
    expect(prompt.length).toBeLessThan(3_500);
    expect(buildCronRepairDraft(failedRun)).not.toContain("exec was unavailable");
  });

  it("explains unavailable exact lookup and distinguishes a delivery error", () => {
    const deliveryWarning: CronRunLogEntry = {
      ...failedRun,
      runId: undefined,
      runAtMs: undefined,
      status: "ok",
      completionStatus: "succeeded",
      error: undefined,
      deliveryError: "delivery rejected",
    };
    for (const text of [
      buildCronRepairDraft(deliveryWarning),
      buildCronRepairPrompt(deliveryWarning),
    ]) {
      expect(text).toContain("cannot select the exact transcript");
      expect(text).toContain('"issue": "delivery error"');
      expect(text).not.toContain("failed automation");
    }
  });
});
