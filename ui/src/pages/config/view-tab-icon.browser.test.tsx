import "../../styles/settings.css";
import { createSignal } from "solid-js";
import { expect, it, vi, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";
import {
  LOBSTER_PET_PALETTES,
  recordLobsterVisit,
  subscribeLobsterdex,
} from "../../../../extensions/lobsterdex/browser/api.ts";
import { createTabIcons } from "../../../../extensions/lobsterdex/browser/tab-icons.ts";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { createInertViewHost } from "../../plugins/control-ui-view.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { accessoryFixture } from "../../test-helpers/control-ui-accessory-fixture.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { TabIconRow, type TabIconViewProps } from "./view-tab-icon.tsx";

registerEnglishCatalog(registerSettingsEnglish);
type FixtureProps = TabIconViewProps & {
  tabIconLobsters?: typeof LOBSTER_PET_PALETTES;
  lobsterdexEnabled?: boolean;
};
async function setup(overrides: Partial<FixtureProps> = {}) {
  localStorage.clear();
  onTestFinished(() => localStorage.clear());
  for (const palette of overrides.tabIconLobsters ?? []) {
    recordLobsterVisit(palette.id);
  }
  const props: FixtureProps = {
    tabIcon: "default",
    setTabIconMode: (choice) => rerender({ tabIcon: choice }),
    ...overrides,
  };
  const [current, setCurrent] = createSignal({ ...props });
  const listeners = new Set<() => void>();
  const host = createInertViewHost(new AbortController().signal);
  Object.assign(host, {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    presentation: {
      version: 1,
      get branding() {
        return resolveThemeBranding({ lobsterdex: props.lobsterdexEnabled ?? true });
      },
      translate: t,
    },
  });
  const icons = createTabIcons(host);
  const mount = icons.mount;
  const fixture = accessoryFixture([{ ...icons, mount }], host);
  onTestFinished(subscribeLobsterdex(fixture.publish));
  // SAFETY: this row consumes the registry only; the native bundle test uses a complete application.
  const context = { plugins: fixture.plugins } as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  document.body.append(provider);
  onTestFinished(() => provider.remove());
  const container = provider.appendChild(document.createElement("div"));
  mountSolid(
    () => (
      <ApplicationProvider value={context}>
        <TabIconRow {...current()} />
      </ApplicationProvider>
    ),
    { container },
  );
  await waitForSolid(() =>
    expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(
      2 + (props.lobsterdexEnabled === false ? 0 : (props.tabIconLobsters?.length ?? 0)),
    ),
  );
  flush();
  const rerender = (patch: Partial<FixtureProps> = {}) => {
    Object.assign(props, patch);
    setCurrent({ ...props });
    fixture.publish();
    for (const listener of listeners) {
      listener();
    }
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

it("offers every choice in one row without adding or removing rows", async () => {
  const { props, container, button } = await setup({
    tabIconLobsters: palettes("crimson", "pixel"),
  });
  const rows = () => container.querySelectorAll(".settings-row").length;
  expect(rows()).toBe(1);
  expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(4);
  expect(pressedLabels(container)).toEqual(["Default"]);

  await userEvent.click(button(AGENT));
  expect(props.tabIcon).toBe("agent");
  expect(rows()).toBe(1);
  expect(pressedLabels(container)).toEqual([AGENT]);

  const pixel = button("Sprite");
  pixel.focus();
  await userEvent.keyboard("{Enter}");
  expect(props.tabIcon).toBe("lobster:pixel");
  expect(rows()).toBe(1);
  expect(pressedLabels(container)).toEqual(["Sprite"]);
  await waitForSolid(() => expect(pixel.querySelector(".lob-pixel-frame")).not.toBeNull());
  expect(pixel.getAnimations({ subtree: true })).toHaveLength(0);
});

it("hides collected artwork without changing the saved preference and restores it when enabled", async () => {
  const { props, container, rerender, button } = await setup({
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
  await waitForSolid(() =>
    expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(3),
  );
  expect(button("Default").getAttribute("aria-pressed")).toBe("false");
  expect(pressedLabels(container)).toHaveLength(1);
});

it.each(["agent", "agent:rounded", "agent:circle"] as const)(
  "shows one circular choice for saved %s artwork and keeps its preview mounted",
  async (tabIcon) => {
    const { props, container, button } = await setup({ tabIcon });
    expect(pressedLabels(container)).toEqual([AGENT]);
    expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(2);
    const circle = button(AGENT);
    const preview = circle.querySelector(".identity-avatar--agent");
    expect(preview).not.toBeNull();
    circle.focus();
    await userEvent.keyboard("{Enter}");
    expect(props.tabIcon).toBe("agent");
    expect(button(AGENT)).toBe(circle);
    expect(circle.querySelector(".identity-avatar--agent")).toBe(preview);
    expect(preview?.getAttribute("data-avatar-shape")).toBe("circle");
    await userEvent.click(button("Default"));
    expect(props.tabIcon).toBe("default");
    expect(pressedLabels(container)).toEqual(["Default"]);
  },
);

it("keeps unavailable saved choices and makes an empty collection quietly unavailable", async () => {
  const { props, container, rerender } = await setup({
    tabIcon: "lobster:gold",
    setTabIconMode: vi.fn(),
  });
  expect(container.textContent).toContain("not unlocked in this browser");
  expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(2);
  expect(pressedLabels(container)).toEqual(["Default"]);
  expect(props.setTabIconMode).not.toHaveBeenCalled();
  rerender({ tabIcon: "default" });
  expect(container.textContent).toContain("No lobsters unlocked");
});

it("selects personal artwork with a circular preview", async () => {
  const source = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="blue"/></svg>')}`;
  const setTabIconMode = vi.fn();
  const { rerender, button } = await setup({ tabIconAgentAvatar: source, setTabIconMode });
  const agent = button(AGENT);
  await userEvent.click(agent);
  expect(setTabIconMode).toHaveBeenLastCalledWith("agent");
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
