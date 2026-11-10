import { afterEach, describe, expect, it, vi } from "vitest";

// The module the loader receives from require, whichever path it tries.
const loaded = vi.hoisted(() => ({ binding: undefined as unknown }));
vi.mock("node:module", () => ({ createRequire: () => () => loaded.binding }));

const { loadIrohBinding } = await import("./addon.js");

// A binding whose Endpoint class has exactly these methods.
function bindingWith(endpointMethods: Record<string, () => unknown>) {
  return { bind: vi.fn(), Endpoint: { prototype: endpointMethods } };
}

describe("loadIrohBinding", () => {
  afterEach(() => {
    loaded.binding = undefined;
  });

  it("refuses a binding built without the home relay watcher", () => {
    loaded.binding = bindingWith({ online: () => undefined });
    expect(() => loadIrohBinding()).toThrow(/built without the home relay watcher/);
  });

  it("loads a binding with the home relay watcher", () => {
    loaded.binding = bindingWith({ watchHomeRelay: () => undefined });
    expect(loadIrohBinding()).toBe(loaded.binding);
  });
});
