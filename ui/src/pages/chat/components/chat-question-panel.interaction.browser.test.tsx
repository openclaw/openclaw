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
  // Pending prompts keep their identity and drafts while the panel switches between them.
  const prompts = new Map(["first", "second"].map((id) => [id, prompt(id)]));
  const [current, setCurrent] = createSignal(prompts.get("first")!);
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
  return { interactions, panel, show: (id: string) => setCurrent(prompts.get(id)!) };
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

it("keeps child-session drafts and interaction per question across switching", async () => {
  const { interactions, panel, show } = await draw({ requestedBySession: "Child task" });
  const answer = () => panel().querySelector("textarea")!;
  const switchTo = async (id: string) => {
    show(id);
    flush();
    await waitForSolid(() => expect(panel().textContent).toContain(`for ${id}?`));
  };
  await userEvent.click(answer());
  await userEvent.keyboard("Teal");
  await switchTo("second");
  expect(answer().value).toBe("");
  await userEvent.click(answer());
  await userEvent.keyboard("Plum");
  await switchTo("first");
  expect(answer().value).toBe("Teal");
  await switchTo("second");
  expect(answer().value).toBe("Plum");
  expect(new Set(interactions)).toEqual(new Set(["first", "second"]));
});
