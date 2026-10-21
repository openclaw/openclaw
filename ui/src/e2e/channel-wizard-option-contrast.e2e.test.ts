import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI channel wizard option contrast",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is required for channel wizard contrast proof at ${executablePath}`,
});

suite.define(() => {
  it("keeps option subtext legible and keyboard focus visible in forced colors", async () => {
    await suite.withPage(
      { colorScheme: "dark", ...createControlUiE2eContextOptions() },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["channels.status", "channels.pairing.list", "wizard.start"],
          methodResponses: {
            "channels.status": {
              ts: Date.now(),
              channelOrder: ["imessage"],
              channelLabels: { imessage: "iMessage" },
              channelMeta: [{ id: "imessage", label: "iMessage" }],
              channels: { imessage: { configured: true, running: true } },
              channelAccounts: {},
              channelDefaultAccountId: {},
            },
            "channels.pairing.list": {
              accounts: [],
              requests: [],
              commandOwnerConfigured: true,
              limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
            },
            "wizard.start": {
              sessionId: "channel-option-contrast-proof",
              done: false,
              status: "running",
              step: {
                id: "account",
                type: "select",
                message: "Account",
                initialValue: "primary",
                options: [
                  {
                    value: "primary",
                    label: "Primary iMessage connection",
                    hint: "The main iMessage connection for this OpenClaw gateway",
                  },
                  {
                    value: "another",
                    label: "Add another iMessage account",
                  },
                ],
              },
            },
          },
        });

        expect((await page.goto(`${suite.server.baseUrl}settings/channels`))?.status()).toBe(200);
        await page
          .locator("button.channels-item, button.channels-item__detail", { hasText: "iMessage" })
          .first()
          .click();
        await page.locator(".channels-detail").getByRole("button", { name: "Run setup" }).click();

        const wizard = page.locator(".channels-wizard");
        const picker = wizard.locator("openclaw-select-picker");
        await picker.locator(".picker-select__trigger").click();
        await expect
          .poll(() => picker.locator(".picker-select__trigger").getAttribute("aria-expanded"))
          .toBe("true");

        const activeOption = wizard.locator('[role="option"]').filter({
          has: page.getByText("Primary iMessage connection", { exact: true }),
        });
        await expect
          .poll(() => activeOption.evaluate((option) => option.hasAttribute("data-active")))
          .toBe(true);
        const colors = await activeOption.evaluate((option) => {
          const color = (selector: string) =>
            getComputedStyle(option.querySelector(selector)!).color;
          return {
            description: color(".picker-select__description"),
            label: color(".picker-select__label"),
          };
        });

        expect(colors.description).toBe(colors.label);

        await page.emulateMedia({ forcedColors: "active" });
        await page.keyboard.press("ArrowDown");
        const nextOption = picker.getByRole("option", { name: "Add another iMessage account" });
        const listbox = picker.getByRole("listbox");
        await expect
          .poll(async () => {
            const activeId = await listbox.getAttribute("aria-activedescendant");
            return (
              activeId === (await nextOption.getAttribute("id")) &&
              (await listbox.evaluate((list) => list.matches(":focus-visible")))
            );
          })
          .toBe(true);
        expect(
          await nextOption.evaluate((option) => {
            const style = getComputedStyle(option);
            return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
          }),
        ).toBe(true);
        expect(await activeOption.getAttribute("aria-selected")).toBe("true");
        await page.keyboard.press("Enter");
        const answer = await gateway.waitForRequest("wizard.next");
        expect(answer.params).toMatchObject({ answer: { value: "another" } });
      },
    );
  });
});
