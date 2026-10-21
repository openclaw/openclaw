import "../../styles/settings.css";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { TabIconSection, type TabIconViewProps } from "./view-tab-icon.tsx";

registerEnglishCatalog(registerSettingsEnglish);
function setup(overrides: Partial<TabIconViewProps> = {}) {
  const props: TabIconViewProps = {
    tabIcon: "default",
    setTabIconMode: (choice) => {
      props.tabIcon = choice;
      rerender();
    },
    ...overrides,
  };
  const [current, setCurrent] = createSignal({ ...props });
  const { container } = mountSolid(() => <TabIconSection {...current()} />);
  flush();
  const rerender = () => {
    setCurrent({ ...props });
    flush();
  };
  const button = (name: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  const preview = (mode: string) =>
    radio(container, mode)
      ?.closest("label")
      ?.querySelector(".identity-avatar--agent.settings-tab-icon__preview");
  return { props, container, rerender, button, preview };
}
const palettes = (...ids: string[]) =>
  LOBSTER_PET_PALETTES.filter((palette) => ids.includes(palette.id));
const radio = (container: HTMLElement, value: string) =>
  container.querySelector<HTMLInputElement>(`.settings-segmented__input[value="${value}"]`);
const selectedMode = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(".settings-segmented__input:checked")?.value;

describe("browser tab icon settings", () => {
  it("selects the first unlock on entry and exposes pressed, keyboard-selectable lobster choices", async () => {
    const { props, container, button } = setup({ tabIconLobsters: palettes("crimson", "pixel") });
    await userEvent.click(radio(container, "lobster")!);
    expect(props.tabIcon).toBe("lobster:crimson");
    const choices = container.querySelectorAll<HTMLButtonElement>(".settings-tab-icon__pick");
    expect(choices).toHaveLength(2);
    expect(choices[0]?.getAttribute("aria-pressed")).toBe("true");
    const pixel = button("Sprite");
    pixel.focus();
    await userEvent.keyboard("{Enter}");
    expect(props.tabIcon).toBe("lobster:pixel");
    expect(pixel.getAttribute("aria-pressed")).toBe("true");
    expect(choices[0]?.getAttribute("aria-pressed")).toBe("false");
    await waitForSolid(() => expect(pixel.querySelector(".lob-pixel-frame")).not.toBeNull());
    expect(pixel.getAnimations({ subtree: true })).toHaveLength(0);
  });

  it("hides collected artwork without changing the saved preference and restores it when enabled", () => {
    const { props, container, rerender } = setup({
      tabIcon: "lobster:crimson",
      lobsterdexEnabled: false,
      tabIconLobsters: palettes("crimson"),
      setTabIconMode: vi.fn(),
    });
    expect(radio(container, "lobster")).toBeNull();
    expect(container.querySelector(".settings-tab-icon__lobsters")).toBeNull();
    expect(container.textContent).not.toContain("Lobsterdex");
    expect(selectedMode(container)).toBe("default");
    expect(props.tabIcon).toBe("lobster:crimson");
    expect(props.setTabIconMode).not.toHaveBeenCalled();

    props.lobsterdexEnabled = true;
    rerender();
    expect(radio(container, "lobster")).not.toBeNull();
    expect(selectedMode(container)).toBe("lobster");
    expect(container.querySelector('.settings-tab-icon__pick[aria-pressed="true"]')).not.toBeNull();
  });

  it("shows avatar shapes only for agent artwork and supports keyboard selection", async () => {
    const { props, container, button, preview } = setup({ tabIcon: "agent" });
    const choices = container.querySelectorAll<HTMLButtonElement>(
      ".settings-tab-icon__shapes button",
    );
    const agentPreview = preview("agent");
    expect(agentPreview).not.toBeNull();
    expect(choices).toHaveLength(3);
    expect(choices[0]?.getAttribute("aria-pressed")).toBe("true");
    const circle = button("Circle");
    circle.focus();
    await userEvent.keyboard("{Enter}");
    expect(props.tabIcon).toBe("agent:circle");
    expect(button("Circle")).toBe(circle);
    expect(preview("agent")).toBe(agentPreview);
    expect(circle.getAttribute("aria-pressed")).toBe("true");
    expect(choices[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(selectedMode(container)).toBe("agent");
    await userEvent.click(button("Rounded corners"));
    expect(props.tabIcon).toBe("agent:rounded");
    props.setTabIconMode("default");
    expect(container.querySelector(".settings-tab-icon__shapes")).toBeNull();
    props.setTabIconMode("lobster:crimson");
    expect(container.querySelector(".settings-tab-icon__shapes")).toBeNull();
  });

  it("keeps unavailable saved choices and makes an empty collection quietly unavailable", () => {
    const { props, container, rerender } = setup({
      tabIcon: "lobster:gold",
      setTabIconMode: vi.fn(),
    });
    expect(container.textContent).toContain("not unlocked in this browser");
    expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(0);
    expect(selectedMode(container)).toBe("lobster");
    expect(props.setTabIconMode).not.toHaveBeenCalled();
    props.tabIcon = "default";
    rerender();
    expect(container.textContent).toContain("No lobsters unlocked");
    expect(radio(container, "lobster")?.disabled).toBe(true);
  });

  it("selects personal artwork while preserving its uncropped preview", async () => {
    const source = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="blue"/></svg>')}`;
    const { props, container, rerender } = setup({
      tabIconAgentAvatar: source,
      setTabIconMode: vi.fn(),
    });
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
    rerender();
    expect(selectedMode(container)).toBe("agent");
    await waitForSolid(() => expect(agent.querySelector(".identity-avatar__image")).toBeNull());
    expect(agent.querySelector(".identity-avatar__fallback img")).not.toBeNull();
  });
});
