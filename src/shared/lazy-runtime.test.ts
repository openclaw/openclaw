import { describe, expect, it, vi } from "vitest";
import { createLazyRuntimeModule, createLazyRuntimeSurface } from "./lazy-runtime.js";

describe("lazy runtime helpers", () => {
  it("caches imported modules", async () => {
    const importer = vi.fn(async () => ({ value: "module" }));
    const load = createLazyRuntimeModule(importer);

    await expect(Promise.all([load(), load()])).resolves.toEqual([
      { value: "module" },
      { value: "module" },
    ]);
    expect(importer).toHaveBeenCalledOnce();
  });

  it("preserves cached runtime import rejections", async () => {
    const importer = vi.fn(async () => {
      throw new Error("sticky");
    });
    const load = createLazyRuntimeSurface(importer, (module) => module);

    await expect(load()).rejects.toThrow("sticky");
    await expect(load()).rejects.toThrow("sticky");
    expect(importer).toHaveBeenCalledOnce();
  });
});
