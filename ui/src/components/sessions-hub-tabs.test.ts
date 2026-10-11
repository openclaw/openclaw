/* @vitest-environment jsdom */

import { cleanup, render as renderSolid } from "@solidjs/testing-library";
import { nothing, render } from "lit";
import { createComponent, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderHubTabs } from "./hub-tabs.ts";
import { HubTabs } from "./solid/hub-tabs.tsx";

type SessionsHubTabsProps = {
  active: "sessions" | "worktrees";
  onSelect: (tab: "sessions" | "worktrees") => void;
};

async function mount(
  props: SessionsHubTabsProps,
  container = document.createElement("div"),
): Promise<HTMLDivElement> {
  if (!container.isConnected) {
    document.body.append(container);
  }
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
  await Promise.resolve();
  return container;
}

describe("Sessions hub navigation", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("renders the route hub with manual activation and a shared panel target", async () => {
    const container = await mount({ active: "worktrees", onSelect: () => undefined });
    const group = container.querySelector('[role="tablist"]');
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];

    expect(group?.getAttribute("aria-orientation")).toBe("horizontal");
    expect(tabs.map((tab) => tab.id)).toEqual(["sessions-tab-sessions", "sessions-tab-worktrees"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-controls"))).toEqual([
      "sessions-hub-panel",
      "sessions-hub-panel",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  });

  it("delegates cross-route selection", async () => {
    const onSelect = vi.fn();
    const container = await mount({ active: "sessions", onSelect });

    container
      .querySelector("#sessions-tab-worktrees")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));

    expect(onSelect).toHaveBeenLastCalledWith("worktrees");
  });

  it("does not echo controlled selection changes as navigation", async () => {
    const onSelect = vi.fn();
    const container = await mount({ active: "sessions", onSelect });
    await mount({ active: "worktrees", onSelect }, container);
    expect(container.querySelector('[role="tab"][active]')?.id).toBe("sessions-tab-worktrees");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hands focus to the destination strip after keyboard navigation", async () => {
    const source = await mount({ active: "sessions", onSelect: () => undefined });
    source
      .querySelector<HTMLElement>("#sessions-tab-worktrees")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
      );
    source.remove();

    const destination = await mount({ active: "worktrees", onSelect: () => undefined });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        destination.querySelector<HTMLElement>("#sessions-tab-worktrees"),
      );
    });
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
  it("hands keyboard focus from a retiring Lit route to the Solid destination", async () => {
    const source = document.createElement("div");
    document.body.append(source);
    render(
      renderHubTabs({
        id: "mixed-routes",
        active: "a",
        tabs: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
        ariaLabel: "Routes",
        panelId: "mixed-panel",
        onSelect: () => undefined,
      }),
      source,
    );
    source
      .querySelector<HTMLElement>("#mixed-routes-tab-b")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    render(nothing, source);
    source.remove();
    const view = renderSolid(() =>
      createComponent(HubTabs, {
        id: "mixed-routes",
        active: "b",
        tabs: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
        ariaLabel: "Routes",
        panelId: "mixed-panel",
        onSelect: () => undefined,
      }),
    );
    flush();
    await Promise.resolve();
    expect(document.activeElement).toBe(view.getByRole("tab", { name: "Beta" }));
  });
});
