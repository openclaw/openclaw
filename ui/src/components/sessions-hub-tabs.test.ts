/* @vitest-environment jsdom */

import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { HubTabs } from "./solid/hub-tabs.tsx";

type SessionsHubTabsProps = {
  active: "sessions" | "worktrees";
  onSelect: (tab: "sessions" | "worktrees") => void;
};

const mounts = new WeakMap<
  HTMLDivElement,
  { update: (props: SessionsHubTabsProps) => void; unmount: () => void }
>();

async function mount(
  props: SessionsHubTabsProps,
  container = document.createElement("div"),
): Promise<HTMLDivElement> {
  if (!container.isConnected) {
    document.body.append(container);
  }
  const mounted = mounts.get(container);
  if (mounted) {
    mounted.update(props);
  } else {
    const [current, setCurrent] = createSignal(props);
    const view = mountSolid(
      () =>
        createComponent(HubTabs<"sessions" | "worktrees">, {
          get active() {
            return current().active;
          },
          get onSelect() {
            return current().onSelect;
          },
          id: "sessions",
          tabs: [
            { value: "sessions", label: "Sessions" },
            { value: "worktrees", label: "Worktrees" },
          ],
          ariaLabel: "Sessions",
          panelId: "sessions-hub-panel",
        }),
      { container },
    );
    mounts.set(container, { update: setCurrent, unmount: view.unmount });
  }
  flush();
  await Promise.resolve();
  return container;
}

function findTab(container: Element, value = "worktrees") {
  return container.querySelector<HTMLElement>(`#sessions-tab-${value}`);
}

function activate(container: Element, value = "worktrees") {
  findTab(container, value)?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
  );
  container.remove();
}

describe("Sessions hub navigation", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    cleanupSolid();
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
    activate(source);

    const destination = await mount({ active: "worktrees", onSelect: () => undefined });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(findTab(destination));
    });
  });

  it.each(["queued", "before mount"] as const)(
    "does not steal deliberate focus established %s",
    async (stage) => {
      const source = await mount({ active: "sessions", onSelect: () => undefined });
      if (stage === "before mount") {
        findTab(source)?.focus();
      }
      activate(source);
      if (stage === "queued") {
        await mount({ active: "worktrees", onSelect: () => undefined });
      }
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      if (stage === "before mount") {
        await mount({ active: "worktrees", onSelect: () => undefined });
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
      expect(document.activeElement).toBe(outside);
    },
  );

  it("keeps only the latest cross-route keyboard focus handoff", async () => {
    const first = await mount({ active: "sessions", onSelect: () => undefined });
    activate(first);
    const intermediate = await mount({ active: "worktrees", onSelect: () => undefined });
    activate(intermediate, "sessions");
    const destination = await mount({ active: "sessions", onSelect: () => undefined });

    await vi.waitFor(() => expect(document.activeElement).toBe(findTab(destination, "sessions")));
  });
  it("hands keyboard focus from a retiring route to the Solid destination", async () => {
    const source = await mount({ active: "sessions", onSelect: () => undefined });
    findTab(source)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    mounts.get(source)!.unmount();
    source.remove();
    const destination = await mount({ active: "worktrees", onSelect: () => undefined });
    expect(document.activeElement).toBe(findTab(destination));
  });
});
