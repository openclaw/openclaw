import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveRepoRoot } from "../../scripts/lib/repo-root.mjs";

describe("resolveRepoRoot", () => {
  // Both depths regressed when the resolver unconditionally traversed two parents.
  it.each([
    "scripts/check-no-raw-channel-fetch.mts",
    "extensions/telegram/src/utils/hypothetical.mjs",
  ])("resolves the checkout from %s", (filePath) => {
    expect(resolveRepoRoot(pathToFileURL(path.resolve(filePath)).href)).toBe(path.resolve());
  });

  it("resolves an unpacked workspace without git metadata", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-repo-root-"));
    try {
      mkdirSync(path.join(root, "scripts", "nested"), { recursive: true });
      writeFileSync(path.join(root, "package.json"), '{"name":"openclaw"}\n');
      writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");

      expect(
        resolveRepoRoot(pathToFileURL(path.join(root, "scripts", "nested", "tool.mjs")).href),
      ).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
