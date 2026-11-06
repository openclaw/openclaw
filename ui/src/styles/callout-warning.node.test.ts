// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const readStyle = (name: string) => fs.readFileSync(path.join(stylesDir, name), "utf8");

function cssRules(css: string): Rule[] {
  const rules: Rule[] = [];
  postcss.parse(css).walkRules((rule) => {
    rules.push(rule);
  });
  return rules;
}

const declarations = (rule: Rule) =>
  new Map(rule.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]));

describe("shared callout warning style", () => {
  // Pages outside the lazy usage/model-providers routes never load usage.css,
  // so `.callout.warning` must take the amber treatment from the shared sheet.
  it("gives .callout.warning the same amber treatment as .callout.warn", () => {
    const rules = cssRules(readStyle("components.css"));
    const gradient = rules.find(
      (rule) =>
        rule.selectors.includes(".callout.warn") &&
        (declarations(rule).get("background") ?? "").startsWith("linear-gradient"),
    );
    expect(gradient?.selectors, "gradient rule").toContain(".callout.warning");

    const tone = rules.find(
      (rule) =>
        rule.selectors.includes(".callout.warn") && declarations(rule).has("--callout-tone"),
    );
    expect(tone?.selectors, "tone rule").toContain(".callout.warning");
    expect(declarations(tone!).get("--callout-tone"), "warn tone").toBe("var(--warn)");
  });
});
