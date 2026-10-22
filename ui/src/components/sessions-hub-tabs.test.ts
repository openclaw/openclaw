/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid } from "../test-helpers/mount-solid.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { HubTabs, type HubTabsProps } from "./solid/hub-tabs.tsx";

type Tab = "sessions" | "worktrees";
const mounts = new WeakMap<HTMLDivElement, ReturnType<typeof mountSolid<HubTabsProps<Tab>>>>();
const defaults = {
  id: "sessions",
  tabs: [
    { value: "sessions", label: "Sessions" },
    { value: "worktrees", label: "Worktrees" },
  ],
  ariaLabel: "Sessions",
  panelId: "sessions-hub-panel",
} as const;

async function mount(
  active: Tab = "sessions",
  onSelect: (tab: Tab) => void = vi.fn(),
  container = document.createElement("div"),
): Promise<HTMLDivElement> {
  if (!container.isConnected) {
    document.body.append(container);
  }
  const mounted = mounts.get(container);
  const props = { ...defaults, active, onSelect };
  if (mounted) {
    mounted.update(props);
  } else {
    mounts.set(container, mountSolid(HubTabs<Tab>, props, container));
  }
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
  afterEach(() => {
    cleanupSolid();
    document.body.innerHTML = "";
  });

  it("renders the route hub with manual activation and a shared panel target", async () => {
    const container = await mount("worktrees");
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

  it("does not echo controlled selection changes as navigation", async () => {
    const onSelect = vi.fn();
    const container = await mount("sessions", onSelect);
    await mount("worktrees", onSelect, container);
    expect(container.querySelector('[role="tab"][active]')?.id).toBe("sessions-tab-worktrees");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hands focus to the destination strip after keyboard navigation", async () => {
    const source = await mount();
    activate(source);

    const destination = await mount("worktrees");
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(findTab(destination));
    });
  });

  it.each(["queued", "before mount"] as const)(
    "does not steal deliberate focus established %s",
    async (stage) => {
      const source = await mount();
      if (stage === "before mount") {
        findTab(source)?.focus();
      }
      activate(source);
      if (stage === "queued") {
        await mount("worktrees");
      }
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      if (stage === "before mount") {
        await mount("worktrees");
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
      expect(document.activeElement).toBe(outside);
    },
  );

  it("keeps only the latest cross-route keyboard focus handoff", async () => {
    const first = await mount();
    activate(first);
    const intermediate = await mount("worktrees");
    activate(intermediate, "sessions");
    const destination = await mount();

    await vi.waitFor(() => expect(document.activeElement).toBe(findTab(destination, "sessions")));
  });
  it("hands keyboard focus from a retiring route to the Solid destination", async () => {
    const source = await mount();
    findTab(source)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    mounts.get(source)!.dispose();
    source.remove();
    const destination = await mount("worktrees");
    expect(document.activeElement).toBe(findTab(destination));
  });
});
