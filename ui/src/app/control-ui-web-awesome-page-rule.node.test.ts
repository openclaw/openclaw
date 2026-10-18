// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import stylelint from "stylelint";
import { preprocessCSS, resolveConfig } from "vite";
import { describe, expect, it } from "vitest";
import { controlUiWebAwesomePageRulePlugin } from "../../config/control-ui-web-awesome-page-rule.ts";
import controlUiViteConfig from "../../vite.config.ts";

const require = createRequire(import.meta.url);
const { default: stylelintConfig } = require("../../../config/stylelint.config.mjs") as {
  default: stylelint.Config;
};
const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function hasPolicyWarnings(code: string) {
  const result = await stylelint.lint({
    code,
    config: {
      rules: {
        "selector-disallowed-list": stylelintConfig.rules!["selector-disallowed-list"],
      },
    },
  });
  return result.results.flatMap((entry) => entry.warnings.map((warning) => warning.text));
}

describe("Control UI Web Awesome page rule", () => {
  it("ships a global stylesheet whose vendor CSS passes the :has() app-ancestor policy", async () => {
    const vendorCss = readFileSync(
      require.resolve("@awesome.me/webawesome/dist/styles/themes/default.css"),
      "utf8",
    );
    expect(
      await hasPolicyWarnings(vendorCss),
      "The :has() guard must flag Web Awesome's page reset; if Web Awesome dropped it, delete the page rule plugin",
    ).toEqual([expect.stringContaining(":is(html, body):has(wa-page)")]);

    const config = await resolveConfig(
      { ...controlUiViteConfig(), configFile: false, root: uiRoot, logLevel: "silent" },
      "build",
    );
    const stylesPath = path.join(uiRoot, "src/styles.css");
    const { code } = await preprocessCSS(readFileSync(stylesPath, "utf8"), stylesPath, config);

    expect(code).toContain("--wa-color-surface-raised");
    expect(await hasPolicyWarnings(code)).toEqual([]);
  });

  it("removes only the exact vendor page reset", async () => {
    const kept = [
      "body:not(:has(wa-page)) { margin: 0 }",
      ":is(html, body):has(wa-page-nav) { margin: 0 }",
    ].join("\n");
    const css = `:is(html,\n  body):has(wa-page) { margin: 0 }\n${kept}`;

    const result = await postcss([controlUiWebAwesomePageRulePlugin()]).process(css, {
      from: undefined,
    });

    expect(result.css).toBe(kept);
  });
});
