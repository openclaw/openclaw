/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

async function createApp() {
  await import("./app.ts");
  return document.createElement("openclaw-app") as unknown as {
    globalKeydownHandler: (event: KeyboardEvent) => void;
    navDrawerOpen: boolean;
  };
}

describe("OpenClawApp mobile nav drawer keyboard handling", () => {
  it("closes the nav drawer on Escape", async () => {
    const app = await createApp();
    app.navDrawerOpen = true;

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    app.globalKeydownHandler(event);

    expect(event.defaultPrevented).toBe(true);
    expect(app.navDrawerOpen).toBe(false);
  });
});
