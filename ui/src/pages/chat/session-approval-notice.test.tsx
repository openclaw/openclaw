import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { SessionApprovalNotice } from "./session-approval-notice.tsx";
import type { ParticipantApprovalNotice } from "./session-approval-projection.ts";

it("shows a status-only waiting notice and removes it on settlement or expiry", () => {
  const approval = {
    approvalId: "approval-1",
    runId: "run-1",
    participantId: "profile:pat",
    expiresAtMs: Date.now() + 60_000,
  };
  const [pending, setPending] = createSignal<ParticipantApprovalNotice | null>(approval);
  const { container } = mountSolid(() => <SessionApprovalNotice approval={pending()} />);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Your turn is waiting for the session creator’s approval.",
  );
  expect(container.querySelector("button, a, pre")).toBeNull();
  setPending(null);
  flush();
  expect(container.textContent).toBe("");
  setPending({ ...approval, expiresAtMs: 1 });
  flush();
  expect(container.textContent).toBe("");
});
