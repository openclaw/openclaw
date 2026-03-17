import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function collectExtensionSourceFiles(): string[] {
  const extensionsDir = resolve(ROOT_DIR, "..", "extensions");
  const sharedExtensionsDir = resolve(extensionsDir, "shared");
  const files: string[] = [];
  const stack = [extensionsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !/\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(entry.name)) {
        continue;
      }
      if (entry.name.endsWith(".d.ts") || fullPath.includes(sharedExtensionsDir)) {
        continue;
      }
      if (fullPath.includes(`${resolve(ROOT_DIR, "..", "extensions")}/shared/`)) {
        continue;
      }
      if (
        fullPath.includes(".test.") ||
        fullPath.includes(".fixture.") ||
        fullPath.includes(".snap")
      ) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

describe("channel import guardrails", () => {
  it("keeps bundled extension source files off root and compat plugin-sdk imports", () => {
    for (const file of collectExtensionSourceFiles()) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} should not import openclaw/plugin-sdk root`).not.toMatch(
        /["']openclaw\/plugin-sdk["']/,
      );
      expect(text, `${file} should not import openclaw/plugin-sdk/compat`).not.toMatch(
        /["']openclaw\/plugin-sdk\/compat["']/,
      );
    }
  });
});
