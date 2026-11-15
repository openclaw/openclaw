import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  foregroundKey,
  foregroundDraft,
  scenario,
  openFromForeground,
  expectForegroundUnchanged,
} from "./command-palette.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette mode and submit" });

suite.define(() => {
  it("remembers explicit mode choices across reloads without saving automatic switches", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, scenario());
      const { palette, input } = await openFromForeground(page, suite.server.baseUrl);
      const selected = (name: string) =>
        palette.getByRole("tab", { name, exact: true }).getAttribute("aria-selected");
      await input.press("Tab");
      await expect.poll(() => selected("Compose")).toBe("true");
      await input.press("Escape");
      await page.reload();
      await page.locator(".agent-chat__composer-combobox textarea:visible").waitFor();
      const held = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/components/command-palette.tsx"),
      );
      try {
        await page.keyboard.press("ControlOrMeta+K");
        await held.request;
        const cold = page.locator(".cmd-palette-stack");
        await expect
          .poll(() =>
            cold.getByRole("tab", { name: "Compose", exact: true }).getAttribute("aria-selected"),
          )
          .toBe("true");
        held.release();
        await input.waitFor({ state: "visible" });
        await expect.poll(() => selected("Compose")).toBe("true");
        await palette.getByRole("tab", { name: "Search", exact: true }).click();
        await input.fill(
          "A long prompt that automatically moves into Compose without changing the chosen Search preference.",
        );
        await expect.poll(() => selected("Compose")).toBe("true");
        await page.reload();
        await page.locator(".agent-chat__composer-combobox textarea:visible").waitFor();
        await page.keyboard.press("ControlOrMeta+K");
        await input.waitFor({ state: "visible" });
        await expect.poll(() => selected("Search")).toBe("true");
      } finally {
        held.release();
      }
    });
  });

  it.each([
    { platform: "MacIntel", modifier: "Meta", cold: false },
    { platform: "Linux x86_64", modifier: "Control", cold: true },
  ])(
    "starts a background session from Search on $platform (cold: $cold)",
    async ({ platform, modifier, cold }) => {
      await suite.withPage({}, async ({ page }) => {
        await page.addInitScript(
          (value) => Object.defineProperty(navigator, "platform", { get: () => value }),
          platform,
        );
        const key = "agent:main:dashboard:search-shortcut-created";
        const gateway = await installMockGateway(
          page,
          scenario({ "sessions.create": { key, runStarted: true } }),
        );
        const held = cold
          ? await holdModuleResponse(
              page,
              controlUiE2eBuiltModuleRequest("ui/src/components/command-palette.tsx"),
            )
          : undefined;
        try {
          // Keep the same foreground draft/focus contract for the cold launcher too.
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, foregroundKey));
          const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
          await composer.fill(foregroundDraft);
          await composer.evaluate((element: HTMLTextAreaElement) =>
            element.setSelectionRange(10, 10),
          );
          const url = page.url();
          await page.keyboard.press(modifier + "+K");
          const input = page.locator(".cmd-palette__input");
          await input.waitFor({ state: "visible" });
          if (held) {
            await held.request;
          } else {
            await page.locator("openclaw-command-palette .cmd-palette__input").waitFor();
          }
          const prompt = "Summarize this";
          await input.fill(prompt);
          await expect
            .poll(() =>
              page.getByRole("tab", { name: "Search", exact: true }).getAttribute("aria-selected"),
            )
            .toBe("true");
          // IME is not submission, even with the primary modifier.
          await input.dispatchEvent("keydown", {
            key: "Enter",
            code: "Enter",
            [modifier === "Meta" ? "metaKey" : "ctrlKey"]: true,
            isComposing: true,
          });
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          await gateway.deferNext("sessions.create");
          await input.press(modifier + "+Enter");
          held?.release();
          const create = await gateway.waitForRequest("sessions.create");
          expect(create.params).toMatchObject({ message: prompt });
          await input.waitFor({ state: "hidden" });
          await expectForegroundUnchanged(page, composer, url);
          await page.keyboard.press(modifier + "+K");
          await input.waitFor({ state: "visible" });
          await expect
            .poll(() =>
              page.getByRole("tab", { name: "Search", exact: true }).getAttribute("aria-selected"),
            )
            .toBe("true");
          expect(await input.inputValue()).toBe("");
          await input.press(modifier + "+Enter");
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
          await gateway.resolveDeferred("sessions.create");
        } finally {
          held?.release();
        }
      });
    },
  );
});
