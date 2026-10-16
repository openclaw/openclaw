import { describe, expect, it } from "vitest";
import { resolveFunctionModuleExport } from "./module-loader.js";

describe("hooks module loader helpers", () => {
  it("resolves explicit function exports", () => {
    const fn = () => "ok";
    const resolved = resolveFunctionModuleExport({
      mod: { run: fn },
      exportName: "run",
    });
    expect(resolved).toBe(fn);
  });

  it("falls back through named exports when no explicit export is provided", () => {
    const fallback = () => "ok";
    const resolved = resolveFunctionModuleExport({
      mod: { transform: fallback },
      fallbackExportNames: ["default", "transform"],
    });
    expect(resolved).toBe(fallback);
  });

  it("returns undefined when export exists but is not callable", () => {
    const resolved = resolveFunctionModuleExport({
      mod: { run: "nope" },
      exportName: "run",
    });
    expect(resolved).toBeUndefined();
  });
});
