import { afterEach, describe, expect, it, vi } from "vitest";

// The module the loader receives from require, whichever path it tries.
const loaded = vi.hoisted(() => ({ binding: undefined as unknown, sourceCheckout: true }));
vi.mock("node:fs", () => ({ existsSync: () => loaded.sourceCheckout }));
vi.mock("node:module", () => ({
  createRequire: () => () => {
    if (!loaded.binding) {
      throw new Error(
        "Cannot find native binding. npm has a bug related to optional dependencies.",
      );
    }
    return loaded.binding;
  },
}));

const { loadIrohBinding } = await import("./addon.js");

// A binding whose Endpoint class has exactly these methods.
function bindingWith(endpointMethods: Record<string, () => unknown>) {
  return { bind: vi.fn(), Endpoint: { prototype: endpointMethods } };
}

describe("loadIrohBinding", () => {
  afterEach(() => {
    loaded.binding = undefined;
    loaded.sourceCheckout = true;
  });

  it("refuses a binding built without the home relay watcher", () => {
    loaded.binding = bindingWith({ online: () => undefined });
    expect(() => loadIrohBinding()).toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({
          message: expect.stringContaining("built without the home relay watcher"),
        }),
      }),
    );
  });

  it.each([true, false])("gives actionable guidance (source checkout: %s)", (sourceCheckout) => {
    loaded.sourceCheckout = sourceCheckout;
    expect(() => loadIrohBinding()).toThrow(
      sourceCheckout
        ? "OpenClaw ID is enabled, but the iroh binding is not built or could not be loaded. Run `pnpm build:iroh` from the source checkout."
        : "The OpenClaw ID transport is not available in this build.",
    );
  });

  it("loads a binding with the home relay watcher", () => {
    loaded.binding = bindingWith({ watchHomeRelay: () => undefined });
    expect(loadIrohBinding()).toBe(loaded.binding);
  });
});
