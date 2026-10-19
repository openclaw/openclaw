import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";

export function sessionsList(placement: "local" | "active") {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        key: "main",
        kind: "direct",
        label: "Main",
        placement: {
          state: placement,
          ...(placement === "active" ? { environmentId: "worker-desktop-1" } : {}),
        },
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

export async function openPalette(page: import("playwright").Page) {
  await waitForControlUiGatewayReady(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("openclaw:command-palette-open"));
  });
  await page
    .locator("openclaw-command-palette")
    .getByRole("textbox", { name: "Search or start a task…" })
    .waitFor();
}

export async function openDesktopPanel(page: import("playwright").Page, baseUrl: string) {
  await page.goto(`${baseUrl}activity`);
  await openPalette(page);
  await page.getByRole("option", { name: "Desktop", exact: true }).click();
  const panel = page.locator("openclaw-desktop-panel");
  await panel.locator("section[aria-label='Desktop']").waitFor();
  return panel;
}
