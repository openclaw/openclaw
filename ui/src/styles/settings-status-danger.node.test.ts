// Source-level contract: failure alerts carry danger text; routine danger statuses keep the muted label.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const repoUiRoot = path.join(stylesDir, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoUiRoot, relativePath), "utf8");
}

describe("settings-status danger tone", () => {
  it("colors failure alert text from the shared danger token", () => {
    const css = read("styles/settings.css");
    expect(css).toMatch(
      /\.settings-status--danger\[role="alert"\]\s*\{\s*color:\s*var\(--danger\);/u,
    );
  });

  it("keeps theme catalog alerts on the canonical danger modifier", () => {
    const markup = read("pages/config/view-appearance.tsx");
    expect(markup).toContain('class="settings-status settings-status--danger"');
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain("settings-status--error");
  });
});
