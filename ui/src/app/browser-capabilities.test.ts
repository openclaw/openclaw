// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectControlUiBrowserCapabilities } from "./browser-capabilities.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Control UI browser capability admission", () => {
  it.each(["supported", "css", "anchor", "popover", "invoker", "field-sizing"])(
    "reports required overlays and optional sizing (%s)",
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
      expect(detectControlUiBrowserCapabilities()).toEqual({
        supported: missing === "supported" || missing === "field-sizing",
        fieldSizing: missing !== "css" && missing !== "field-sizing",
      });
    },
  );

  it("rejects a non-browser environment without throwing", () => {
    expect(detectControlUiBrowserCapabilities()).toEqual({ supported: false, fieldSizing: false });
  });
});
