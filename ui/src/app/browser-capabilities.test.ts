// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { isControlUiBrowserSupported } from "./browser-capabilities.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Control UI browser capability admission", () => {
  it.each(["supported", "css", "anchor", "popover", "invoker", "field-sizing"])(
    "requires overlays but accepts unused invokers and optional sizing (%s)",
    (missing) => {
      vi.stubGlobal(
        "CSS",
        missing === "css"
          ? undefined
          : {
              supports: (feature: string) =>
                feature === "anchor-name: --a"
                  ? missing !== "anchor"
                  : feature === "field-sizing: content" && missing !== "field-sizing",
            },
      );
      vi.stubGlobal("HTMLElement", {
        prototype: { showPopover: missing === "popover" ? undefined : () => {} },
      });
      vi.stubGlobal("HTMLButtonElement", {
        prototype: missing === "invoker" ? {} : { commandForElement: null },
      });
      expect(isControlUiBrowserSupported()).toBe(
        missing === "supported" || missing === "invoker" || missing === "field-sizing",
      );
    },
  );

  it("rejects a non-browser environment without throwing", () => {
    expect(isControlUiBrowserSupported()).toBe(false);
  });
});
