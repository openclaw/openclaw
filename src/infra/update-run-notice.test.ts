import { describe, expect, it } from "vitest";
import {
  isUpdateRunTerminalNoticeText,
  renderUpdateRunNotice,
  renderUpdateRunSummary,
} from "./update-run-notice.js";
import type { UpdateRunRecord } from "./update-run-record.js";

describe("update conversation notices", () => {
  const cases: [UpdateRunRecord["status"], string | null, string][] = [
    ["succeeded", null, "✅ OpenClaw updated."],
    [
      "rolled-back",
      "restart-unhealthy",
      "↩️ The update couldn't finish. OpenClaw returned to the previous version.",
    ],
    ["skipped", "container-image-install", "ℹ️ OpenClaw wasn't updated."],
    ["skipped", "already-current", "✅ OpenClaw is already up to date."],
    [
      "skipped",
      "managed-service-handoff-already-running",
      "⚠️ A previous update still holds this installation.",
    ],
    ["skipped", "still-starting", "⏳ OpenClaw is installed and still starting."],
    [
      "skipped",
      "gateway-readiness-unverified",
      "⚠️ OpenClaw is installed, but we couldn't confirm it's ready.",
    ],
  ];
  it.each(cases)("explains %s (%s) with its outcome", (status, reason, headline) => {
    const record = { status, phase: "finished" as const, reason };
    const text = renderUpdateRunSummary(record);
    expect(renderUpdateRunNotice(record, "finished")).toBe(status === "running" ? null : text);
    expect(isUpdateRunTerminalNoticeText(text)).toBe(status !== "running");
    expect(
      isUpdateRunTerminalNoticeText(text.replace("in the OpenClaw app", "in the Control UI")),
    ).toBe(status !== "running");
    expect(text.split("\n")).toEqual([
      headline,
      "For details, open Settings → Updates in the OpenClaw app or run `openclaw update status` in your terminal.",
    ]);
  });

  it.each([
    ["succeeded", null, "⚠️ OpenClaw updated to 2026.9.2."],
    ["skipped", "already-current", "✅ OpenClaw is already up to date."],
    ["skipped", "still-starting", "⏳ OpenClaw is installed and still starting."],
  ] as const)(
    "names failed maintenance without changing the %s core outcome (%s)",
    (status, reason, expectedHeadline) => {
      const action = "Run `openclaw plugins reload brave codex`.";
      const record = {
        status,
        phase: "finished" as const,
        reason,
        after: { version: "2026.9.2" },
        steps: [{ step: "plugins", status: "failed" as const }],
        origin: { nextAction: action },
      };
      const text = renderUpdateRunSummary(record);
      expect(text).toBe(`${expectedHeadline}\nFailed step: plugins.\nNext: ${action}`);
      expect(renderUpdateRunNotice(record, "finished")).toBe(text);
      expect(isUpdateRunTerminalNoticeText(text)).toBe(true);
      expect(record.status).toBe(status);
    },
  );

  it("only announces the current milestone", () => {
    const requested = { status: "running" as const, phase: "requested" as const, reason: null };
    expect(renderUpdateRunNotice(requested, "parking")).toBe(
      "⏳ Preparing to restart OpenClaw… The update is not complete yet.",
    );
    expect(renderUpdateRunNotice({ ...requested, phase: "activating" }, "activating")).toBe(
      "⏳ Preparing to restart OpenClaw… The update is not complete yet.",
    );
    expect(renderUpdateRunNotice(requested, "activating")).toBeNull();
    expect(renderUpdateRunNotice(requested, "verifying")).toBeNull();
    expect(renderUpdateRunNotice(requested, "finished")).toBeNull();
    for (const phase of ["staging", "activating", "verifying"] as const) {
      const progressed = { ...requested, phase };
      expect(renderUpdateRunNotice(progressed, "parking")).toBeNull();
      expect(renderUpdateRunNotice(progressed, "ack")).toBeNull();
      expect(renderUpdateRunSummary(progressed)).toContain(
        `OpenClaw update in progress: ${phase}.`,
      );
    }
    expect(
      renderUpdateRunNotice({ status: "succeeded", phase: "finished", reason: null }, "parking"),
    ).toBeNull();
  });

  it("keeps the recorded failure cause in the shared terminal summary", () => {
    const run = {
      status: "failed" as const,
      phase: "finished" as const,
      reason: "build-failed",
      steps: [{ step: "build", status: "failed" as const, detail: "Disk is full\nFree space" }],
    };
    const text = renderUpdateRunSummary(run);
    expect(text).toContain("(build-failed). Disk is full Free space");
    expect(renderUpdateRunNotice(run, "finished")).toBe(text);
    expect(isUpdateRunTerminalNoticeText(text)).toBe(true);
  });

  it.each(["succeeded", "failed"] as const)("labels a standalone %s repair", (status) => {
    const run = {
      status,
      phase: "finished" as const,
      reason: status === "failed" ? "repair-failed" : null,
      after: { version: "2.0.0" },
      steps: [
        {
          step: "repairing",
          status: status === "failed" ? ("failed" as const) : ("completed" as const),
        },
        ...(status === "succeeded"
          ? [
              {
                step: "finalize:repaired-run",
                status: "completed" as const,
                detail: "The earlier update failed during Gateway readiness.",
              },
            ]
          : []),
      ],
    };
    const text = renderUpdateRunSummary(run);
    expect(text.split("\n")[0]).toBe(
      status === "succeeded"
        ? "✅ OpenClaw repair completed for 2.0.0."
        : "⚠️ OpenClaw repair failed: repair-failed.",
    );
    expect(text).not.toContain("OpenClaw updated");
    if (status === "succeeded") {
      expect(text).toContain(
        "Repaired update: The earlier update failed during Gateway readiness.",
      );
    }
    expect(isUpdateRunTerminalNoticeText(text)).toBe(true);
  });

  it("keeps the completed startup refusal's cause and remedy", () => {
    const remedy = "Run `openclaw --profile work doctor --fix` before retrying.";
    const text = renderUpdateRunSummary({
      status: "failed",
      reason: "candidate-refused-startup",
      steps: [
        {
          step: "diagnostic:startup",
          status: "completed",
          detail: `Invalid gateway configuration.\n${remedy}`,
        },
      ],
    });
    expect(text).toContain("Invalid gateway configuration.");
    expect(text).toContain(remedy);
    expect(isUpdateRunTerminalNoticeText(text)).toBe(true);
  });

  it("preserves named facts, full tails and the compensation refusal", () => {
    const message = "Gateway did not settle; startup phase: waiting for managed service";
    const compensation = "restoring the backup would discard later writes";
    const text = renderUpdateRunSummary({
      status: "failed",
      reason: "post-update-failed",
      steps: [
        {
          step: "gateway verification",
          status: "failed",
          detail: "Permission denied.",
          stderrTail: "EACCES: cannot write the update payload",
          failureFacts: [{ check: "gateway", code: "post-update-failed", message }],
        },
      ],
      verification: { rollbackOutcome: { status: "not-attempted", reason: compensation } },
    });
    for (const fact of [
      "gateway verification",
      message,
      "EACCES",
      compensation,
      "openclaw triage",
      "openclaw update status",
    ]) {
      expect(text).toContain(fact);
    }
    expect(isUpdateRunTerminalNoticeText(text)).toBe(true);
  });

  it("retains the initiating signal after a rollback", () => {
    const cause = "interrupted by SIGHUP during activating";
    const text = renderUpdateRunSummary({
      status: "rolled-back",
      reason: "interrupted",
      steps: [{ step: "activating", status: "failed", stderrTail: cause }],
    });
    expect(text).toContain(cause);
    expect(isUpdateRunTerminalNoticeText(text)).toBe(true);
  });

  it("does not repeat repair advice for acknowledged abandoned history", () => {
    const run = {
      status: "failed" as const,
      reason: "abandoned",
      steps: [{ step: "reconcile:acknowledged", status: "completed" as const }],
      origin: { nextAction: "Run `openclaw update repair` before retrying." },
    };
    const text = renderUpdateRunSummary(run);
    expect(text).toContain("abandoned update reconciled");
    expect(text).not.toContain("openclaw update repair");
    expect(run.status).toBe("failed");
    expect(isUpdateRunTerminalNoticeText(text)).toBe(true);
  });
});
