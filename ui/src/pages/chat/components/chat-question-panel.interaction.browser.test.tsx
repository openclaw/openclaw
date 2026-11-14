import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { focusProgrammatically } from "../../../lib/programmatic-focus.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createGatewayQuestionPanelProps } from "./chat-question-card.ts";
import { ChatQuestionPanel } from "./chat-question-panel.tsx";

function prompt(id: string): QuestionPrompt {
  return {
    id,
    questions: [
      {
        questionId: "format",
        header: "Format",
        question: `Which format for ${id}?`,
        options: [{ label: "Compact" }, { label: "Detailed" }],
        isOther: true,
      },
    ],
    sessionKey: "agent:main:main",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
    answeredElsewhere: false,
    localResolutionConfirmed: false,
    locallyExpired: false,
    submitting: false,
    error: null,
    drafts: new Map(),
    revision: 1,
  };
}

let container: HTMLDivElement;
let outside: HTMLButtonElement;
let unmount: (() => void) | undefined;

beforeEach(() => {
  outside = document.createElement("button");
  outside.textContent = "Outside";
  container = document.createElement("div");
  document.body.append(outside, container);
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  container.remove();
  outside.remove();
});

async function draw(options: { requestedBySession?: string } = {}) {
  const interactions: string[] = [];
  const [current, setCurrent] = createSignal(prompt("first"));
  const props = () =>
    createGatewayQuestionPanelProps(current(), {
      ...options,
      onInteraction: () => interactions.push(current().id),
      onSubmit: vi.fn(),
      onSkip: vi.fn(),
    });
  unmount = mountSolid(() => <ChatQuestionPanel props={props()} />, { container }).unmount;
  flush();
  await waitForSolid(() => expect(container.querySelector(".chat-question-panel")).not.toBeNull());
  const panel = () => container.querySelector<HTMLElement>(".chat-question-panel")!;
  return { interactions, panel, show: (id: string) => setCurrent(prompt(id)) };
}

it("ignores rendering, hover, programmatic focus and shortcuts", async () => {
  const { interactions, panel } = await draw();
  await userEvent.hover(panel());
  focusProgrammatically(panel());
  panel().querySelector("textarea")!.focus();
  await userEvent.keyboard("{Control>}k{/Control}");
  await userEvent.keyboard("{Shift}");
  panel().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(interactions).toEqual([]);
});

it.each([
  [
    "pointer entry",
    async (panel: HTMLElement) => {
      await userEvent.click(panel.querySelector("textarea")!);
    },
  ],
  [
    "keyboard focus",
    async () => {
      outside.focus();
      await userEvent.tab();
    },
  ],
  [
    "typing",
    async (panel: HTMLElement) => {
      panel.querySelector("textarea")!.focus();
      await userEvent.keyboard("Teal");
    },
  ],
  [
    "option selection",
    async (panel: HTMLElement) => {
      focusProgrammatically(panel);
      await userEvent.keyboard("2");
    },
  ],
])("reports %s as human interaction", async (_name, interact) => {
  const { interactions, panel } = await draw();
  await interact(panel());
  expect(interactions.length).toBeGreaterThan(0);
  expect(new Set(interactions)).toEqual(new Set(["first"]));
});

it("reports interaction for a child-session question and for the question then shown", async () => {
  const { interactions, panel, show } = await draw({ requestedBySession: "Child task" });
  await userEvent.click(panel().querySelector("textarea")!);
  show("second");
  flush();
  await waitForSolid(() => expect(panel().textContent).toContain("second"));
  await userEvent.click(panel().querySelector("textarea")!);
  expect(new Set(interactions)).toEqual(new Set(["first", "second"]));
});
