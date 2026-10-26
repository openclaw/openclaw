/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { ChatWorkingIndicator } from "./chat-working-indicator.tsx";

it("switches between bubble disclosure and inline work without losing the status", () => {
  const options = { bubbleMode: true, startupLabel: "Starting model", outputTokens: 42 };
  const part = { kind: "reading-indicator" as const, key: "status", startedAt: 1 };
  const view = mountSolid(ChatWorkingIndicator, {
    part,
    options,
  });
  onTestFinished(view.dispose);
  const query = (selector: string) => view.container.querySelector(selector);
  expect(query("details.chat-bubble-activity")).not.toBeNull();
  view.update({ part, options: { ...options, bubbleMode: false } });
  expect(query(".chat-bubble-activity")).toBeNull();
  expect(query(".chat-working-indicator")?.textContent).toContain("Starting model");
});

it("keeps approval actionable instead of quiet bubble dots", () => {
  const { container, dispose } = mountSolid(ChatWorkingIndicator, {
    part: { kind: "reading-indicator", key: "approval", startedAt: 1 },
    options: { bubbleMode: true, waitingApproval: true },
  });
  onTestFinished(dispose);
  expect(container.querySelector("summary")?.textContent).toContain("Waiting for approval");
  expect(container.querySelector("summary .chat-bubble-dots")).toBeNull();
  expect(container.querySelector("svg")).toBeNull();
});
