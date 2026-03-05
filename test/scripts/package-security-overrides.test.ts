import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("package security override floors", () => {
  it("keeps tar/hono pinned at or above patched versions", () => {
    const packageJsonPath = path.resolve(import.meta.dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      pnpm?: { overrides?: Record<string, string> };
    };

    expect(pkg.dependencies?.hono).toBe("4.12.5");
    expect(pkg.dependencies?.tar).toBe("7.5.10");
    expect(pkg.pnpm?.overrides?.hono).toBe("4.12.5");
    expect(pkg.pnpm?.overrides?.tar).toBe("7.5.10");
  });
});
