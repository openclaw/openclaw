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

  it.each(["succeeded", "skipped"] as const)(
    "names failed maintenance without changing the %s core outcome",
    (status) => {
      const action = "Run `openclaw plugins reload brave codex`.";
      const record = {
        status,
        phase: "finished" as const,
        reason: null,
        after: { version: "2026.9.2" },
        steps: [{ step: "plugins", status: "failed" as const }],
        origin: { nextAction: action },
      };
      const text = renderUpdateRunSummary(record);
      expect(text).toBe(
        `⚠️ OpenClaw updated; 2026.9.2 is serving.\nFailed step: plugins.\nNext: ${action}`,
      );
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
});
