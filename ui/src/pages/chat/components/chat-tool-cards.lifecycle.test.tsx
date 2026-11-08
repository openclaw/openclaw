/* @vitest-environment jsdom */

import { createSignal, For } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ToolCardOptions } from "./chat-tool-card-types.ts";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";
import type { ToolRenderOptions } from "./chat-tool-render-model.ts";

it("retains sibling tool content while replacing output and live file callbacks", async () => {
  const cards: ToolCard[] = ["first", "second"].map((id) => ({
    id,
    name: "read",
    args: { path: `src/${id}.ts` },
    outputText: `${id} output`,
    completed: true,
  }));
  const oldOpen = vi.fn();
  const newOpen = vi.fn();
  const [state, setState] = createSignal<{
    cards: ToolCard[];
    open: ToolRenderOptions["onOpenWorkspaceFile"];
    expanded: boolean;
  }>({ cards, open: oldOpen, expanded: true });
  const { container } = mountSolid(() => (
    <For each={state().cards} keyed={(card) => card.id}>
      {(card) => (
        <ChatToolCard
          card={card()}
          options={{
            messageKey: card().id,
            expanded: state().expanded,
            onToggleExpanded: vi.fn(),
            ...(state().open ? { onOpenWorkspaceFile: state().open } : {}),
          }}
        />
      )}
    </For>
  ));
  await waitForSolid(() => {
    expect(container.querySelectorAll(".chat-tool-card__detail-link")).toHaveLength(2);
    expect(container.textContent).toContain("second output");
  });
  const first = container.querySelector<HTMLElement>(".chat-tool-msg-collapse")!;
  const link = first.querySelector<HTMLButtonElement>(".chat-tool-card__detail-link")!;
  link.focus();
  setState({
    cards: [cards[0]!, { ...cards[1]!, outputText: "second updated output" }],
    open: newOpen,
    expanded: true,
  });
  await waitForSolid(() => expect(container.textContent).toContain("second updated output"));
  expect(first.querySelector(".chat-tool-card__detail-link")).toBe(link);
  expect(document.activeElement).toBe(link);
  expect(first.classList.contains("is-open")).toBe(true);
  link.click();
  expect(oldOpen).not.toHaveBeenCalled();
  expect(newOpen).toHaveBeenCalledWith({ path: "src/first.ts" });
  setState((current) => ({ ...current, open: undefined }));
  await waitForSolid(() =>
    expect(container.querySelector(".chat-tool-card__detail-link")).toBeNull(),
  );
  setState((current) => ({ ...current, expanded: false }));
  await waitForSolid(() => expect(first.classList.contains("is-open")).toBe(false));
  setState((current) => ({ ...current, expanded: true }));
  await waitForSolid(() => expect(first.classList.contains("is-open")).toBe(true));
  expect(container.textContent).toContain("second updated output");
});

it("refreshes a mutable subagent context without replacing its launch card", async () => {
  const key = "agent:main:subagent:child";
  const oldOpen = vi.fn();
  const newOpen = vi.fn();
  const subagents: NonNullable<ToolCardOptions["subagents"]> = {
    subagentSessions: [{ key, kind: "direct", status: "running" }],
    onOpenSubagent: oldOpen,
  };
  const [options, setOptions] = createSignal<ToolCardOptions>({
    messageKey: "launch",
    expanded: false,
    onToggleExpanded: vi.fn(),
    subagents,
  });
  const { container } = mountSolid(() => (
    <ChatToolCard
      card={{
        id: "launch",
        name: "sessions_spawn",
        args: { label: "Child" },
        details: { childSessionKey: key },
        completed: true,
      }}
      options={options()}
    />
  ));
  await waitForSolid(() =>
    expect(container.querySelector(".chat-tool-row__subagent-state")?.textContent).toBe("running"),
  );
  const link = container.querySelector<HTMLButtonElement>(".chat-tool-row__subagent-link")!;
  subagents.subagentSessions = [{ key, kind: "direct", status: "failed" }];
  subagents.onOpenSubagent = newOpen;
  setOptions((current) => ({ ...current }));
  await waitForSolid(() =>
    expect(container.querySelector(".chat-tool-row__subagent-state")?.textContent).toBe("failed"),
  );
  expect(container.querySelector(".chat-tool-row__subagent-link")).toBe(link);
  link.click();
  expect(oldOpen).not.toHaveBeenCalled();
  expect(newOpen).toHaveBeenCalledExactlyOnceWith(key);
  subagents.subagentSessions = [];
  setOptions((current) => ({ ...current }));
  await waitForSolid(() =>
    expect(container.querySelector(".chat-tool-row__subagent-link")).toBeNull(),
  );
  expect(container.textContent).toContain("Child");
});

it("remeasures each disclosure's own content on pointer and focus interactions", async () => {
  const { container } = mountSolid(() => (
    <>
      <ChatToolCard
        card={{ id: "first", name: "exec", args: { command: "first command" } }}
        options={{ messageKey: "first", expanded: false, onToggleExpanded: vi.fn() }}
      />
      <ChatToolCard
        card={{ id: "second", name: "exec", args: { command: "second command" } }}
        options={{ messageKey: "second", expanded: false, onToggleExpanded: vi.fn() }}
      />
    </>
  ));
  await waitForSolid(() =>
    expect(container.querySelectorAll(".chat-tool-row:not([aria-busy])")).toHaveLength(2),
  );
  const [first, second] = [...container.querySelectorAll<HTMLElement>(".chat-tool-row")];
  let firstWidth = 80;
  for (const [row, width] of [
    [first!, () => firstWidth],
    [second!, () => 20],
  ] as const) {
    Object.defineProperties(row.querySelector(".chat-tool-disclosure__content")!, {
      scrollWidth: { get: width },
      clientWidth: { value: 50 },
    });
    row.dispatchEvent(new Event("pointerenter"));
  }
  expect(first!.classList.contains("chat-tool-disclosure--overflowing")).toBe(true);
  expect(second!.classList.contains("chat-tool-disclosure--overflowing")).toBe(false);
  firstWidth = 20;
  first!.dispatchEvent(new FocusEvent("focus"));
  expect(first!.classList.contains("chat-tool-disclosure--overflowing")).toBe(false);
});

it.each([
  { hasChildren: undefined, mode: "inferred" },
  { hasChildren: true, mode: "explicit" },
])(
  "connects nested tool children only after their parent expands ($mode)",
  async ({ hasChildren, mode }) => {
    const connected = vi.fn();
    customElements.define(
      `openclaw-test-lazy-tool-child-${mode}`,
      class extends HTMLElement {
        connectedCallback() {
          connected();
        }
      },
    );
    const card = { id: "lazy-parent", name: "exec", args: { command: "check" } };
    const child = document.createElement(`openclaw-test-lazy-tool-child-${mode}`);
    child.textContent = "Child";
    const [expanded, setExpanded] = createSignal(false);
    const { container } = mountSolid(() => (
      <ChatToolCard
        card={card}
        options={{
          messageKey: "lazy-parent-message",
          expanded: expanded(),
          onToggleExpanded: vi.fn(),
        }}
        hasChildren={hasChildren}
      >
        {child}
      </ChatToolCard>
    ));
    flush();
    expect(connected).not.toHaveBeenCalled();
    setExpanded(true);
    await waitForSolid(() => expect(connected).toHaveBeenCalledOnce());
    expect(container.querySelector(".chat-tool-children")?.textContent).toContain("Child");
  },
);
