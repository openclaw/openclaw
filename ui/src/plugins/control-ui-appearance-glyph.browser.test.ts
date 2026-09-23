import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createControlUiComponents } from "./control-ui-components.ts";

describe.runIf("__vitest_browser__" in globalThis)("mounted appearance glyph", () => {
  it("renders and clears colors and SVG artwork through the host component handle", async () => {
    const gateway = createGateway(createTestGatewayClient(() => ({})));
    const sessions = createSessions("main", []);
    const context = createContext(gateway, sessions);
    const lifetime = new AbortController();
    const onError = vi.fn();
    const container = document.createElement("div");
    container.style.setProperty("--session-color-blue", "rgb(30, 90, 180)");
    container.style.setProperty("--muted", "rgb(110, 115, 120)");
    container.style.color = "rgb(10, 20, 30)";
    document.body.append(container);
    onTestFinished(() => {
      lifetime.abort();
      container.remove();
    });
    const components = createControlUiComponents({
      current: () => context,
      signal: lifetime.signal,
      onError,
    });
    const props = { icon: "bot", color: "blue", fallback: "B" };
    const handle = components.mountAppearanceGlyph(container, props);
    await vi.dynamicImportSettled();
    expect(onError).not.toHaveBeenCalled();
    const renderedColor = (index = 0) => {
      const glyph = container.querySelectorAll("openclaw-appearance-glyph")[index];
      const svg = glyph?.shadowRoot?.querySelector("svg");
      return svg ? getComputedStyle(svg).color : null;
    };

    await expect.poll(() => renderedColor()).toBe("rgb(30, 90, 180)");
    const sibling = components.mountAppearanceGlyph(container, { ...props, color: "#206040" });
    await expect.poll(() => renderedColor(1)).toBe("rgb(32, 96, 64)");
    expect(renderedColor()).toBe("rgb(30, 90, 180)");

    handle.update({ ...props, color: "#c04080" });
    await expect.poll(() => renderedColor()).toBe("rgb(192, 64, 128)");
    expect(renderedColor(1)).toBe("rgb(32, 96, 64)");
    handle.update({ ...props, color: null });
    await expect.poll(() => renderedColor()).toBe("rgb(110, 115, 120)");
    expect(renderedColor(1)).toBe("rgb(32, 96, 64)");

    const svgIcon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"><rect width="24" height="12" fill="#206040"/></svg>')}`;
    handle.update({ ...props, icon: svgIcon });
    const glyph = () => container.querySelector("openclaw-appearance-glyph");
    const image = () => glyph()?.shadowRoot?.querySelector("img");
    await expect.poll(() => image()?.naturalWidth).toBe(24);
    expect(image()?.naturalHeight).toBe(12);
    expect(image()?.getAttribute("src")).toBe(svgIcon);
    expect(image()?.alt).toBe("");
    expect(glyph()?.shadowRoot?.querySelector("svg")).toBeNull();
    expect(getComputedStyle(image()!).objectFit).toBe("contain");
    expect(image()?.getBoundingClientRect().width).toBe(glyph()?.getBoundingClientRect().width);
    expect(renderedColor(1)).toBe("rgb(32, 96, 64)");

    handle.update({ ...props, icon: null });
    await expect.poll(() => glyph()?.shadowRoot?.textContent?.trim()).toBe("B");
    expect(image()).toBeNull();
    expect(renderedColor(1)).toBe("rgb(32, 96, 64)");

    handle.dispose();
    expect(renderedColor()).toBe("rgb(32, 96, 64)");
    sibling.dispose();
    expect(container.childElementCount).toBe(0);
    expect(getComputedStyle(container).color).toBe("rgb(10, 20, 30)");
    expect(onError).not.toHaveBeenCalled();
  });
});
