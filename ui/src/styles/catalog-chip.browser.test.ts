import { expect, it } from "vitest";
import catalogStyles from "./plugins.css?inline";

it("inverts just the selected catalog chip against the theme surface", () => {
  const style = document.createElement("style");
  style.textContent = catalogStyles;
  const row = document.createElement("div");
  row.style.cssText = "--text: rgb(225, 226, 227); --bg: rgb(20, 21, 22); --radius-md: 10px";
  const activeChip = document.createElement("button");
  activeChip.className = "plugin-catalog-chip is-active";
  const idleChip = document.createElement("button");
  idleChip.className = "plugin-catalog-chip";
  row.append(activeChip, idleChip);
  document.head.append(style);
  document.body.append(row);
  try {
    const selected = getComputedStyle(activeChip);
    const idle = getComputedStyle(idleChip);
    expect(selected.backgroundColor).toBe("rgb(225, 226, 227)");
    expect(selected.color).toBe("rgb(20, 21, 22)");
    expect(selected.borderRadius).toBe(idle.borderRadius);
    expect(idle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  } finally {
    row.remove();
    style.remove();
  }
});
