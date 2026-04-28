import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("agent fallback chip styles", () => {
  it("styles the chip remove control inside the agent model input", () => {
    const css = readFileSync(path.join(process.cwd(), "ui/src/styles/components.css"), "utf8");

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
    const css = readFileSync(path.join(process.cwd(), "ui/src/styles/components.css"), "utf8");

    expect(css).toMatch(
      /\.cron-workspace-form\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*max-height:\s*calc\(100vh - var\(--shell-topbar-height\) - 32px\);/s,
    );
    expect(css).not.toContain("max-height: calc(100vh - 74px - 32px);");
  });
});
