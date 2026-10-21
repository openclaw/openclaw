/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { buildMacGatewayLaunchUrl } from "./gateway-launch.ts";
import { Apps } from "./view.tsx";

const EXPECTED_EXTERNAL_HREFS = [
  "https://apps.apple.com/app/openclaw-ai-that-does-things/id6780396132",
  "https://docs.openclaw.ai/platforms/ios",
  "https://play.google.com/store/apps/details?id=ai.openclaw.app",
  "https://docs.openclaw.ai/platforms/android",
  "https://docs.openclaw.ai/platforms/ios",
  "https://docs.openclaw.ai/platforms/android",
  "https://github.com/openclaw/openclaw/releases",
  "https://docs.openclaw.ai/platforms/macos",
  "https://github.com/openclaw/openclaw-windows-node/releases/latest",
  "https://docs.openclaw.ai/platforms/windows",
  "https://github.com/openclaw/openclaw/releases",
  "https://docs.openclaw.ai/platforms/linux",
  "https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig",
  "https://docs.openclaw.ai/tools/chrome-extension",
  "https://clawhub.ai",
  "https://discord.gg/clawd",
  "https://docs.openclaw.ai",
];

describe("Apps", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  function renderIntoContainer(props: Partial<Parameters<typeof Apps>[0]> = {}) {
    const container = document.createElement("div");
    return mountSolid(() => <Apps onNavigate={vi.fn()} {...props} />, { container }).container;
  }

  it("renders every external link in order with safe target and rel", () => {
    const container = renderIntoContainer();
    const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]"));
    expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual(EXPECTED_EXTERNAL_HREFS);
    for (const anchor of anchors) {
      expect(anchor.getAttribute("target")).toBe("_blank");
      expect(anchor.getAttribute("rel")).toContain("noopener");
      expect(anchor.getAttribute("rel")).toContain("noreferrer");
    }
  });

  it("navigates to the in-app Plugins hub from the plugins card", () => {
    const onNavigate = vi.fn();
    const container = renderIntoContainer({ onNavigate });
    const buttons = container.querySelectorAll<HTMLButtonElement>("button.apps-card__cta");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toContain("Open Plugins");
    buttons[0]?.click();
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("plugins");
  });

  it("opens the connected Gateway in the Mac app without losing the download option", () => {
    const container = renderIntoContainer({
      macGatewayLaunchUrl: buildMacGatewayLaunchUrl("wss://research.example:8443/assistant"),
    });
    const launch = container.querySelector<HTMLAnchorElement>("a[href^='openclaw:']");
    expect(launch?.textContent?.trim()).toBe("Open in Mac app");
    expect(launch?.href).toBe(
      "openclaw://gateway/add?url=https%3A%2F%2Fresearch.example%3A8443%2Fassistant",
    );
    expect(launch?.getAttribute("target")).toBeNull();
    const card = launch?.closest(".apps-card");
    expect(card?.querySelector("h3")?.textContent).toBe("macOS");
    const download = card?.querySelector("a[href='https://github.com/openclaw/openclaw/releases']");
    expect(download?.textContent?.trim()).toBe("Download");
  });

  it("offers device pairing from the phone section only when permitted", () => {
    const withoutPair = renderIntoContainer();
    expect(withoutPair.querySelector(".apps-pair-hint")).toBeNull();

    const onPairDevice = vi.fn();
    const container = renderIntoContainer({ onPairDevice });
    const hint = container.querySelector(".apps-pair-hint");
    expect(hint?.textContent).toContain("Already have the app?");
    hint?.querySelector("button")?.click();
    expect(onPairDevice).toHaveBeenCalledOnce();
  });

  it("renders decorative lazy card art with a per-theme variant for every card", () => {
    const container = renderIntoContainer();
    const images = Array.from(container.querySelectorAll<HTMLImageElement>(".apps-card__art img"));
    expect(images).toHaveLength(18);
    for (const image of images) {
      expect(image.getAttribute("alt")).toBe("");
      expect(image.getAttribute("loading")).toBe("lazy");
    }
    const sources = (theme: string) =>
      images
        .filter((image) => image.classList.contains(`apps-card__art-img--${theme}`))
        .map((image) => image.getAttribute("src"));
    const lightSrcs = sources("light");
    expect(lightSrcs).toHaveLength(9);
    for (const src of lightSrcs) {
      expect(src).toMatch(/^\/app-art\/[a-z-]+\.webp$/);
    }
    expect(sources("dark")).toEqual(lightSrcs.map((src) => src?.replace(/\.webp$/, "-dark.webp")));
  });
});
