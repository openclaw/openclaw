import { afterEach, describe, expect, it } from "vitest";
import {
  clearActiveFloatingTooltips,
  promoteNativeTitleTooltip,
  refreshActiveFloatingTooltip,
  restoreNativeTitleTooltip,
} from "./dom-tooltips.ts";

afterEach(() => {
  clearActiveFloatingTooltips();
  document.querySelector(".control-ui-floating-tooltip")?.remove();
});

describe("native title tooltip promotion", () => {
  it("promotes button titles into custom tooltip metadata while active", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.className = "btn";
    button.title = "Refresh";
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");

    expect(button.getAttribute("title")).toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Refresh");
    expect(button.getAttribute("data-tooltip")).toBe("Refresh");
    expect(button.getAttribute("data-native-tooltip-title")).toBe("Refresh");
    expect(button.getAttribute("data-floating-tooltip-active")).toBe("true");
    expect(document.querySelector(".control-ui-floating-tooltip")?.textContent).toBe("Refresh");

    restoreNativeTitleTooltip(button, root, "pointer");

    expect(button.getAttribute("title")).toBe("Refresh");
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(button.getAttribute("data-tooltip")).toBeNull();
    expect(button.getAttribute("data-native-tooltip-title")).toBeNull();
    expect(button.getAttribute("data-floating-tooltip-active")).toBeNull();
  });

  it("preserves existing accessible labels while promoting title tooltips", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.className = "btn";
    button.title = "Browser fallback";
    button.setAttribute("aria-label", "Open session");
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");
    restoreNativeTitleTooltip(button, root, "pointer");

    expect(button.getAttribute("aria-label")).toBe("Open session");
  });

  it("preserves visible button names while promoting descriptive title tooltips", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.className = "btn";
    button.title = "Chroma family";
    button.textContent = "Claw";
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");

    expect(button.textContent).toBe("Claw");
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(button.getAttribute("data-tooltip")).toBe("Chroma family");

    restoreNativeTitleTooltip(button, root, "pointer");

    expect(button.getAttribute("title")).toBe("Chroma family");
    expect(button.getAttribute("aria-label")).toBeNull();
  });

  it("does not promote rich role-button containers", () => {
    const root = document.createElement("div");
    const card = document.createElement("article");
    card.setAttribute("role", "button");
    card.title = "View details";
    card.textContent = "Ready card density visual check";
    root.append(card);

    expect(promoteNativeTitleTooltip(card, root, "pointer")).toBeNull();
    expect(card.getAttribute("title")).toBe("View details");
    expect(card.getAttribute("aria-label")).toBeNull();
  });

  it("preserves explicit custom tooltip metadata", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.className = "btn";
    button.title = "Browser fallback";
    button.setAttribute("data-tooltip", "Custom tooltip");
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");
    restoreNativeTitleTooltip(button, root, "pointer");

    expect(button.getAttribute("title")).toBe("Browser fallback");
    expect(button.getAttribute("data-tooltip")).toBe("Custom tooltip");
  });

  it("refreshes generated custom tooltip text after a hovered button changes title", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.className = "btn";
    button.title = "Show archived cards";
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");
    button.title = "Hide archived cards";
    promoteNativeTitleTooltip(button, root, "pointer");

    expect(button.getAttribute("data-tooltip")).toBe("Hide archived cards");
    expect(button.getAttribute("aria-label")).toBe("Hide archived cards");
    expect(document.querySelector(".control-ui-floating-tooltip")?.textContent).toBe(
      "Hide archived cards",
    );
  });

  it("refreshes the active floating tooltip after a render restores title", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.className = "btn";
    button.title = "Show archived cards";
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");
    button.title = "Hide archived cards";
    refreshActiveFloatingTooltip(root);

    expect(button.getAttribute("title")).toBeNull();
    expect(button.getAttribute("data-tooltip")).toBe("Hide archived cards");
    expect(button.getAttribute("data-native-tooltip-title")).toBe("Hide archived cards");
    expect(button.getAttribute("aria-label")).toBe("Hide archived cards");
    expect(document.querySelector(".control-ui-floating-tooltip")?.textContent).toBe(
      "Hide archived cards",
    );

    restoreNativeTitleTooltip(button, root, "pointer");

    expect(button.getAttribute("title")).toBe("Hide archived cards");
  });

  it("hides the floating tooltip after the active target is removed", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.className = "btn";
    button.title = "View details";
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");
    button.remove();
    refreshActiveFloatingTooltip(root);

    expect(document.querySelector<HTMLElement>(".control-ui-floating-tooltip")?.dataset.open).toBe(
      "false",
    );
  });

  it("shows explicit custom tooltip metadata without a native title", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.className = "btn";
    button.setAttribute("data-tooltip", "View details");
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");

    expect(button.getAttribute("title")).toBeNull();
    expect(button.getAttribute("data-tooltip")).toBe("View details");
    expect(button.getAttribute("data-floating-tooltip-active")).toBe("true");
    expect(document.querySelector(".control-ui-floating-tooltip")?.textContent).toBe(
      "View details",
    );

    restoreNativeTitleTooltip(button, root, "pointer");

    expect(button.getAttribute("data-tooltip")).toBe("View details");
    expect(button.getAttribute("data-floating-tooltip-active")).toBeNull();
    expect(document.querySelector<HTMLElement>(".control-ui-floating-tooltip")?.dataset.open).toBe(
      "false",
    );
  });

  it("positions the floating tooltip below the button midpoint", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.className = "btn";
    button.title = "Delete card";
    button.getBoundingClientRect = () =>
      ({
        left: 300,
        right: 328,
        top: 10,
        bottom: 38,
        width: 28,
        height: 28,
        x: 300,
        y: 10,
        toJSON: () => ({}),
      }) as DOMRect;
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");

    const tooltip = document.querySelector<HTMLElement>(".control-ui-floating-tooltip");
    expect(tooltip?.style.left).toBe("314px");
    expect(tooltip?.style.top).toBe("44px");
  });

  it("repositions the active floating tooltip on viewport movement", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    let top = 10;
    button.className = "btn";
    button.title = "Delete card";
    button.getBoundingClientRect = () =>
      ({
        left: 300,
        right: 328,
        top,
        bottom: top + 28,
        width: 28,
        height: 28,
        x: 300,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    root.append(button);

    promoteNativeTitleTooltip(button, root, "focus");
    const tooltip = document.querySelector<HTMLElement>(".control-ui-floating-tooltip");
    expect(tooltip?.style.top).toBe("44px");

    top = 100;
    window.dispatchEvent(new Event("scroll"));
    expect(tooltip?.style.top).toBe("134px");

    restoreNativeTitleTooltip(button, root, "focus");
    top = 200;
    window.dispatchEvent(new Event("scroll"));
    expect(tooltip?.style.top).toBe("134px");
  });

  it("flips the floating tooltip above buttons near the bottom viewport edge", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    const targetTop = window.innerHeight - 38;
    button.className = "btn";
    button.title = "Delete card";
    button.getBoundingClientRect = () =>
      ({
        left: 300,
        right: 328,
        top: targetTop,
        bottom: targetTop + 28,
        width: 28,
        height: 28,
        x: 300,
        y: targetTop,
        toJSON: () => ({}),
      }) as DOMRect;
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");
    const tooltip = document.querySelector<HTMLElement>(".control-ui-floating-tooltip");
    if (tooltip) {
      tooltip.getBoundingClientRect = () =>
        ({
          left: 0,
          right: 100,
          top: 0,
          bottom: 24,
          width: 100,
          height: 24,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
    }

    refreshActiveFloatingTooltip(root);

    expect(tooltip?.style.top).toBe(`${window.innerHeight - 68}px`);
  });

  it("clamps the floating tooltip away from viewport edges", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.className = "btn";
    button.title = "Delete card with a longer label";
    button.getBoundingClientRect = () =>
      ({
        left: 2,
        right: 30,
        top: 10,
        bottom: 38,
        width: 28,
        height: 28,
        x: 2,
        y: 10,
        toJSON: () => ({}),
      }) as DOMRect;
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");

    const tooltip = document.querySelector<HTMLElement>(".control-ui-floating-tooltip");
    expect(Number.parseFloat(tooltip?.style.left ?? "0")).toBeGreaterThan(100);
  });

  it("does not restore while pointer movement stays inside the promoted button", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.className = "btn";
    button.title = "Stop";
    button.append(icon);
    root.append(button);

    promoteNativeTitleTooltip(button, root, "pointer");
    restoreNativeTitleTooltip(button, root, "pointer", icon);

    expect(button.getAttribute("title")).toBeNull();
    expect(button.getAttribute("data-tooltip")).toBe("Stop");
  });

  it.each([
    ["pointer", "focus"],
    ["focus", "pointer"],
  ] as const)(
    "keeps the tooltip active after %s leaves while %s remains",
    (released, remaining) => {
      const root = document.createElement("div");
      const button = document.createElement("button");
      button.className = "btn";
      button.title = "Refresh";
      root.append(button);

      promoteNativeTitleTooltip(button, root, "pointer");
      promoteNativeTitleTooltip(button, root, "focus");

      expect(restoreNativeTitleTooltip(button, root, released)).toBeNull();
      expect(button.getAttribute("title")).toBeNull();
      expect(button.getAttribute("data-floating-tooltip-active")).toBe("true");
      expect(
        document.querySelector<HTMLElement>(".control-ui-floating-tooltip")?.dataset.open,
      ).toBe("true");

      expect(restoreNativeTitleTooltip(button, root, remaining)).toBe(button);
      expect(button.getAttribute("title")).toBe("Refresh");
      expect(button.getAttribute("data-floating-tooltip-active")).toBeNull();
    },
  );

  it("restores the remaining active tooltip owner", () => {
    const root = document.createElement("div");
    const focused = document.createElement("button");
    focused.className = "btn";
    focused.title = "Focused";
    const hovered = document.createElement("button");
    hovered.className = "btn";
    hovered.title = "Hovered";
    root.append(focused, hovered);

    promoteNativeTitleTooltip(focused, root, "focus");
    promoteNativeTitleTooltip(hovered, root, "pointer");
    refreshActiveFloatingTooltip(root);

    expect(document.querySelector(".control-ui-floating-tooltip")?.textContent).toBe("Hovered");

    restoreNativeTitleTooltip(hovered, root, "pointer");

    expect(document.querySelector(".control-ui-floating-tooltip")?.textContent).toBe("Focused");
    expect(document.querySelector<HTMLElement>(".control-ui-floating-tooltip")?.dataset.open).toBe(
      "true",
    );

    restoreNativeTitleTooltip(focused, root, "focus");

    expect(document.querySelector<HTMLElement>(".control-ui-floating-tooltip")?.dataset.open).toBe(
      "false",
    );
  });

  it("clears active floating tooltips and restores promoted titles", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.className = "btn";
    button.title = "View details";
    root.append(button);
    document.body.append(root);

    promoteNativeTitleTooltip(button, root, "pointer");
    clearActiveFloatingTooltips(root);

    expect(button.getAttribute("title")).toBe("View details");
    expect(button.getAttribute("data-tooltip")).toBeNull();
    expect(button.getAttribute("data-native-tooltip-title")).toBeNull();
    expect(button.getAttribute("data-floating-tooltip-active")).toBeNull();
    expect(document.querySelector<HTMLElement>(".control-ui-floating-tooltip")?.dataset.open).toBe(
      "false",
    );
    root.remove();
  });
});
