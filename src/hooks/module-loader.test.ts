import { describe, expect, it } from "vitest";
import { resolveFunctionModuleExport } from "./module-loader.js";

describe("hooks module loader helpers", () => {
  it("falls back through named exports when no explicit export is provided", () => {
    const fallback = () => "ok";
    const resolved = resolveFunctionModuleExport({
      mod: { transform: fallback },
      fallbackExportNames: ["default", "transform"],
    });
    expect(resolved).toBe(fallback);
  });
});
