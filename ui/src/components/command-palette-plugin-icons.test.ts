/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  enterQuery,
  findPaletteOption,
  mountPalette,
} from "./command-palette.test-support.ts";
import "./command-palette.ts";

describe("CommandPalette plugin icons", () => {
  let restoreDialogPolyfill: () => void;
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the proxied icon for a visible plugin search result", async () => {
    const fetchIcon = vi.fn(
      async () => new Response("icon", { headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchIcon);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:workboard");
        static override revokeObjectURL = vi.fn();
      },
    );
    const { gateway } = createGateway(true, {
      methods: ["plugins.list"],
      request: async (method) => {
        if (method === "plugins.list") {
          return {
            plugins: [{ id: "workboard", name: "Workboard", installed: true, hasIcon: true }],
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    });
    gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    const { palette } = await mountPalette(createContext(gateway, async () => null));
    await enterQuery(palette, "workboard");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    await vi.waitFor(() => {
      expect(findPaletteOption(palette, "Workboard")?.querySelector("img")?.src).toBe(
        "blob:workboard",
      );
    });
    expect(fetchIcon).toHaveBeenCalledWith(
      expect.stringContaining("/__openclaw__/plugin-icon/workboard"),
      expect.objectContaining({ method: "GET" }),
    );
  });
});
