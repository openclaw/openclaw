import { flush } from "solid-js";
/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { deviceIcon } from "./view-shared.tsx";

describe("deviceIcon", () => {
  it.each([
    ["MacBook", { modelIdentifier: "MacBookPro18,1" }, "M18 5"],
    ["Mac Studio", { modelIdentifier: "Mac15,14" }, "M15 14"],
    ["Mac mini", { modelIdentifier: "Mac16,11" }, "M2.212"],
    ["Mac Pro", { modelIdentifier: "MacPro7,1" }, "M15 14"],
    ["iMac", { modelIdentifier: "iMac21,1" }, 'height="14"'],
    ["iPhone", { modelIdentifier: "iPhone17,1" }, "M12 18"],
    ["iPad", { modelIdentifier: "iPad16,3", platform: "iOS 18.0" }, "M12 18"],
    ["watch", { modelIdentifier: "Watch7,1" }, "m16.13"],
    ["browser client", { clientId: "openclaw-control-ui" }, 'r="10"'],
    ["CLI mode", { clientMode: "cli" }, 'points="4 17 10 11 4 5"'],
    ["TUI client", { clientId: "openclaw-tui", clientMode: "ui" }, 'points="4 17 10 11 4 5"'],
    ["gateway server", { clientMode: "gateway" }, 'height="8"'],
    ["unknown", { modelIdentifier: "Mac99,99" }, 'height="14"'],
  ] as const)("renders %s with its form-factor glyph", (_label, source, expectedIcon) => {
    const container = document.createElement("div");
    mountSolid(() => deviceIcon(source), { container });
    flush();
    expect(container.innerHTML).toContain(expectedIcon);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
    expect(svg?.children.length).toBeGreaterThan(0);
    for (const shape of svg?.children ?? []) {
      expect(shape.namespaceURI).toBe("http://www.w3.org/2000/svg");
    }
  });
});
