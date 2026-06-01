import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";

function readWorkboardCss(): string {
  return readStyleSheet("ui/src/styles/workboard.css");
}

describe("workboard styles", () => {
  it("keeps status columns in one horizontally scrollable grid row", () => {
    const css = readWorkboardCss();

    expect(css).toContain(".workboard-board {\n  display: grid;\n  grid-auto-flow: column;");
    expect(css).toContain("grid-auto-columns: minmax(220px, 1fr);");
    expect(css).toContain("overflow-x: auto;");
    expect(css).toContain("grid-auto-columns: minmax(260px, 82vw);");
    expect(css).not.toContain("grid-template-columns: repeat(6");
  });

  it("keeps the mini game scene framed for a 3d canvas and fallback board", () => {
    const css = readWorkboardCss();

    expect(css).toContain(".workboard-game__scene {\n  position: relative;");
    expect(css).toContain("min-height: min(58vh, 430px);");
    expect(css).toContain(".workboard-game__canvas {\n  position: absolute;");
    expect(css).toContain("transform: perspective(720px) rotateX(58deg) rotateZ(-35deg);");
  });
});
