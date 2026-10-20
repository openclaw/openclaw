/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { TaskSuggestion } from "../../../../packages/gateway-protocol/src/index.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  ChatTaskSuggestionTray,
  type ChatTaskSuggestionTrayProps,
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
    ...overrides,
  };
  mountSolid(() => <ChatTaskSuggestionTray view={view} />, { container });
  const query = <T extends HTMLElement = HTMLElement>(part: string) =>
    container.querySelector<T>(`.task-suggestion__${part}`);
  return { container, query, onAccept, onDismiss, onCopyPrompt };
}

describe("chat task suggestions", () => {
  it("starts a new session from the primary action", () => {
    const { query, onAccept, onDismiss } = renderSuggestion();
    expect(query("start")?.textContent).toContain("Start in a new session");
    expect(query("eyebrow")?.textContent).toContain("Suggested task · in project");
    expect(query("eyebrow")?.getAttribute("title")).toBe("/repo/project");
    expect(query("title")?.textContent).toContain("Remove stale adapter");
    expect(query("summary")?.textContent).toContain("The adapter is unreachable");
    const details = query<HTMLDetailsElement>("instructions");
    expect(details?.open).toBe(false);
    details?.querySelector("summary")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(details?.open).toBe(true);
    expect(details?.textContent).toContain("Delete the stale adapter and update tests.");

    query<HTMLButtonElement>("start")?.click();
    query<HTMLButtonElement>("dismiss")?.click();
    expect(onAccept).toHaveBeenCalledWith(suggestion, "local", undefined);
    expect(onDismiss).toHaveBeenCalledWith(suggestion);
  });

  it("shows copied feedback while the suggestion id is marked copied", () => {
    const { query } = renderSuggestion({
      taskSuggestionCopiedIds: new Set([suggestion.id]),
    });
    expect(query("copy")?.getAttribute("aria-label")).toBe("Copied");
  });

  it("keeps copy prompt available when acceptance and dismissal are unavailable", () => {
    const { query, onAccept, onCopyPrompt } = renderSuggestion({
      canAcceptTaskSuggestions: false,
      canDismissTaskSuggestions: false,
    });
    expect(query("dismiss")).toBeNull();
    expect(query<HTMLButtonElement>("start")?.disabled).toBe(true);
    const copy = query<HTMLButtonElement>("copy");
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
    const cardsNow = () => [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    const navButton = (card: HTMLElement | undefined, button: string) =>
      card?.querySelector<HTMLButtonElement>(`[data-task-${button}]`);
    const [view, setView] = createSignal<ChatTaskSuggestionTrayProps>({});
    mountSolid(() => <ChatTaskSuggestionTray view={view()} />, { container });
    const draw = () =>
      setView({
        taskSuggestions: [suggestion, secondSuggestion],
        activeTaskSuggestionId: activeId,
        taskSuggestionSwapDirection: direction,
        taskSuggestionSwapGeneration: generation,
        onNavigateTaskSuggestion: (taskId, nextDirection) => {
          activeId = taskId === suggestion.id ? secondSuggestion.id : suggestion.id;
          direction = nextDirection;
          generation += 1;
          draw();
          queueMicrotask(() =>
            navButton(
              cardsNow().find((card) => !card.hidden),
              nextDirection === "next" ? "next" : "prev",
            )?.focus(),
          );
        },
      });
    draw();
    flush();

    const navigate = async (index: number, button = "next") => {
      navButton(cardsNow()[index], button)?.click();
      await Promise.resolve();
      flush();
      return cardsNow();
    };
    let cards = cardsNow();
    expect(cards.map((card) => card.hidden)).toEqual([false, true]);
    expect(cards[0]?.querySelector(".task-suggestion__position")?.textContent).toContain("1 / 2");

    cards = await navigate(0);
    expect(cards.map((card) => card.hidden)).toEqual([true, false]);
    expect(cards[1]?.dataset.swapDirection).toBe("next");
    expect(document.activeElement).toBe(navButton(cards[1], "next"));

    const retainedCard = cards[1];
    const details = retainedCard!.querySelector<HTMLDetailsElement>("details")!;
    details.open = true;
    // An unrelated update keeps the selected card and its manually opened disclosure.
    draw();
    flush();
    cards = cardsNow();
    expect(cards.map((card) => card.hidden)).toEqual([true, false]);
    expect(cards[1]).toBe(retainedCard);
    expect(details.open).toBe(true);

    cards = await navigate(1);
    expect(cards.map((card) => card.hidden)).toEqual([false, true]);
    expect(cards[0]?.dataset.swapDirection).toBe("next");
    const firstVisit = cards[0];

    await navigate(0);
    cards = await navigate(1);
    expect(cards[0]).not.toBe(firstVisit);
    expect(cards[0]?.dataset.swapDirection).toBe("next");

    cards = await navigate(0, "prev");
    expect(document.activeElement).toBe(navButton(cards[1], "prev"));
    container.remove();
  });

  it("strips bidi controls from every displayed field", () => {
    const { container, query } = renderSuggestion({
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
    expect(query("eyebrow")?.getAttribute("title")).toBe("/repo/project");
  });
});
