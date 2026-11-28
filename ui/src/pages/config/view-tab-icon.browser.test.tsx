import "../../styles/base.css";
import "../../styles/settings-controls.css";
import "../../styles/settings.css";
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { applyControlUiFaviconImage } from "../../app/control-ui-environment-presentation.runtime.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { TabIconRow, type TabIconViewProps } from "./view-tab-icon.tsx";

registerEnglishCatalog(registerSettingsEnglish);
function setup(overrides: Partial<TabIconViewProps> = {}) {
  const props: TabIconViewProps = {
    tabIcon: "default",
    setTabIconMode: (choice) => rerender({ tabIcon: choice }),
    ...overrides,
  };
  const [current, setCurrent] = createSignal({ ...props });
  const { container } = mountSolid(() => <TabIconRow {...current()} />);
  flush();
  const rerender = (patch: Partial<TabIconViewProps> = {}) => {
    Object.assign(props, patch);
    setCurrent({ ...props });
    flush();
  };
  const button = (name: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  return { props, container, rerender, button };
}
const palettes = (...ids: string[]) =>
  LOBSTER_PET_PALETTES.filter((palette) => ids.includes(palette.id));
const pressedLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('.settings-tab-icon__pick[aria-pressed="true"]')].map((choice) =>
    choice.getAttribute("aria-label"),
  );
const AGENT = "Agent avatar";

it("groups three equally sized, platform-labeled masks that use artwork independent of the favicon shape", async () => {
  const { container } = setup();
  const home = container.querySelector(".settings-tab-icon__home-screen-masks")!;
  const thumbnails = home.querySelectorAll("img");
  const [apple, round, rounded] = thumbnails;
  expect(home.parentElement?.querySelector("dt")?.firstElementChild?.textContent).toBe(
    "Home Screen",
  );
  expect([...thumbnails].map((image) => image.alt)).toEqual([
    "Apple (iPhone and iPad)",
    "Android · Round",
    "Android · Rounded square",
  ]);
  const sizes = [...thumbnails].map((image) => getComputedStyle(image).height);
  expect(new Set(sizes).size).toBe(1);
  expect(Number.parseFloat(sizes[0])).toBeGreaterThan(0);
  expect(getComputedStyle(round).borderRadius).toBe("50%");
  expect(getComputedStyle(rounded).borderRadius).toBe("10%");
  expect(round.src).toBe(apple.src);
  expect(rounded.src).toBe(apple.src);

  const avatar = new Image();
  avatar.src =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="green"/></svg>',
    );
  await avatar.decode();
  onTestFinished(() => applyControlUiFaviconImage(null));
  applyControlUiFaviconImage(avatar, "square");
  await waitForSolid(() => expect(round.src.startsWith("data:image/png;base64,")).toBe(true));
  const selected = round.src;
  expect(rounded.src).toBe(selected);
  expect(apple.src).toBe(selected);

  applyControlUiFaviconImage(avatar, "circle");
  flush();
  expect(round.src).toBe(selected);
  expect(rounded.src).toBe(selected);
});

it("balances the start inset against the visible close glyph, not its button box", () => {
  const { container } = setup();
  const shell = container.querySelector(".settings-tab-icon__browser-edge")!;
  const shellStyle = getComputedStyle(shell);
  expect(shellStyle.paddingInlineStart).toBe(shellStyle.paddingInlineEnd);

  const tab = container.querySelector(".settings-tab-icon__browser-tab")!;
  const style = getComputedStyle(tab);
  const bounds = tab.getBoundingClientRect();
  const favicon = tab.querySelector("img")!.getBoundingClientRect();
  const x = tab.querySelector("button svg")!;
  const stroke = Number.parseFloat(x.getAttribute("stroke-width") ?? "0");
  const xBounds = x.getBoundingClientRect();
  const paths = [...x.querySelectorAll("path")].map((path) => path.getBBox());
  const rightInk = Math.max(...paths.map((path) => path.x + path.width)) + stroke / 2;
  const rightEdge = xBounds.left + (rightInk / x.viewBox.baseVal.width) * xBounds.width;
  const leftGap = favicon.left - (bounds.left + Number.parseFloat(style.borderLeftWidth));
  const rightGap = bounds.right - Number.parseFloat(style.borderRightWidth) - rightEdge;

  // The image slot represents edge-to-edge favicon artwork; its own transparency can vary.
  expect(Math.abs(leftGap - rightGap)).toBeLessThan(1.5);
});

it("makes the Home Screen help available by keyboard", async () => {
  const { button, container } = setup();
  const close = button("Close preview tab");
  const info = container.querySelector<HTMLButtonElement>(".settings-tab-icon__home-screen-info")!;
  close.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(info);
  await waitForSolid(() => {
    const id = info.getAttribute("aria-describedby");
    expect(id && document.getElementById(id)?.textContent).toBe(
      "You may need to delete and recreate your bookmarks for new Home Screen icons to take effect.",
    );
    expect(info.closest("openclaw-tooltip")?.hasAttribute("open")).toBe(true);
  });
  await userEvent.keyboard("{Escape}");
  await waitForSolid(() =>
    expect(info.closest("openclaw-tooltip")?.hasAttribute("open")).toBe(false),
  );
  expect(document.activeElement).toBe(info);
});

it("shakes only the mock tab for pointer and keyboard activation and honors reduced motion", async () => {
  const { button, container, props } = setup();
  const close = button("Close preview tab");
  const tab = container.querySelector(".settings-tab-icon__browser-tab")!;
  const homeScreenIcon = container.querySelector(".settings-tab-icon__home-screen")!;
  const nativeMatchMedia = window.matchMedia.bind(window);
  let reduce = false;
  const media = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) =>
      nativeMatchMedia(
        query === "(prefers-reduced-motion: reduce)" ? (reduce ? "all" : "not all") : query,
      ),
    );
  onTestFinished(() => media.mockRestore());
  const start = tab.getBoundingClientRect();
  const homeStart = homeScreenIcon.getBoundingClientRect();
  const url = location.href;

  await userEvent.click(close);
  const [first] = tab.getAnimations();
  expect(first).toBeDefined();
  first.pause();
  first.currentTime = 60;
  expect(tab.getBoundingClientRect().x).toBeLessThan(start.x);
  first.currentTime = 120;
  expect(tab.getBoundingClientRect().x).toBeGreaterThan(start.x);
  expect(tab.getBoundingClientRect().y).toBe(start.y);
  expect(homeScreenIcon.getBoundingClientRect().x).toBe(homeStart.x);

  close.focus();
  await userEvent.keyboard("{Enter}");
  const [second] = tab.getAnimations();
  expect(second).toBeDefined();
  expect(second).not.toBe(first);
  expect(first.playState).toBe("idle");
  expect(document.activeElement).toBe(close);

  reduce = true;
  await userEvent.keyboard(" ");
  expect(tab.getAnimations()).toHaveLength(0);
  expect(tab.getBoundingClientRect().x).toBe(start.x);
  expect(close.isConnected).toBe(true);
  expect(location.href).toBe(url);
  expect(props.tabIcon).toBe("default");
});

it("keeps one source picker and scopes the shape selector to the agent avatar", async () => {
  const { props, container, button } = setup({ tabIconLobsters: palettes("crimson", "pixel") });
  const shape = () => container.querySelector('[role="radiogroup"][aria-label="Favicon shape"]');
  expect(shape()).toBeNull();
  expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(4);
  expect(pressedLabels(container)).toEqual(["Default"]);

  await userEvent.click(button(AGENT));
  expect(props.tabIcon).toBe("agent:circle");
  expect(shape()?.textContent).toBe("SquareRounded squareCircle");
  const square = shape()!.querySelector<HTMLInputElement>('input[value="square"]')!;
  await userEvent.click(square);
  expect(props.tabIcon).toBe("agent");
  expect(pressedLabels(container)).toEqual([AGENT]);

  const pixel = button("Sprite");
  pixel.focus();
  await userEvent.keyboard("{Enter}");
  expect(props.tabIcon).toBe("lobster:pixel");
  expect(shape()).toBeNull();
  expect(pressedLabels(container)).toEqual(["Sprite"]);
  await waitForSolid(() => expect(pixel.querySelector(".lob-pixel-frame")).not.toBeNull());
  expect(pixel.getAnimations({ subtree: true })).toHaveLength(0);
});

it("hides collected artwork without changing the saved preference and restores it when enabled", () => {
  const { props, container, rerender, button } = setup({
    tabIcon: "lobster:crimson",
    lobsterdexEnabled: false,
    tabIconLobsters: palettes("crimson"),
    setTabIconMode: vi.fn(),
  });
  expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(2);
  expect(pressedLabels(container)).toEqual(["Default"]);
  expect(props.tabIcon).toBe("lobster:crimson");
  expect(props.setTabIconMode).not.toHaveBeenCalled();

  rerender({ lobsterdexEnabled: true });
  expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(3);
  expect(button("Default").getAttribute("aria-pressed")).toBe("false");
  expect(pressedLabels(container)).toHaveLength(1);
});

it.each([
  ["agent", "square"],
  ["agent:rounded", "rounded"],
  ["agent:circle", "circle"],
] as const)(
  "keeps the saved %s shape when clicking the current source again",
  async (tabIcon, shape) => {
    const { props, container, button } = setup({ tabIcon });
    expect(pressedLabels(container)).toEqual([AGENT]);
    expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(2);
    const circle = button(AGENT);
    const preview = circle.querySelector(".identity-avatar--agent");
    expect(preview).not.toBeNull();
    circle.focus();
    await userEvent.keyboard("{Enter}");
    expect(props.tabIcon).toBe(tabIcon);
    expect(container.querySelector('input[type="radio"]:checked')?.getAttribute("value")).toBe(
      shape,
    );
    expect(button(AGENT)).toBe(circle);
    expect(circle.querySelector(".identity-avatar--agent")).toBe(preview);
    expect(preview?.getAttribute("data-avatar-shape")).toBe("circle");
    await userEvent.click(button("Default"));
    expect(props.tabIcon).toBe("default");
    expect(pressedLabels(container)).toEqual(["Default"]);
  },
);

it("keeps unavailable saved choices and makes an empty collection quietly unavailable", () => {
  const { props, container, rerender } = setup({
    tabIcon: "lobster:gold",
    setTabIconMode: vi.fn(),
  });
  expect(container.textContent).toContain("isn’t unlocked in this browser");
  expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(2);
  expect(pressedLabels(container)).toEqual(["Default"]);
  expect(props.setTabIconMode).not.toHaveBeenCalled();
  rerender({ tabIcon: "default" });
  expect(container.textContent).toContain("No lobsters unlocked");
});

it("selects personal artwork with a circular preview", async () => {
  const source = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="blue"/></svg>')}`;
  const setTabIconMode = vi.fn();
  const { rerender, button } = setup({ tabIconAgentAvatar: source, setTabIconMode });
  const agent = button(AGENT);
  await userEvent.click(agent);
  expect(setTabIconMode).toHaveBeenLastCalledWith("agent:circle");
  await waitForSolid(() => expect(agent.querySelector(".identity-avatar__image")).not.toBeNull());
  const image = agent.querySelector<HTMLImageElement>(".identity-avatar__image")!;
  expect(image.getAttribute("src")).toBe(source);
  expect(getComputedStyle(image).objectFit).toBe("cover");
  expect(button("Default").querySelector("img")?.getAttribute("src")).toContain("favicon.svg");
  rerender({ tabIcon: "agent", tabIconAgentAvatar: null });
  expect(button(AGENT).getAttribute("aria-pressed")).toBe("true");
  await waitForSolid(() => expect(agent.querySelector(".identity-avatar__image")).toBeNull());
  expect(agent.querySelector(".identity-avatar__fallback img")).not.toBeNull();
});
