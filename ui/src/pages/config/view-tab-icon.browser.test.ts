import "../../styles/settings.css";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { renderTabIconSection, type TabIconViewProps } from "./view-tab-icon.ts";

registerSettingsEnglish();
const containers: HTMLElement[] = [];
afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

describe("browser tab icon settings", () => {
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
