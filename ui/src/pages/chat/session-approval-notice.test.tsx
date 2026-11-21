import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ChatParticipantNotices } from "./chat-participant-notices.tsx";
import type { ParticipantApprovalNotice } from "./session-approval-projection.ts";

it("loads a status-only waiting notice on approval and removes it on settlement or expiry", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const approval = {
    approvalId: "approval-1",
    runId: "run-1",
    participantId: "profile:pat",
    expiresAtMs: Date.now() + 60_000,
  };
  const [pending, setPending] = createSignal<ParticipantApprovalNotice | null>(null);
  const { container } = mountSolid(() => (
    <ChatParticipantNotices messages={[]} participantApproval={pending()} />
  ));
  expect(container.textContent).toBe("");
  setPending(approval);
  await waitForSolid(() =>
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Your turn is waiting for the session creator’s approval.",
    ),
  );
  expect(container.querySelector("button, a, pre")).toBeNull();
  setPending(null);
  flush();
  expect(container.textContent).toBe("");
  setPending(approval);
  flush();
  await vi.advanceTimersByTimeAsync(60_000);
  flush();
  expect(container.textContent).toBe("");
});
