import { describe, expect, it } from "vitest";
import uiPackageConfig from "../ui/vitest.config.ts";
import { createScopedVitestConfig } from "./vitest/vitest.scoped-config.ts";
import { createUiIsolatedVitestConfig } from "./vitest/vitest.ui-isolated.config.ts";
import { createUiVitestConfig } from "./vitest/vitest.ui.config.ts";

const WEB_AWESOME = "@awesome.me/webawesome";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inlinePatterns(config: unknown): Array<string | RegExp> {
  if (!isRecord(config) || !isRecord(config.test) || !isRecord(config.test.server)) {
    return [];
  }
  const deps = config.test.server.deps;
  if (!isRecord(deps) || !Array.isArray(deps.inline)) {
    return [];
  }
  return deps.inline.filter(
    (entry): entry is string | RegExp => typeof entry === "string" || entry instanceof RegExp,
  );
}

describe("root UI Vitest Lit runtime", () => {
  it("inlines Web Awesome without dropping the shared Lit optimizer", () => {
    for (const config of [createUiVitestConfig(), createUiIsolatedVitestConfig()]) {
      const inline = inlinePatterns(config);
      expect(inline).toContain(WEB_AWESOME);
      expect(
        inline.some((pattern) => pattern instanceof RegExp && pattern.test("@codemirror/view")),
      ).toBe(true);
      expect(config.test?.deps?.optimizer?.client).toMatchObject({
        enabled: true,
        include: ["lit/**"],
      });
    }
  });

  it("does not inline Web Awesome for other runners", () => {
    const scoped = createScopedVitestConfig(["src/**/*.test.ts"], {
      env: {},
      name: "boundary",
    });
    expect(inlinePatterns(scoped)).not.toContain(WEB_AWESOME);

    const packageConfigs = [uiPackageConfig, ...(uiPackageConfig.test?.projects ?? [])];
    for (const config of packageConfigs) {
      expect(inlinePatterns(config)).not.toContain(WEB_AWESOME);
    }
  });
});
