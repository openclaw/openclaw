import { describe, expect, it } from "vitest";
import { resolveCompatModeForBundledMode } from "./activation-context.js";

describe("resolveCompatModeForBundledMode", () => {
  it("returns the provided compatMode when bundledMode is undefined", () => {
    const compatMode = {
      allowlist: true,
      enablement: "always" as const,
      vitest: true,
    };
    expect(resolveCompatModeForBundledMode({ bundledMode: undefined, compatMode })).toBe(
      compatMode,
    );
  });

  it("returns the provided compatMode when bundledMode is compat", () => {
    const compatMode = {
      allowlist: true,
      enablement: "always" as const,
      vitest: true,
    };
    expect(resolveCompatModeForBundledMode({ bundledMode: "compat", compatMode })).toBe(compatMode);
  });

  it("returns respect-allow compatMode when bundledMode is respect-allow", () => {
    const compatMode = {
      allowlist: true,
      enablement: "always" as const,
      vitest: true,
    };
    const result = resolveCompatModeForBundledMode({
      bundledMode: "respect-allow",
      compatMode,
    });
    expect(result).toEqual({
      allowlist: false,
      enablement: "allowlist",
      vitest: false,
    });
  });

  it("returns respect-allow compatMode regardless of input compatMode", () => {
    const result = resolveCompatModeForBundledMode({
      bundledMode: "respect-allow",
      compatMode: {
        allowlist: false,
        enablement: "allowlist",
        vitest: true,
      },
    });
    expect(result).toEqual({
      allowlist: false,
      enablement: "allowlist",
      vitest: false,
    });
  });

  it("always returns the same reference for respect-allow", () => {
    const result1 = resolveCompatModeForBundledMode({
      bundledMode: "respect-allow",
      compatMode: { allowlist: true, enablement: "always", vitest: true },
    });
    const result2 = resolveCompatModeForBundledMode({
      bundledMode: "respect-allow",
      compatMode: { allowlist: false, enablement: "allowlist", vitest: false },
    });
    expect(result1).toBe(result2);
  });
});
