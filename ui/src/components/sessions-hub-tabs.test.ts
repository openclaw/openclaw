/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderHubTabs } from "./hub-tabs.ts";

type SessionsHubTabsProps = {
  active: "sessions" | "worktrees";
  onSelect: (tab: "sessions" | "worktrees") => void;
};

async function mount(props: SessionsHubTabsProps): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderHubTabs({
      ...props,
      id: "sessions",
      tabs: [
        { value: "sessions", label: "Sessions" },
        { value: "worktrees", label: "Worktrees" },
      ],
      ariaLabel: "Sessions",
      panelId: "sessions-hub-panel",
    }),
    container,
  );
  const group = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
    "wa-tab-group",
  );
  await group?.updateComplete;
  return container;
}

describe("Sessions hub navigation", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("delegates cross-route selection", async () => {
    const onSelect = vi.fn();
    const container = await mount({ active: "sessions", onSelect });

    container
      .querySelector("#sessions-tab-worktrees")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));

    expect(onSelect).toHaveBeenLastCalledWith("worktrees");
  });

  it("does not steal deliberate focus established before a queued route handoff", async () => {
    const source = await mount({ active: "sessions", onSelect: () => undefined });
    source
      .querySelector<HTMLElement>("#sessions-tab-worktrees")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
      );
    source.remove();

    await mount({ active: "worktrees", onSelect: () => undefined });
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });

    expect(document.activeElement).toBe(outside);
  });

  it("does not steal deliberate focus established before the destination mounts", async () => {
    const source = await mount({ active: "sessions", onSelect: () => undefined });
    const sourceTab = source.querySelector<HTMLElement>("#sessions-tab-worktrees");
    sourceTab?.focus();
    sourceTab?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
    );
    source.remove();

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await mount({ active: "worktrees", onSelect: () => undefined });
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });

    expect(document.activeElement).toBe(outside);
  });

  it("keeps only the latest cross-route keyboard focus handoff", async () => {
    const first = await mount({ active: "sessions", onSelect: () => undefined });
    first
      .querySelector<HTMLElement>("#sessions-tab-worktrees")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
      );
    first.remove();
    const intermediate = await mount({ active: "worktrees", onSelect: () => undefined });
    intermediate
      .querySelector<HTMLElement>("#sessions-tab-sessions")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
      );
    intermediate.remove();
    const destination = await mount({ active: "sessions", onSelect: () => undefined });

    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        destination.querySelector<HTMLElement>("#sessions-tab-sessions"),
      ),
    );
  });
});
