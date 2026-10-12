import path from "node:path";
import stylelint from "stylelint";
import { describe, expect, it } from "vitest";

describe("Control UI TSX styles", () => {
  it.each([
    ["without CSS", "export const view = <section class='panel' />;"],
    [
      "with CSS",
      "import { css } from 'lit'; export const styles = css`.panel { display: block; }`; export const view = <section />;",
    ],
  ])("lints TSX %s through the configured parser", async (_name, code) => {
    const result = await stylelint.lint({
      code,
      codeFilename: path.resolve("ui/src/tsx-style-probe.tsx"),
      configFile: path.resolve("config/stylelint.config.mjs"),
    });
    expect(result.results.flatMap((entry) => entry.warnings)).toEqual([]);
    expect(result.errored).toBe(false);
  });

  it("still enforces CSS rules inside a TSX tagged template", async () => {
    const result = await stylelint.lint({
      code: "import { css } from 'lit'; export const styles = css`.panel { made-up-property: 1; }`; export const view = <section />;",
      codeFilename: path.resolve("ui/src/tsx-style-probe.tsx"),
      configFile: path.resolve("config/stylelint.config.mjs"),
    });
    expect(result.errored).toBe(true);
    expect(
      result.results.flatMap((entry) => entry.warnings.map((warning) => warning.rule)),
    ).toEqual(["property-no-unknown"]);
  });
});
