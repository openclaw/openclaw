// @vitest-environment node
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";

it("advertises pending native commands even when the application modules have not loaded", async () => {
  const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  // JSDOM executes the real inline boot script but does not load module scripts.
  const page = new JSDOM(html, { url: "https://gateway.example/", runScripts: "dangerously" });
  try {
    await new Promise<void>((resolve) => {
      page.window.addEventListener("load", () => resolve(), { once: true });
    });
    expect(page.window.document.readyState).toBe("complete");
    expect(Reflect.get(page.window, "__OPENCLAW_NATIVE_COMMANDS_READY__")).toBe(false);
  } finally {
    page.window.close();
  }
});
