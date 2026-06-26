import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSnesStudioDomSmoke } from "../../scripts/dev/control-ui-snes-studio-dom-smoke.ts";

function writeDist(root: string, bundleText: string) {
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(root + "/index.html", "<!doctype html><main>OpenClaw Control</main>");
  writeFileSync(
    root + "/asset-manifest.json",
    JSON.stringify({
      "src/ui/views/snes-studio.ts": {
        file: "assets/snes-studio-test.js",
        name: "snes-studio",
        src: "src/ui/views/snes-studio.ts",
      },
    }),
  );
  writeFileSync(root + "/assets/snes-studio-test.js", bundleText);
}

describe("control-ui-snes-studio-dom-smoke", () => {
  it("passes as a non-browser DOM/static proof tier when the mastery card is present", () => {
    const distRoot = mkdtempSync(join(tmpdir(), "openclaw-snes-dom-dist-"));
    const artifactDir = mkdtempSync(join(tmpdir(), "openclaw-snes-dom-artifacts-"));
    writeDist(
      distRoot,
      "SNES Mastery; Next incomplete; Blocker:; Load SNES Mastery; other bundle code",
    );

    const result = runSnesStudioDomSmoke({
      artifactDir,
      distRoot,
      now: "2026-06-26T00:00:00.000Z",
    });

    expect(result.status).toBe("pass");
    expect(result.proofTier).toBe("dom-static");
    expect(result.productionBrowserEquivalent).toBe(false);
    expect(result.snesStudioBundle.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(existsSync(join(artifactDir, "receipt.json"))).toBe(true);
  });

  it("blocks when the built SNES Studio bundle is missing required proof text", () => {
    const distRoot = mkdtempSync(join(tmpdir(), "openclaw-snes-dom-dist-bad-"));
    const artifactDir = mkdtempSync(join(tmpdir(), "openclaw-snes-dom-artifacts-bad-"));
    writeDist(distRoot, "SNES Studio without the mastery card");

    const result = runSnesStudioDomSmoke({ artifactDir, distRoot });
    const receipt = JSON.parse(readFileSync(join(artifactDir, "receipt.json"), "utf8")) as {
      status: string;
      productionBrowserEquivalent: boolean;
    };

    expect(result.status).toBe("blocked");
    expect(result.blocker).toContain("SNES Mastery");
    expect(receipt.productionBrowserEquivalent).toBe(false);
  });
});
