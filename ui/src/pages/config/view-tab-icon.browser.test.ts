import "../../styles/settings.css";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { renderTabIconSection, type TabIconViewProps } from "./view-tab-icon.ts";

registerSettingsEnglish();
const containers: HTMLElement[] = [];
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
        render(renderTabIconSection(props), container);
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    render(renderTabIconSection(props), container);
    const group = container.querySelector("wa-radio-group")!;
    await group.updateComplete;
    await Promise.all(
      [...container.querySelectorAll("wa-radio")].map((radio) => radio.updateComplete),
    );
    await userEvent.click(container.querySelector('wa-radio[value="lobster"]')!);
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
    expect(pixel.querySelector(".lob-pixel-frame")).not.toBeNull();
    expect(pixel.getAnimations({ subtree: true })).toHaveLength(0);
  });

  it("keeps unavailable saved choices and makes an empty collection quietly unavailable", async () => {
    const props: TabIconViewProps = { tabIcon: "lobster:gold", setTabIconMode: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    render(renderTabIconSection(props), container);
    expect(container.textContent).toContain("not unlocked in this browser");
    expect(container.querySelectorAll(".settings-tab-icon__pick")).toHaveLength(0);
    const group = container.querySelector("wa-radio-group")!;
    await group.updateComplete;
    expect(group.value).toBe("lobster");
    expect(props.setTabIconMode).not.toHaveBeenCalled();
    props.tabIcon = "default";
    render(renderTabIconSection(props), container);
    expect(container.textContent).toContain("No lobsters unlocked");
    expect(container.querySelector('wa-radio[value="lobster"]')?.hasAttribute("disabled")).toBe(
      true,
    );
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
    render(renderTabIconSection(props), container);
    const group = container.querySelector("wa-radio-group")!;
    await group.updateComplete;
    await Promise.all(
      [...container.querySelectorAll("wa-radio")].map((radio) => radio.updateComplete),
    );
    const agent = container.querySelector('wa-radio[value="agent"]')!;
    await userEvent.click(agent);
    expect(vi.mocked(props.setTabIconMode).mock.calls.at(-1)?.[0]).toBe("agent");
    const image = agent.querySelector<HTMLImageElement>(".identity-avatar__image")!;
    expect(image.getAttribute("src")).toBe(source);
    expect(getComputedStyle(image).objectFit).toBe("contain");
    expect(container.querySelector('wa-radio[value="default"] img')?.getAttribute("src")).toContain(
      "favicon.svg",
    );
    props.tabIcon = "agent";
    props.tabIconAgentAvatar = null;
    render(renderTabIconSection(props), container);
    expect(group.value).toBe("agent");
    expect(agent.querySelector(".identity-avatar__image")).toBeNull();
    expect(agent.querySelector(".identity-avatar__fallback img")).not.toBeNull();
  });
});
