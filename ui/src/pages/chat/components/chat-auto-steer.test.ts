/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderAutoSteerReceipt } from "./chat-auto-steer.ts";

describe("Auto routing receipts", () => {
  it("does not equate selected steer with consumed input", () => {
    const host = document.createElement("div");
    const receipt = { choice: "steer", reason: "decision" };
    render(renderAutoSteerReceipt({ role: "user", __openclaw: { autoSteer: receipt } }), host);
    expect(host.textContent).toContain("Auto selected Steer");
    expect(host.textContent).not.toContain("Steered");
    render(
      renderAutoSteerReceipt({
        role: "user",
        __openclaw: { autoSteer: receipt, steerTargetRunId: "captured-run" },
      }),
      host,
    );
    expect(host.textContent).toContain("Steered");
  });
  it.each(["abstained", "unavailable", "deadline", "ineligible", "stale-turn"])(
    "renders %s without inventing a choice",
    (reason) => {
      const host = document.createElement("div");
      render(renderAutoSteerReceipt({ role: "user", __openclaw: { autoSteer: { reason } } }), host);
      expect(host.textContent).toContain("Auto · manual default");
      expect(host.textContent).not.toContain("selected");
      expect(host.textContent).not.toContain("Steered");
    },
  );
  it("does not invent Auto history for serialized pre-Auto messages", () => {
    const host = document.createElement("div");
    for (const oldBytes of [
      '{"role":"user","content":"Original task","timestamp":1700000000000,"idempotencyKey":"old:user","__openclaw":{"senderId":"historical-human"}}',
      '{"role":"user","content":"Manual correction","timestamp":1700000000001,"idempotencyKey":"old-steer:user","__openclaw":{"senderId":"historical-human","steerTargetRunId":"old-active-run"}}',
    ]) {
      render(renderAutoSteerReceipt(JSON.parse(oldBytes)), host);
      expect(host.querySelector(".chat-auto-steer-receipt")).toBeNull();
      expect(host.textContent).toBe("");
    }
  });

  it("ignores malformed or non-user receipts", () => {
    const host = document.createElement("div");
    for (const message of [
      { role: "user", __openclaw: { autoSteer: { reason: "decision" } } },
      { role: "assistant", __openclaw: { autoSteer: { reason: "decision", choice: "steer" } } },
      { role: "user", __openclaw: { autoSteer: { reason: "invented", choice: "steer" } } },
    ]) {
      render(renderAutoSteerReceipt(message), host);
      expect(host.textContent).toBe("");
    }
  });
});
