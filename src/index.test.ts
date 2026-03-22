import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { applyTemplate, runLegacyCliEntry } from "./index.js";

describe("legacy root entry", () => {
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

  it("does not run CLI bootstrap when imported as a library dependency", () => {
    expect(typeof applyTemplate).toBe("function");
    expect(typeof runLegacyCliEntry).toBe("function");
  });
});
