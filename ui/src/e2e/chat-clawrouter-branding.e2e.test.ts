import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI ClawRouter model branding" });

suite.define(() => {
  it("shows who makes the model without changing the selected route or enlarging its icon", async () => {
    await suite.withPage(
      { viewport: { width: 1040, height: 750 }, deviceScaleFactor: 2 },
      async ({ page }) => {
        const sol = "clawrouter/openai/gpt-6.2-sol";
        const opus = "clawrouter/anthropic/claude-opus-5-5";
        const unknown = "clawrouter/example/example-chat";
        const direct = "openai/gpt-6-luna";
        const gateway = await installMockGateway(page, {
          agentModel: direct,
          historyMessages: [],
          models: [
            {
              id: "openai/gpt-6.2-sol",
              provider: "clawrouter",
              name: "GPT-6.2 Sol",
              family: "openai",
              recommended: true,
            },
            {
              id: "anthropic/claude-opus-5-5",
              provider: "clawrouter",
              name: "Opus 5.5",
              family: "anthropic",
              recommended: true,
            },
            {
              id: "example/example-chat",
              provider: "clawrouter",
              name: "Example Chat",
              recommended: true,
            },
            { id: "gpt-6-luna", provider: "openai", name: "GPT-6 Luna" },
          ],
          sessionInfo: {
            model: "openai/gpt-6.2-sol",
            modelProvider: "clawrouter",
            thinkingLevel: "high",
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__input").first();
        const picker = composer.locator(".chat-controls__model-picker");
        const trigger = picker.locator("[data-chat-model-select]");
        await expect.poll(() => trigger.textContent()).toContain("GPT-6.2 Sol");
        const triggerIcon = trigger.locator(".chat-controls__trigger-provider-icon");
        await triggerIcon.waitFor();
        expect(await trigger.getAttribute("aria-label")).toContain("via ClawRouter");
        await trigger.click();
        const search = picker.locator("[data-chat-model-search]");
        await search.fill("clawrouter");
        const solRow = await revealChatModelOption(picker, sol);
        const opusRow = await revealChatModelOption(picker, opus);
        const unknownRow = await revealChatModelOption(picker, unknown);
        const rowSlot = (row: Locator) => row.locator(".chat-controls__provider-icon");
        expect(
          await rowSlot(solRow)
            .locator("[data-provider-icon]")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-provider-icon"))),
        ).toEqual(["clawrouter", "codex"]);
        expect(
          await rowSlot(opusRow)
            .locator("[data-provider-icon]")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-provider-icon"))),
        ).toEqual(["clawrouter", "claude"]);
        expect(await rowSlot(unknownRow).getAttribute("data-provider-icon")).toBe("clawrouter");
        expect(await solRow.getAttribute("aria-label")).toContain("via ClawRouter");
        for (const icon of [triggerIcon, rowSlot(solRow), rowSlot(opusRow)]) {
          const size = (node: HTMLElement) => [node.offsetWidth, node.offsetHeight];
          expect(await icon.evaluate(size)).toEqual([16, 16]);
          expect(await icon.locator('[data-provider-icon="clawrouter"]').evaluate(size)).toEqual([
            16, 16,
          ]);
          expect(
            await icon
              .locator(".chat-controls__routed-brand-badge")
              .evaluate((node: HTMLElement) => [
                node.offsetLeft,
                node.offsetTop,
                node.offsetWidth,
                node.offsetHeight,
              ]),
          ).toEqual([8, 0, 8, 8]);
        }
        await opusRow.click();
        expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
          model: opus,
        });
        await expect.poll(() => trigger.textContent()).toContain("Opus 5.5");
        await trigger.click();
        const directRow = await revealChatModelOption(picker, direct);
        expect(await rowSlot(directRow).getAttribute("data-provider-icon")).toBe("codex");
      },
    );
  });
});
