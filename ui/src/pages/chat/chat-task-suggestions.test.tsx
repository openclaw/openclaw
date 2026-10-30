/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { TaskSuggestion } from "../../../../packages/gateway-protocol/src/index.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  ChatTaskSuggestionTray,
  type ChatTaskSuggestionTrayProps,
  type TaskSuggestionAcceptance,
} from "./components/chat-task-suggestions.tsx";

const suggestion: TaskSuggestion = {
  id: "task_123",
  title: "Remove stale adapter",
  prompt: "Delete the stale adapter and update tests.",
  tldr: "The adapter is unreachable and adds maintenance cost.",
  cwd: "/repo/project",
  sessionKey: "agent:main:main",
  agentId: "main",
  createdAt: 1,
};

function renderSuggestion(overrides: Partial<ChatTaskSuggestionTrayProps> = {}) {
  const container = document.createElement("div");
  const onAccept = vi.fn();
  const onDismiss = vi.fn();
  const onCopyPrompt = vi.fn();
  const view: ChatTaskSuggestionTrayProps = {
    taskSuggestions: [suggestion],
    canAcceptTaskSuggestions: true,
    canDismissTaskSuggestions: true,
    onAcceptTaskSuggestion: onAccept,
    onDismissTaskSuggestion: onDismiss,
    onCopyTaskSuggestionPrompt: onCopyPrompt,
    taskSuggestionCopiedIds: new Set<string>(),
    ...overrides,
  };
  mountSolid(() => <ChatTaskSuggestionTray view={view} />, { container });
  return { container, onAccept, onDismiss, onCopyPrompt };
}

describe("chat task suggestions", () => {
  it("derives starting controls from the live acceptance outcome", () => {
    const [acceptance, setAcceptance] = createSignal<TaskSuggestionAcceptance | undefined>();
    const { container, onAccept, onDismiss } = renderSuggestion({
      taskSuggestionAcceptance: acceptance,
    });
    const start = container.querySelector<HTMLButtonElement>(".task-suggestion__start")!;
    const dismiss = container.querySelector<HTMLButtonElement>(".task-suggestion__dismiss")!;
    const toggle = container.querySelector<HTMLButtonElement>(".task-suggestion__toggle")!;
    expect(start.disabled).toBe(false);

    setAcceptance({ phase: "starting" });
    flush();
    expect(start.textContent).toContain("Starting");
    expect(start.disabled).toBe(true);
    expect(dismiss.disabled).toBe(true);
    // Starting keeps the row compact, so the stack above the composer does not jump.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    start.click();
    dismiss.click();
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();

    setAcceptance({ phase: "failed", error: "Start unavailable" });
    flush();
    // A failure keeps the card open so its error and recovery stay in view.
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Start unavailable");
    container.querySelector<HTMLButtonElement>(".task-suggestion__retry")!.click();
    expect(onAccept).toHaveBeenCalledWith(suggestion, "local", undefined);
    expect(dismiss.disabled).toBe(false);
  });

  it("starts a new session from the primary action", () => {
    const { container, onAccept, onDismiss } = renderSuggestion();

    // The closed row names the action briefly; its accessible name says where it starts.
    const rowStart = container.querySelector<HTMLButtonElement>(".task-suggestion__start")!;
    expect(rowStart.textContent).toBe("Start");
    expect(rowStart.getAttribute("aria-label")).toBe("Start in a new session");

    expect(container.querySelector(".task-suggestion")?.getAttribute("aria-label")).toBe(
      "Suggested task · in project",
    );
    expect(container.querySelector(".task-suggestion__repo")?.getAttribute("title")).toBe(
      "/repo/project",
    );
    expect(container.querySelector(".task-suggestion__title")?.textContent).toContain(
      "Remove stale adapter",
    );
    expect(container.querySelector(".task-suggestion__summary")?.textContent).toContain(
      "The adapter is unreachable",
    );

    expect(container.querySelector(".task-suggestion__repo")?.textContent).toBe("project");
    const toggle = container.querySelector<HTMLButtonElement>(".task-suggestion__toggle")!;
    const details = container.querySelector<HTMLElement>(".task-suggestion__details")!;
    expect(toggle.getAttribute("aria-controls")).toBe(details.id);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(details.hidden).toBe(true);
    toggle.click();
    flush();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain("Delete the stale adapter and update tests.");
    // Open, the start action moves from the header to the footer.
    expect(container.querySelector(".task-suggestion__head .task-suggestion__start")).toBeNull();
    expect(
      container.querySelector('.task-suggestion__split[data-placement="foot"]'),
    ).not.toBeNull();

    container.querySelector<HTMLButtonElement>(".task-suggestion__start")?.click();
    container.querySelector<HTMLButtonElement>(".task-suggestion__dismiss")?.click();
    expect(onAccept).toHaveBeenCalledWith(suggestion, "local", undefined);
    expect(onDismiss).toHaveBeenCalledWith(suggestion);
  });

  it("shows copied feedback while the suggestion id is marked copied", () => {
    const { container } = renderSuggestion({
      taskSuggestionCopiedIds: new Set([suggestion.id]),
    });
    const copy = container.querySelector(".task-suggestion__copy");
    expect(copy?.getAttribute("aria-label")).toBe("Copied");
  });

  it("keeps copy prompt available when acceptance and dismissal are unavailable", () => {
    const { container, onAccept, onCopyPrompt } = renderSuggestion({
      canAcceptTaskSuggestions: false,
      canDismissTaskSuggestions: false,
    });
    expect(container.querySelector(".task-suggestion__dismiss")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".task-suggestion__start")?.disabled).toBe(
      true,
    );
    const copy = container.querySelector<HTMLButtonElement>(".task-suggestion__copy");
    expect(copy?.disabled).toBe(false);
    copy?.click();
    expect(onCopyPrompt).toHaveBeenCalledWith(suggestion);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("keeps reactive navigation active across rerenders and restarts repeated animations", async () => {
    const secondSuggestion = { ...suggestion, id: "task_456", title: "Trim old fixtures" };
    const container = document.createElement("div");
    document.body.append(container);
    let activeId = suggestion.id;
    let direction: "next" | "previous" | undefined;
    let generation = 0;
    const [view, setView] = createSignal<ChatTaskSuggestionTrayProps>({});
    mountSolid(() => <ChatTaskSuggestionTray view={view()} />, { container });
    const draw = () =>
      setView({
        taskSuggestions: [suggestion, secondSuggestion],
        activeTaskSuggestionId: activeId,
        taskSuggestionSwapDirection: direction,
        taskSuggestionSwapGeneration: generation,
        onNavigateTaskSuggestion: (taskId, nextDirection) => {
          const current = taskId === suggestion.id ? 0 : 1;
          activeId = [suggestion, secondSuggestion][
            (current + (nextDirection === "next" ? 1 : -1) + 2) % 2
          ]!.id;
          direction = nextDirection;
          generation += 1;
          draw();
          queueMicrotask(() =>
            container
              .querySelector<HTMLElement>(
                `.task-suggestion:not([hidden]) [data-task-${nextDirection === "next" ? "next" : "prev"}]`,
              )
              ?.focus(),
          );
        },
      });
    draw();
    flush();

    let cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(cards.map((card) => card.hidden)).toEqual([false, true]);
    expect(cards[0]?.querySelector(".task-suggestion__position")?.textContent).toContain("1/2");

    cards[0]?.querySelector<HTMLButtonElement>("[data-task-next]")?.click();
    await Promise.resolve();
    flush();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(cards.map((card) => card.hidden)).toEqual([true, false]);
    expect(cards[1]?.dataset.swapDirection).toBe("next");
    expect(document.activeElement).toBe(cards[1]?.querySelector("[data-task-next]"));

    const retainedCard = cards[1];
    retainedCard!.querySelector<HTMLButtonElement>(".task-suggestion__toggle")!.click();
    // An unrelated update keeps the selected card and its opened disclosure.
    draw();
    flush();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(cards.map((card) => card.hidden)).toEqual([true, false]);
    expect(cards[1]).toBe(retainedCard);
    expect(retainedCard!.dataset.expanded).toBe("true");

    cards[1]?.querySelector<HTMLButtonElement>("[data-task-next]")?.click();
    await Promise.resolve();
    flush();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(cards.map((card) => card.hidden)).toEqual([false, true]);
    expect(cards[0]?.dataset.swapDirection).toBe("next");
    // Paging keeps the operator's disclosure choice.
    expect(cards[0]?.dataset.expanded).toBe("true");
    const firstVisit = cards[0];

    cards[0]?.querySelector<HTMLButtonElement>("[data-task-next]")?.click();
    await Promise.resolve();
    flush();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    cards[1]?.querySelector<HTMLButtonElement>("[data-task-next]")?.click();
    await Promise.resolve();
    flush();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(cards[0]).not.toBe(firstVisit);
    expect(cards[0]?.dataset.swapDirection).toBe("next");

    cards[0]?.querySelector<HTMLButtonElement>("[data-task-prev]")?.click();
    await Promise.resolve();
    flush();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(document.activeElement).toBe(cards[1]?.querySelector("[data-task-prev]"));
    container.remove();
  });

  it("strips bidi controls from every displayed field", () => {
    const { container } = renderSuggestion({
      taskSuggestions: [
        {
          ...suggestion,
          title: "safe\u202eevil",
          tldr: "why\u200f now",
          cwd: "/repo/\u2066project",
          prompt: "run\u202d exactly",
        },
      ],
    });

    expect(container.textContent).toContain("safeevil");
    expect(container.textContent).toContain("why now");
    expect(container.textContent).toContain("/repo/project");
    expect(container.textContent).toContain("run exactly");
    expect(container.textContent).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(container.querySelector(".task-suggestion__repo")?.getAttribute("title")).toBe(
      "/repo/project",
    );
  });
});
