import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readComponentsCss() {
  const candidates = [
    path.join(process.cwd(), "ui/src/styles/components.css"),
    path.join(process.cwd(), "src/styles/components.css"),
  ];
  const cssPath = candidates.find((candidate) => existsSync(candidate));
  if (!cssPath) {
    throw new Error("Unable to find ui/src/styles/components.css");
  }
  return readFileSync(cssPath, "utf8");
}

describe("agent fallback chip styles", () => {
  it("styles the chip remove control inside the agent model input", () => {
    const css = readComponentsCss();

    expect(css).toContain(".agent-chip-input .chip {");
    expect(css).toContain(".agent-chip-input .chip-remove {");
    expect(css).toContain(".agent-chip-input .chip-remove:hover:not(:disabled)");
    expect(css).toContain(".agent-chip-input .chip-remove:focus-visible:not(:disabled)");
    expect(css).toContain("outline: 2px solid var(--accent);");
    expect(css).toContain("outline-offset: 2px;");
    expect(css).toContain(".agent-chip-input .chip-remove:disabled");
  });
});

describe("cron workspace form styles", () => {
  it("keeps the sticky form offset tied to the shell layout", () => {
    const css = readComponentsCss();
    const rule = css.match(/\.cron-workspace-form\s*\{(?<body>[^}]*)\}/)?.groups?.body;

    expect(rule).toBeDefined();
    expect(rule).toContain("position: sticky;");
    expect(rule).toContain("top: 0;");
    expect(rule).toContain("max-height: calc(100vh - var(--shell-topbar-height) - 32px);");
    expect(rule).not.toContain("top: 74px;");
    expect(css).not.toContain("max-height: calc(100vh - 74px - 32px);");
  });
});
