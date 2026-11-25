/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSuggestion } from "../../../../../packages/gateway-protocol/src/index.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSessionSuggestions } from "./chat-session-suggestions.solid.tsx";

const suggestion: SessionSuggestion = {
  id: "suggestion-1",
  sessionKey: "agent:main:main",
  agentId: "main",
  author: { type: "human", id: "alice", label: "Alice" },
  text: "Try the focused change",
  createdAt: 1,
  state: "pending",
};

let container: HTMLDivElement | undefined;

afterEach(() => {
  container?.remove();
  container = undefined;
});

function mount(role: "owner" | "viewer", row = suggestion, canResolve = true, archived = false) {
  const onResolve = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  mountSolid(
    () => (
      <ChatSessionSuggestions
        {...{
          suggestions: [row],
          role,
          busyIds: new Set(),
          archived,
          canResolve,
          onResolve,
        }}
      />
    ),
    { container },
  );
  return { container, onResolve };
}

describe("chat session suggestions", () => {
  it("does not expose resolution actions to members", () => {
    const onResolve = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    mountSolid(
      () => (
        <ChatSessionSuggestions
          {...{
            suggestions: [suggestion],
            role: "member",
            busyIds: new Set(),
            archived: false,
            canResolve: true,
            onResolve,
          }}
        />
      ),
      { container },
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Awaiting approval");
    expect(container.querySelector(".session-suggestion__author")?.textContent).toBe("Alice");
    expect(container.querySelector("[data-initials]")?.getAttribute("data-initials")).toBe("A");
  });

  it("hides owner actions when the resolve method is unavailable", () => {
    const view = mount("owner", suggestion, false);
    expect(view.container.querySelector("button")).toBeNull();
    expect(view.container.textContent).toContain("Pending");
  });

  it("keeps only dismiss available for an archived session", () => {
    const view = mount("owner", suggestion, true, true);
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Dismiss Alice's suggestion",
    ]);
    buttons[0]?.click();
    expect(view.onResolve).toHaveBeenCalledWith(suggestion, "dismiss");
  });
});

it("lets the author close a dismissed outcome without a resolution request", () => {
  const onClose = vi.fn();
  const onResolve = vi.fn();
  container = document.body.appendChild(document.createElement("div"));
  mountSolid(
    () => (
      <ChatSessionSuggestions
        suggestions={[{ ...suggestion, state: "dismissed" }]}
        role="viewer"
        busyIds={new Set()}
        archived={false}
        canResolve={false}
        onResolve={onResolve}
        onClose={onClose}
        liveResolutions={new Map([[suggestion.id, true]])}
      />
    ),
    { container },
  );
  const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  expect(close).not.toBeNull();
  close?.click();
  expect(onClose).toHaveBeenCalledWith(suggestion.id);
  expect(onResolve).not.toHaveBeenCalled();
});

it("bounds the tray, retains keyed disclosures on refresh, and keeps busy resolutions disabled", async () => {
  const [suggestions, setSuggestions] = createSignal(
    Array.from({ length: 5 }, (_, index) => ({ ...suggestion, id: `suggestion-${index}` })),
  );
  const view = mountSolid(() => (
    <ChatSessionSuggestions
      suggestions={suggestions()}
      role="owner"
      busyIds={new Set(["suggestion-0"])}
      archived={false}
      canResolve
    />
  ));
  const rows = () => view.container.querySelectorAll(".session-suggestion");
  expect(rows()).toHaveLength(3);
  const first = rows()[0]!;
  const disclosure = first.querySelector("details")!;
  disclosure.open = true;
  expect([...first.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  view.getByRole("button", { name: "+2 more" }).click();
  await waitForSolid(() => expect(rows()).toHaveLength(5));
  setSuggestions((items) => items.map((item) => ({ ...item, text: "Updated proposal" })));
  await waitForSolid(() => expect(first.textContent).toContain("Updated proposal"));
  expect(rows()[0]).toBe(first);
  expect(disclosure.open).toBe(true);
  view.getByRole("button", { name: "Show less" }).click();
  await waitForSolid(() => expect(rows()).toHaveLength(3));
  expect(disclosure.open).toBe(true);
});
