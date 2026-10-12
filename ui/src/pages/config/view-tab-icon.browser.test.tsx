import "../../styles/settings.css";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { TabIconSection, type TabIconViewProps } from "./view-tab-icon.tsx";

registerEnglishCatalog(registerSettingsEnglish);
const containers: HTMLElement[] = [];
const updates = new WeakMap<HTMLElement, (props: TabIconViewProps) => void>();
function renderTabIcon(props: TabIconViewProps, container: HTMLElement) {
  const update = updates.get(container);
  if (update) {
    update({ ...props });
  } else {
    const [current, setCurrent] = createSignal({ ...props });
    updates.set(container, setCurrent);
    mountSolid(() => <TabIconSection {...current()} />, { container });
  }
  flush();
}
const radio = (container: HTMLElement, value: string) =>
  container.querySelector<HTMLInputElement>(`.settings-segmented__input[value="${value}"]`);
const selectedMode = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(".settings-segmented__input:checked")?.value;
afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

describe("browser tab icon settings", () => {
  it("selects the first unlock on entry and exposes pressed, keyboard-selectable lobster choices", async () => {
    const props: TabIconViewProps = {
      tabIcon: "default",
      tabIconLobsters: LOBSTER_PET_PALETTES.filter((palette) =>
        ["crimson", "pixel"].includes(palette.id),
      ),
      setTabIconMode: (choice) => {
        props.tabIcon = choice;
        renderTabIcon(props, container);
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    renderTabIcon(props, container);
    await userEvent.click(radio(container, "lobster")!);
    expect(props.tabIcon).toBe("lobster:crimson");
    const choices = container.querySelectorAll<HTMLButtonElement>(".settings-tab-icon__pick");
    expect(choices).toHaveLength(2);
    expect(choices[0]?.getAttribute("aria-pressed")).toBe("true");
    const pixel = container.querySelector<HTMLButtonElement>('button[aria-label="Sprite"]')!;
    pixel.focus();
    await userEvent.keyboard("{Enter}");
    expect(props.tabIcon).toBe("lobster:pixel");
    expect(pixel.getAttribute("aria-pressed")).toBe("true");
    expect(choices[0]?.getAttribute("aria-pressed")).toBe("false");
    await waitForSolid(() => expect(pixel.querySelector(".lob-pixel-frame")).not.toBeNull());
    expect(pixel.getAnimations({ subtree: true })).toHaveLength(0);
  });

  it("hides collected artwork without changing the saved preference and restores it when enabled", () => {
    const props: TabIconViewProps = {
      tabIcon: "lobster:crimson",
      lobsterdexEnabled: false,
      tabIconLobsters: LOBSTER_PET_PALETTES.filter((palette) => palette.id === "crimson"),
      setTabIconMode: vi.fn(),
    };
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    renderTabIcon(props, container);
    expect(radio(container, "lobster")).toBeNull();
    expect(container.querySelector(".settings-tab-icon__lobsters")).toBeNull();
    expect(container.textContent).not.toContain("Lobsterdex");
    expect(selectedMode(container)).toBe("default");
    expect(props.tabIcon).toBe("lobster:crimson");
    expect(props.setTabIconMode).not.toHaveBeenCalled();

    props.lobsterdexEnabled = true;
    renderTabIcon(props, container);
    expect(radio(container, "lobster")).not.toBeNull();
    expect(selectedMode(container)).toBe("lobster");
    expect(container.querySelector('.settings-tab-icon__pick[aria-pressed="true"]')).not.toBeNull();
  });

  it("shows avatar shapes only for agent artwork and supports keyboard selection", async () => {
    const props: TabIconViewProps = {
      tabIcon: "agent",
      setTabIconMode: (choice) => {
        props.tabIcon = choice;
        renderTabIcon(props, container);
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    renderTabIcon(props, container);
    const choices = container.querySelectorAll<HTMLButtonElement>(
      ".settings-tab-icon__shapes button",
    );
    const agentPreview = radio(container, "agent")
      ?.closest("label")
      ?.querySelector(".identity-avatar--agent.settings-tab-icon__preview");
    expect(agentPreview).not.toBeNull();
    expect(choices).toHaveLength(3);
    expect(choices[0]?.getAttribute("aria-pressed")).toBe("true");
    const circle = container.querySelector<HTMLButtonElement>('button[aria-label="Circle"]')!;
    circle.focus();
    await userEvent.keyboard("{Enter}");
    expect(props.tabIcon).toBe("agent:circle");
    expect(container.querySelector('button[aria-label="Circle"]')).toBe(circle);
    expect(
      radio(container, "agent")
        ?.closest("label")
        ?.querySelector(".identity-avatar--agent.settings-tab-icon__preview"),
    ).toBe(agentPreview);
    expect(circle.getAttribute("aria-pressed")).toBe("true");
    expect(choices[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(selectedMode(container)).toBe("agent");
    const rounded = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Rounded corners"]',
    )!;
    await userEvent.click(rounded);
    expect(props.tabIcon).toBe("agent:rounded");
    props.setTabIconMode("default");
    expect(container.querySelector(".settings-tab-icon__shapes")).toBeNull();
    props.setTabIconMode("lobster:crimson");
    expect(container.querySelector(".settings-tab-icon__shapes")).toBeNull();
  });

  it("keeps unavailable saved choices and makes an empty collection quietly unavailable", () => {
    const props: TabIconViewProps = { tabIcon: "lobster:gold", setTabIconMode: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    renderTabIcon(props, container);
    expect(container.textContent).toContain("not unlocked in this browser");
    expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(0);
    expect(selectedMode(container)).toBe("lobster");
    expect(props.setTabIconMode).not.toHaveBeenCalled();
    props.tabIcon = "default";
    renderTabIcon(props, container);
    expect(container.textContent).toContain("No lobsters unlocked");
    expect(radio(container, "lobster")?.disabled).toBe(true);
  });

  it("selects personal artwork while preserving its uncropped preview", async () => {
    const source = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="blue"/></svg>')}`;
    const props: TabIconViewProps = {
      tabIcon: "default",
      tabIconAgentAvatar: source,
      setTabIconMode: vi.fn(),
    };
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    renderTabIcon(props, container);
    const agentRadio = radio(container, "agent")!;
    const agent = agentRadio.closest("label")!;
    await userEvent.click(agentRadio);
    expect(vi.mocked(props.setTabIconMode).mock.calls.at(-1)?.[0]).toBe("agent");
    await waitForSolid(() => expect(agent.querySelector(".identity-avatar__image")).not.toBeNull());
    const image = agent.querySelector<HTMLImageElement>(".identity-avatar__image")!;
    expect(image.getAttribute("src")).toBe(source);
    expect(getComputedStyle(image).objectFit).toBe("contain");
    expect(
      radio(container, "default")?.closest("label")?.querySelector("img")?.getAttribute("src"),
    ).toContain("favicon.svg");
    props.tabIcon = "agent";
    props.tabIconAgentAvatar = null;
    renderTabIcon(props, container);
    expect(selectedMode(container)).toBe("agent");
    await waitForSolid(() => expect(agent.querySelector(".identity-avatar__image")).toBeNull());
    expect(agent.querySelector(".identity-avatar__fallback img")).not.toBeNull();
  });
});
