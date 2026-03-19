import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("legacy root entry", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("routes the package root export to the pure library entry", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports?: Record<string, unknown>;
      main?: string;
    };

    expect(packageJson.main).toBe("dist/index.js");
    expect(packageJson.exports?.["."]).toBe("./dist/index.js");
  });

  it("does not run CLI bootstrap when imported as a library dependency", async () => {
    const mod = await import("./index.js");

    expect(typeof mod.applyTemplate).toBe("function");
    expect(typeof mod.runLegacyCliEntry).toBe("function");
  });
});
