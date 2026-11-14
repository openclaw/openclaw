import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { AsyncQuestionSummary } from "./chat-async-question-summary.tsx";
import type { AsyncQuestionPresentation, AsyncQuestions } from "./chat-async-question.types.ts";
import baseStyles from "../../../styles/base.css?inline";
import questionStyles from "../../../styles/chat/question-card.css?inline";
import componentStyles from "../../../styles/components.css?inline";

let container: HTMLDivElement;
let styles: HTMLStyleElement;
let mounted: ReturnType<typeof mountSolid> | undefined;

beforeEach(() => {
  styles = document.createElement("style");
  styles.textContent = baseStyles + componentStyles + questionStyles;
  document.head.append(styles);
  container = document.body.appendChild(document.createElement("div"));
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  container.remove();
  styles.remove();
});

function presentation(
  overrides: Partial<AsyncQuestionPresentation> = {},
): AsyncQuestionPresentation {
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
    ...overrides,
  };
}

const twoQuestions: AsyncQuestions = {
  itemId: "question-1",
  questions: [
    { title: "Which audience?", options: ["Engineers", "Everyone"] },
    { title: "Which channel?", options: ["Email", "Chat"] },
  ],
};

function liveRegions(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="status"][aria-live="polite"]'));
}

function draw(questions: AsyncQuestions, overrides: Partial<AsyncQuestionPresentation> = {}) {
  mounted = mountSolid(
    () => <AsyncQuestionSummary questions={questions} presentation={presentation(overrides)} />,
    { container },
  );
  flush();
}

const failedDelivery = () =>
  new Map<string, ChatQueueItem>([
    [
      "question-1",
      {
        id: "answer-row",
        asyncQuestionItemId: "question-1",
        text: "Everyone",
        createdAt: 1,
        sendState: "failed",
        sendError: "Synthetic rejection",
      },
    ],
  ]);

it("keeps delivery status and error announced while Retry stays out of every live region", () => {
  draw(twoQuestions, { delivery: failedDelivery(), retry: vi.fn() });

  const regions = liveRegions();
  expect(regions.length).toBeGreaterThan(0);
  const announced = regions.map((region) => region.textContent ?? "").join("\n");
  expect(announced).toContain("Answer not sent");
  expect(announced).toContain("Synthetic rejection");

  const retry = Array.from(container.querySelectorAll("button")).find((button) =>
    (button.textContent ?? "").includes("Retry"),
  );
  expect(retry).toBeTruthy();
  expect(retry!.closest('[aria-live="polite"]')).toBeNull();
});

it("keeps Retry inline beside the delivery label, above the error", () => {
  draw(twoQuestions, { delivery: failedDelivery(), retry: vi.fn() });

  const labelRegion = liveRegions().find((region) =>
    (region.textContent ?? "").includes("Answer not sent"),
  );
  expect(labelRegion).toBeTruthy();
  const retry = Array.from(container.querySelectorAll("button")).find((button) =>
    (button.textContent ?? "").includes("Retry"),
  );
  expect(retry).toBeTruthy();
  const errorRegion = liveRegions().find((region) =>
    (region.textContent ?? "").includes("Synthetic rejection"),
  );
  expect(errorRegion).toBeTruthy();

  const label = labelRegion!.getBoundingClientRect();
  const button = retry!.getBoundingClientRect();
  const error = errorRegion!.getBoundingClientRect();

  // Main has always rendered the label and Retry on one line, with the error beneath.
  expect(button.top).toBeLessThan(label.bottom);
  expect(button.bottom).toBeGreaterThan(label.top);
  expect(error.top).toBeGreaterThanOrEqual(Math.max(label.bottom, button.bottom) - 1);
});

it("keeps the grid row gap between multiple questions", () => {
  draw(twoQuestions);

  const summary = container.querySelector<HTMLElement>(".chat-question-summary");
  expect(summary).toBeTruthy();
  expect(getComputedStyle(summary!).display).toBe("grid");

  const region = container.querySelector<HTMLElement>('[aria-live="polite"]');
  expect(region).toBeTruthy();
  // The live region wraps the question lines, so it must keep participating in the grid.
  expect(getComputedStyle(region!).display).toBe("grid");
  expect(getComputedStyle(region!).rowGap).toBe("3px");

  // Measured in layout, not inferred from CSS: the two question blocks must not touch.
  const blocks = Array.from(region!.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );
  expect(blocks.length).toBe(2);
  const first = blocks[0]!.getBoundingClientRect();
  const second = blocks[1]!.getBoundingClientRect();
  expect(second.top - first.bottom).toBeGreaterThan(0);
});
