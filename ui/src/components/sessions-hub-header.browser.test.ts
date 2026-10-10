import { cleanup, render as renderSolid } from "@solidjs/testing-library";
import { html, nothing, render } from "lit";
import { createComponent, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderHubTabs } from "./hub-tabs.ts";
import { renderSessionsHubHeader } from "./sessions-hub-header.ts";
import "../test-helpers/load-styles.ts";
import { HubTabs } from "./solid/hub-tabs.tsx";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

async function useViewport(width: number, height = 800) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, height);
}

async function mount(
  active: "sessions" | "worktrees",
  withActions: boolean,
  onSelect: (tab: "sessions" | "worktrees") => void = () => undefined,
) {
  const container = document.createElement("div");
  container.style.width = "calc(100vw - 32px)";
  container.style.maxWidth = "1120px";
  document.body.append(container);
  render(
    renderSessionsHubHeader({
      active,
      title: "Sessions",
      actions: withActions ? html`<div style="width: 240px">Agent selector</div>` : undefined,
      onSelect,
    }),
    container,
  );
  await Promise.resolve();
  return container;
}

function overlaps(left: DOMRect, right: DOMRect): boolean {
  return !(
    left.right <= right.left ||
    left.left >= right.right ||
    left.bottom <= right.top ||
    left.top >= right.bottom
  );
}

describe.skipIf(!hasBrowserLayout)("Sessions hub header browser layout", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each([1280, 820])(
    "keeps the tab strip fixed without overlap at a %dpx viewport",
    async (width) => {
      await useViewport(width);
      const sessions = await mount("sessions", true);
      const sessionsTitle = sessions.querySelector<HTMLElement>(".hub-page-header__title");
      const sessionsTabs = sessions.querySelector<HTMLElement>(".sessions-hub-tabs");
      const sessionsActions = sessions.querySelector<HTMLElement>(".hub-page-header__actions");
      const sessionsLeft = sessionsTabs?.getBoundingClientRect().left;
      expect(sessionsLeft).toBeTypeOf("number");
      expect(sessionsTabs?.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(sessionsActions?.childElementCount).toBe(1);
      expect(
        overlaps(sessionsTitle!.getBoundingClientRect(), sessionsTabs!.getBoundingClientRect()),
      ).toBe(false);
      expect(
        overlaps(sessionsActions!.getBoundingClientRect(), sessionsTabs!.getBoundingClientRect()),
      ).toBe(false);
      sessions.remove();

      const worktrees = await mount("worktrees", false);
      const worktreesTabs = worktrees.querySelector<HTMLElement>(".sessions-hub-tabs");
      const worktreesLeft = worktreesTabs?.getBoundingClientRect().left;
      expect(worktreesLeft).toBeTypeOf("number");
      expect(worktrees.querySelector(".hub-page-header__actions")?.childElementCount).toBe(0);
      expect(Math.abs((sessionsLeft ?? 0) - (worktreesLeft ?? 0))).toBeLessThanOrEqual(1);
    },
  );

  it("keeps session navigation and operational headers available on mobile", async () => {
    await useViewport(414, 800);
    const onSelect = vi.fn();
    const sessions = await mount("sessions", true, onSelect);
    const header = sessions.querySelector<HTMLElement>(".hub-page-header");
    const title = sessions.querySelector<HTMLElement>(".page-title");
    const tabs = sessions.querySelector<HTMLElement>(".sessions-hub-tabs");
    const actions = sessions.querySelector<HTMLElement>(".hub-page-header__actions");
    expect(getComputedStyle(header!).display).toBe("grid");
    expect(title?.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(tabs?.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(actions?.getBoundingClientRect().width).toBeGreaterThan(0);

    const worktreesTab = sessions.querySelector<HTMLElement>("#sessions-tab-worktrees");
    expect(worktreesTab?.getBoundingClientRect().width).toBeGreaterThan(0);
    worktreesTab?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(onSelect).toHaveBeenCalledWith("worktrees");

    const operationalHeader = document.createElement("section");
    operationalHeader.className = "content-header";
    operationalHeader.innerHTML = '<button type="button">Refresh</button>';
    document.body.append(operationalHeader);
    expect(getComputedStyle(operationalHeader).display).toBe("flex");
    expect(
      operationalHeader.querySelector("button")?.getBoundingClientRect().width,
    ).toBeGreaterThan(0);
  });
});

const disposers: (() => void)[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
  disposers
    .splice(0)
    .toReversed()
    .forEach((dispose) => dispose());
  cleanup();
  hosts.splice(0).forEach((host) => host.remove());
  vi.restoreAllMocks();
});

function shadow() {
  const host = document.createElement("section");
  host.style.cssText =
    "--control-ui-text-sm:19px;--space-1:4px;--space-2:8px;--muted:rgb(90 90 90)";
  document.body.append(host);
  hosts.push(host);
  return host.attachShadow({ mode: "closed" });
}

function mountShadowHub(root: ShadowRoot, renderer: "lit" | "solid", id: string) {
  const container = document.createElement("div");
  root.append(container);
  const onSelect = vi.fn();
  const props = {
    id,
    active: "first",
    tabs: [
      { value: "first", label: "First" },
      { value: "second", label: "Second" },
    ],
    ariaLabel: "Sections",
    panelId: `${id}-panel`,
    onSelect,
  };
  let unmount: () => void;
  if (renderer === "solid") {
    const view = renderSolid(() => createComponent(HubTabs, props), { container });
    flush();
    unmount = view.unmount;
  } else {
    render(renderHubTabs(props), container);
    unmount = () => render(nothing, container);
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    unmount();
    container.remove();
  };
  disposers.push(dispose);
  return { container, dispose, onSelect };
}

function sheets(root: ShadowRoot) {
  return [...root.querySelectorAll<HTMLStyleElement>("style[data-openclaw-overlay-style]")];
}

function expectSkin(container: HTMLElement) {
  const tab = container.querySelector<HTMLButtonElement>(".hub-tab")!;
  const style = getComputedStyle(tab);
  expect(style.appearance).toBe("none");
  expect(style.borderTopWidth).toBe("0px");
  expect(style.display).toBe("flex");
  expect(style.fontSize).toBe("19px");
  expect(style.paddingTop).toBe("4px");
  return tab;
}

describe.skipIf(!hasBrowserLayout)("native hub shadow styles", () => {
  it.each(["lit", "solid"] as const)(
    "keeps %s tab skins and one keyboard owner through closed-shadow ancestor moves",
    async (renderer) => {
      const first = shadow();
      const second = shadow();
      const moved = mountShadowHub(first, renderer, "moved");
      const retained = mountShadowHub(first, renderer, "retained");
      await Promise.resolve();
      const tab = expectSkin(moved.container);
      expectSkin(retained.container);
      expect(sheets(first)).toHaveLength(2);

      second.append(moved.container);
      await Promise.resolve();
      expect(expectSkin(moved.container)).toBe(tab);
      expect(sheets(first)).toHaveLength(2);
      expect(sheets(second)).toHaveLength(2);
      moved.container
        .querySelector("#moved-tab-second")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(moved.onSelect).toHaveBeenCalledExactlyOnceWith("second");

      const observed = vi.spyOn(MutationObserver.prototype, "observe");
      const unrelated = document.createElement("div");
      second.append(unrelated);
      await Promise.resolve();
      const activeSheets = sheets(second);
      unrelated.append(document.createElement("span"));
      await Promise.resolve();
      expect(observed).not.toHaveBeenCalled();
      expect(sheets(second)).toEqual(activeSheets);

      retained.dispose();
      expect(sheets(first)).toHaveLength(0);
      expect(sheets(second)).toHaveLength(2);
      moved.dispose();
      expect(sheets(second)).toHaveLength(0);
    },
  );
});
