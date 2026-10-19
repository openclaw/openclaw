/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  createContext,
  createGateway,
  enterQuery,
  findPaletteOption,
  mountPalette,
  paletteInput,
  registerCommandPaletteTestHooks,
  setInputValue,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";

describe("CommandPalette plugin icons", () => {
  registerCommandPaletteTestHooks();

  it("loads eligible visible icons and reloads retained rows without retrying failures", async () => {
    const fetchIcon = vi.fn(
      async () => new Response("icon", { headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchIcon);
    let iconRevision = 0;
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => `blob:workboard-${++iconRevision}`);
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    let hasIcon = true;
    const { gateway, emit } = createGateway(true, {
      methods: ["plugins.list"],
      request: async (method) => {
        if (method === "plugins.list") {
          return {
            plugins: [
              { id: "workboard", name: "Workboard", installed: true, hasIcon },
              { id: "other", name: "Other", installed: true, hasIcon: true },
            ],
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
        "blob:workboard-1",
      );
    });
    const icon = findPaletteOption(palette, "Workboard")?.querySelector(
      ".cmd-palette__plugin-icon",
    );
    expect(icon?.classList.contains("skeleton")).toBe(true);
    icon?.querySelector("img")?.dispatchEvent(new Event("load"));
    flush();
    expect(icon?.classList.contains("skeleton")).toBe(false);
    expect(fetchIcon).toHaveBeenCalledWith(
      expect.stringContaining("/__openclaw__/plugin-icon/workboard"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchIcon).toHaveBeenCalledTimes(1);
    const initialRow = findPaletteOption(palette, "Workboard");
    const input = paletteInput(palette);
    setInputValue(
      input,
      "Draft a detailed plan for the next release and include all testing steps.",
    );
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Workboard")).toBe(initialRow);
    expect(initialRow?.closest("[inert]")).not.toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:workboard-1");
    setInputValue(input, "workboard");
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => {
      expect(findPaletteOption(palette, "Workboard")?.querySelector("img")?.src).toBe(
        "blob:workboard-2",
      );
    });
    expect(fetchIcon).toHaveBeenCalledTimes(2);

    const row = findPaletteOption(palette, "Workboard");
    row?.querySelector("img")?.dispatchEvent(new Event("error"));
    flush();
    emit("cron");
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(row?.querySelector("img")).toBeNull();
    expect(fetchIcon).toHaveBeenCalledTimes(2);

    hasIcon = false;
    emit("cron");
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(row?.querySelector("img")).toBeNull();
    expect(fetchIcon).toHaveBeenCalledTimes(2);
    hasIcon = true;
    emit("cron");
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => {
      expect(findPaletteOption(palette, "Workboard")?.querySelector("img")?.src).toBe(
        "blob:workboard-3",
      );
    });
    expect(findPaletteOption(palette, "Workboard")).toBe(row);
    expect(fetchIcon).toHaveBeenCalledTimes(3);
  });
});
