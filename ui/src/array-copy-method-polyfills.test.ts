// Control UI tests cover browser polyfill installation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installArrayCopyMethodPolyfills } from "./array-copy-method-polyfills.js";

const originalToSorted = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
const originalToReversed = Object.getOwnPropertyDescriptor(Array.prototype, "toReversed");

function restoreArrayMethod(
  name: "toSorted" | "toReversed",
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    // oxlint-disable-next-line eslint/no-extend-native -- restores native descriptor after legacy-browser simulation.
    Object.defineProperty(Array.prototype, name, descriptor);
  } else {
    delete (Array.prototype as unknown as Record<string, unknown>)[name];
  }
}

function restoreArrayCopyMethods() {
  restoreArrayMethod("toSorted", originalToSorted);
  restoreArrayMethod("toReversed", originalToReversed);
}

function removeArrayMethod(name: "toSorted" | "toReversed") {
  // oxlint-disable-next-line eslint/no-extend-native -- simulates legacy browsers missing the method.
  Object.defineProperty(Array.prototype, name, {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

describe("array-copy-method-polyfills", () => {
  afterEach(() => {
    restoreArrayCopyMethods();
    vi.doUnmock("./ui/app.ts");
    vi.doUnmock("./styles.css");
    vi.doUnmock("./ui/public-assets.ts");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("installs non-mutating toSorted when the browser does not provide it", () => {
    removeArrayMethod("toSorted");

    installArrayCopyMethodPolyfills();

    const input = [3, 1, 2];
    expect(input.toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(input).toEqual([3, 1, 2]);
  });

  it("installs non-mutating toReversed when the browser does not provide it", () => {
    removeArrayMethod("toReversed");

    installArrayCopyMethodPolyfills();

    const input = [1, 2, 3];
    expect(input.toReversed()).toEqual([3, 2, 1]);
    expect(input).toEqual([1, 2, 3]);
  });

  it("keeps native methods when the browser already provides them", () => {
    const sentinel = function toSortedSentinel(this: number[]): number[] {
      return [99, ...this];
    };
    // oxlint-disable-next-line eslint/no-extend-native -- simulates a browser native implementation.
    Object.defineProperty(Array.prototype, "toSorted", {
      configurable: true,
      writable: true,
      value: sentinel,
    });

    installArrayCopyMethodPolyfills();

    expect([1, 2].toSorted()).toEqual([99, 1, 2]);
  });

  it("installs the fallbacks before the app module evaluates", async () => {
    removeArrayMethod("toSorted");
    removeArrayMethod("toReversed");
    vi.resetModules();
    vi.stubGlobal("OPENCLAW_CONTROL_UI_BUILD_ID", "test-build");
    vi.doMock("./styles.css", () => ({}));
    vi.doMock("./ui/public-assets.ts", () => ({
      inferControlUiPublicAssetPath: (asset: string) => asset,
    }));
    vi.doMock("./ui/app.ts", () => {
      expect(typeof Array.prototype.toSorted).toBe("function");
      expect(typeof Array.prototype.toReversed).toBe("function");
      return {};
    });

    await import("./main.ts");
  });
});
