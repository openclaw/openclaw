import { flush } from "solid-js";
/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { AsyncQuestionSummary } from "./chat-async-question-summary.tsx";
import type { AsyncQuestionPresentation, AsyncQuestions } from "./chat-async-question.types.ts";

const container = document.createElement("div");

function basePresentation(): AsyncQuestionPresentation {
  return {
    connected: true,
    scope: "agent:main:main",
    pending: [],
    archived: new Map(),
    historyKey: "h",
    drafts: new Map(),
    resolved: new Map(),
    delivery: new Map(),
    discard: vi.fn(),
    onChange: () => {},
    dismiss: async () => {},
    reopen: () => {},
  };
}

const question: AsyncQuestions = {
  itemId: "question-1",
  questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
};

function draw(overrides: Partial<AsyncQuestionPresentation> = {}) {
  const presentation = { ...basePresentation(), ...overrides };
  const mount = mountSolid(
    () => <AsyncQuestionSummary questions={question} presentation={presentation} />,
    { container },
  );
  flush();
  return { mount, presentation };
}

function liveRegions() {
  return Array.from(container.querySelectorAll('[role="status"][aria-live="polite"]'));
}

afterEach(() => {
  container.textContent = "";
});

it("announces the delivery status and error inside a live region, keeping Retry outside it", () => {
  const retry = vi.fn();
  const delivery = new Map<string, ChatQueueItem>([
    [
      "question-1",
      {
        id: "q",
        asyncQuestionItemId: "question-1",
        text: "Everyone",
        createdAt: 1,
        sendState: "failed",
        sendError: "Synthetic rejection",
      },
    ],
  ]);
  const { mount } = draw({ delivery, retry });

  // The delivery text and its error must be inside a live region...
  const regions = liveRegions();
  const regionText = regions.map((r) => r.textContent ?? "").join(" ");
  expect(regionText).toContain("Answer not sent");
  expect(regionText).toContain("Synthetic rejection");

  // ...but the Retry button must not be, so it is not re-announced on every update.
  const retryButton = container.querySelector<HTMLButtonElement>("button");
  expect(retryButton).not.toBeNull();
  expect(retryButton?.closest('[aria-live="polite"]')).toBeNull();

  mount.unmount();
});

it("keeps delivery error updates inside the announced region when a queued answer fails", () => {
  const delivery = new Map<string, ChatQueueItem>([
    [
      "question-1",
      {
        id: "q",
        asyncQuestionItemId: "question-1",
        text: "Everyone",
        createdAt: 1,
        sendState: "failed",
        sendError: "Synthetic rejection",
      },
    ],
  ]);
  const { mount } = draw({ delivery });
  const deliveryRegion = liveRegions().find((r) =>
    (r.textContent ?? "").includes("Synthetic rejection"),
  );
  expect(deliveryRegion).toBeTruthy();
  mount.unmount();
});
