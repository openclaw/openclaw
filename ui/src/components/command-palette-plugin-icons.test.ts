/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { expect, it, vi } from "vitest";
import {
  findPaletteOption,
  mountSearch,
  paletteInput,
  pressKey,
  registerCommandPaletteTestHooks,
  searchPalette,
  setInputValue,
  settlePalette,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";

registerCommandPaletteTestHooks();

it("loads eligible visible icons and reloads retained rows without retrying failures", async () => {
  const fetchIcon = vi.fn(
    async () => new Response("icon", { headers: { "content-type": "image/png" } }),
  );
  vi.stubGlobal("fetch", fetchIcon);
  let iconRevision = 0;
  const revokeObjectURL = vi.fn();
  class IconURL extends URL {
    static override createObjectURL = vi.fn(() => `blob:workboard-${++iconRevision}`);
    static override revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal("URL", IconURL);
  let hasIcon = true;
  const { gateway, emit, palette } = await mountSearch({
    methods: ["plugins.list"],
    request: async (method) =>
      method === "plugins.list"
        ? {
            plugins: [
              { id: "workboard", name: "Workboard", installed: true, hasIcon },
              { id: "other", name: "Other", installed: true, hasIcon: true },
            ],
          }
        : Promise.reject(new Error(`Unexpected method: ${method}`)),
  });
  gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
  const workboard = () => findPaletteOption(palette, "Workboard");
  const waitForIcon = (revision: number) =>
    vi.waitFor(() => {
      expect(workboard()?.querySelector("img")?.src).toBe(`blob:workboard-${revision}`);
      expect(fetchIcon).toHaveBeenCalledTimes(revision);
    });
  await searchPalette(palette, "workboard");
  await waitForIcon(1);
  const icon = workboard()?.querySelector(".cmd-palette__plugin-icon");
  expect(icon?.classList.contains("skeleton")).toBe(true);
  icon?.querySelector("img")?.dispatchEvent(new Event("load"));
  flush();
  expect(icon?.classList.contains("skeleton")).toBe(false);
  expect(fetchIcon).toHaveBeenCalledWith(
    expect.stringContaining("/__openclaw__/plugin-icon/workboard"),
    expect.objectContaining({ method: "GET" }),
  );
  const initialRow = workboard();
  const input = paletteInput(palette);
  pressKey(input, "Tab", { cancelable: true });
  setInputValue(input, "Draft a plan for the next release including all testing steps.");
  await palette.updateComplete;
  expect(workboard()).toBe(initialRow);
  expect(initialRow?.closest("[inert]")).not.toBeNull();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:workboard-1");
  setInputValue(input, "workboard");
  pressKey(input, "Tab", { cancelable: true });
  await vi.advanceTimersByTimeAsync(200);
  await waitForIcon(2);

  const row = workboard();
  row?.querySelector("img")?.dispatchEvent(new Event("error"));
  flush();
  for (const available of [true, false]) {
    hasIcon = available;
    emit("cron");
    await settlePalette(palette, 0);
    expect(row?.querySelector("img")).toBeNull();
    expect(fetchIcon).toHaveBeenCalledTimes(2);
  }
  hasIcon = true;
  emit("cron");
  await vi.advanceTimersByTimeAsync(0);
  await waitForIcon(3);
  expect(workboard()).toBe(row);
});
