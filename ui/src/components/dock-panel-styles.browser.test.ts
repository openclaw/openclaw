import { afterEach, expect, it } from "vitest";
import browserStyles from "./browser/browser-panel.css?inline";
import desktopStyles from "./desktop/desktop-panel.css?inline";
import dockStyles from "./dock-panel-solid.css?inline";

afterEach(() => document.body.replaceChildren());

it("keeps embedded panels in flow when another panel injects shared dock styles", () => {
  for (const [tag, styles] of [
    ["openclaw-browser-panel", browserStyles],
    ["openclaw-desktop-panel", desktopStyles],
    ["openclaw-terminal-panel", ""],
  ] as const) {
    const host = document.createElement(tag);
    const style = document.createElement("style");
    style.textContent = `${dockStyles}\n${styles}`;
    host.append(style);
    if (tag !== "openclaw-terminal-panel") {
      const panel = document.createElement("section");
      panel.className = "bp bp--embedded";
      host.append(panel);
    }
    document.body.append(host);
  }

  expect(
    [...document.querySelectorAll(".bp--embedded")].map(
      (panel) => getComputedStyle(panel).position,
    ),
  ).toEqual(["relative", "relative"]);
});
