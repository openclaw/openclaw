import { describe, expect, it } from "vitest";
import desktopDocumentStyles from "./desktop-panel.css?raw";

describe("desktop document styles", () => {
  it("uses fixed inset sizing without viewport height units", () => {
    expect(desktopDocumentStyles).toContain("position: fixed");
    expect(desktopDocumentStyles).toContain("inset: 0");
    expect(desktopDocumentStyles).not.toMatch(/\d(?:dvh|svh|lvh|vh)\b/);
  });
});
