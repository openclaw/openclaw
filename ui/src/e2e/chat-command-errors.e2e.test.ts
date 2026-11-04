import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { chatFixture, composer, sendMessage } from "./chat-flow-fixtures.test-support.ts";
import { createChatFlowE2eSuite } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("explains a rejected command without losing a newer draft", async () => {
    const { page, gateway } = await chatFixture(suite, { deferredMethods: ["sessions.patch"] });
    await page.addInitScript(
      ({ key }) => {
        localStorage.setItem(key, JSON.stringify({ themeMode: "light", navCollapsed: true }));
      },
      { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
    );
    await page.goto(`${suite.server.baseUrl}chat`);
    await sendMessage(page, "/think high");
    await gateway.waitForRequest("sessions.patch");
    await composer(page).fill("Keep this draft while the command finishes.");
    await gateway.rejectDeferred("sessions.patch", {
      code: "UNAVAILABLE",
      message: "Example service unavailable",
    });
    const summary = page
      .getByRole("log", { name: "Chat" })
      .getByText("Couldn’t change effort. Try again.\n\nExample service unavailable", {
        exact: true,
      });
    await summary.waitFor();
    expect(await composer(page).inputValue()).toBe("Keep this draft while the command finishes.");
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const directory = createControlUiE2eArtifactDir("copy-c8-after");
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
      const frame = await takeControlUiScreenshotFrame(page, pane, [summary, composer(page)], {
        elements: [page.locator(".chat-queue")],
        animations: "disabled",
      });
      await writeFile(path.join(directory, "chat-command-error.png"), frame.elements[0]!.png);
    }
  });
});
