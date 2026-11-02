import { describe, expect, it } from "vitest";
import { resolveWorkerCellExport } from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";

describe("worker cell owner exports", () => {
  it("resolves named or minified owner exports without substituting another symbol", () => {
    expect(resolveWorkerCellExport("export { loadSnapshot, other as a };", "loadSnapshot")).toBe(
      "loadSnapshot",
    );
    expect(
      resolveWorkerCellExport("export { loadSnapshot as c, close as r };", "loadSnapshot"),
    ).toBe("c");
    expect(
      resolveWorkerCellExport("export { other as loadSnapshot };", "loadSnapshot"),
    ).toBeUndefined();
    expect(
      resolveWorkerCellExport("export { loadSnapshot } from './different.mjs';", "loadSnapshot"),
    ).toBeUndefined();
    expect(() =>
      resolveWorkerCellExport("export { loadSnapshot as a, loadSnapshot as b };", "loadSnapshot"),
    ).toThrow("Ambiguous");
  });
});
