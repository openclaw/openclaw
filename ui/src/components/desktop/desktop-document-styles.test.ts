import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopDocumentStyles = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "desktop-panel.css"),
  "utf8",
);

describe("desktop document styles", () => {
  it("uses fixed inset sizing without viewport height units", () => {
    const documentRule = /\.desktop-document\s*\{([^}]*)\}/.exec(desktopDocumentStyles)?.[1];
    expect(documentRule).toContain("position: fixed");
    expect(documentRule).toContain("inset: 0");
    expect(desktopDocumentStyles).not.toMatch(/\d(?:dvh|svh|lvh|vh)\b/);
  });
});
