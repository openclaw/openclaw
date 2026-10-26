import { writeFile } from "node:fs/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { CyberAccessProgram } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Daybreak chat controls",
  startServer: () => startControlUiE2eServer(),
});

// Synthetic account-scoped catalog responses, not evidence of production entitlement.
const scenarios: { name: string; programs?: CyberAccessProgram[]; mobile?: boolean }[] = [
  { name: "unknown" },
  { name: "no-access", programs: [] },
  { name: "blue-only", programs: ["standard", "daybreak_blue"] },
  { name: "blue-only-mobile", programs: ["standard", "daybreak_blue"], mobile: true },
  { name: "both", programs: ["standard", "daybreak_blue", "daybreak_red"] },
  { name: "both-mobile", programs: ["standard", "daybreak_blue", "daybreak_red"], mobile: true },
];

suite.define(() => {
  it.each(scenarios)(
    "renders only account-entitled access: $name",
    async ({ name, programs, mobile }) => {
      const dir = createControlUiE2eArtifactDir("daybreak-" + name);
      await suite.withPage(
        {
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
          colorScheme: "dark",
        },
        async ({ page }) => {
          const model = {
            id: "gpt-6.1-sol",
            name: "GPT-6.1 Sol",
            provider: "openai",
            reasoning: true,
            available: true,
            supportsFastMode: true,
            serviceTiers: ["priority", "ultrafast"],
            ...(programs ? { availableAccessPrograms: { cyber: programs } } : {}),
          };
          const gateway = await installMockGateway(page, {
            agentModel: "openai/gpt-6.1-sol",
            models: [model],
            sessions: [
              {
                key: "agent:main:main",
                label: "Main",
                model: "gpt-6.1-sol",
                modelProvider: "openai",
                thinkingLevel: "medium",
                thinkingLevels: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                ],
              },
            ],
            historyMessages: [
              {
                role: "user",
                content: [{ type: "text", text: "Review the security test plan." }],
                timestamp: 1780000000000,
              },
              {
                role: "assistant",
                model: "gpt-6.1-sol",
                provider: "openai",
                responseAccessProgram: "daybreak_red",
                content: [
                  {
                    type: "text",
                    text: "I’ll review the plan and call out gaps before we run any tests.",
                  },
                ],
                timestamp: 1780000001000,
              },
            ],
          });
          await page.goto(suite.server.baseUrl + "chat");
          const composer = page.locator(".agent-chat__input");
          if (mobile) {
            await composer.locator("textarea").click();
          }
          const picker = composer.locator(".chat-controls__effort-picker");
          await expect
            .poll(() => picker.locator("summary").getAttribute("aria-disabled"))
            .toBe("false");
          await picker.locator("summary").click();
          const menu = picker.locator(".chat-controls__effort-menu");
          await expect.poll(() => menu.isVisible()).toBe(true);
          await expect
            .poll(() => menu.evaluate((element) => element.scrollHeight <= element.clientHeight))
            .toBe(true);
          expect(await menu.textContent()).toContain("Ultra");
          const select = picker.locator("[data-chat-access-program]");
          const entitled = programs?.some((program) => program !== "standard") === true;
          await expect.poll(() => select.count()).toBe(entitled ? 1 : 0);
          await expect.poll(() => menu.locator("p, [data-chat-access-reported]").count()).toBe(0);
          let options: string[] = [];
          if (entitled) {
            options = await select
              .locator("[data-chat-access-option]")
              .evaluateAll((elements) =>
                elements.map((element) => element.getAttribute("data-chat-access-option") ?? ""),
              );
            expect(options).toEqual(programs ?? []);
            expect(await select.locator("button:disabled").count()).toBe(0);
            expect(await menu.locator(".chat-controls__effort-heading").allTextContents()).toEqual([
              "Access",
              "Effort",
              "Speed",
            ]);
            const requested = programs?.includes("daybreak_red") ? "daybreak_red" : "daybreak_blue";
            await select.locator(`[data-chat-access-option="${requested}"]`).click();
            await expect
              .poll(async () =>
                (await gateway.getRequests("sessions.patch")).some(
                  (request) => asOptionalRecord(request.params)?.cyberAccessProgram === requested,
                ),
              )
              .toBe(true);
            await expect
              .poll(() =>
                select
                  .locator(`[data-chat-access-option="${requested}"]`)
                  .getAttribute("aria-checked"),
              )
              .toBe("true");
          } else {
            expect(await menu.locator(".chat-controls__effort-heading").allTextContents()).toEqual([
              "Effort",
              "Speed",
            ]);
          }
          const frame = await takeControlUiScreenshotFrame(page, menu, [], {
            animations: "disabled",
          });
          await writeFile(dir + "/after.png", frame.png);
          await writeFile(
            dir + "/proof.json",
            JSON.stringify(
              {
                scenario: name,
                capabilitySource: "synthetic account/model/runtime-scoped Gateway catalog fixture",
                productionEntitlementVerified: false,
                programs: programs ?? null,
                renderedOptions: options,
              },
              null,
              2,
            ),
          );
          if (name.startsWith("blue-only")) {
            await gateway.setMethodResponse("models.list", {
              models: [{ ...model, availableAccessPrograms: { cyber: ["standard"] } }],
            });
            await gateway.emitGatewayEvent("chat.metadata.changed", {
              agentId: "main",
              modelCatalogChanged: true,
            });
            await expect.poll(() => select.count()).toBe(0);
            expect((await gateway.getSessionRow("agent:main:main")).cyberAccessProgram).toBe(
              "daybreak_blue",
            );
            await picker.locator("summary").click();
            const modelPicker = composer.locator(".chat-controls__model-picker");
            await modelPicker.locator("summary").click();
            const modelMenu = modelPicker.locator(".chat-controls__model-menu");
            await expect.poll(() => modelMenu.isVisible()).toBe(true);
            const recovery = modelMenu.getByRole("button", { name: "Clear saved Access" });
            const staleFrame = await takeControlUiScreenshotFrame(page, modelMenu, [], {
              animations: "disabled",
            });
            await writeFile(dir + "/stale-selection.png", staleFrame.png);
            await expect.poll(() => recovery.count()).toBe(1);
            await recovery.click();
            await expect
              .poll(
                async () =>
                  asOptionalRecord((await gateway.getRequests("sessions.patch")).at(-1)?.params)
                    ?.cyberAccessProgram,
              )
              .toBeNull();
            await expect.poll(() => recovery.count()).toBe(0);
            await expect
              .poll(async () => (await gateway.getSessionRow("agent:main:main")).cyberAccessProgram)
              .toBeUndefined();
          } else if (entitled) {
            await picker.locator("[data-chat-access-default]").click();
            await expect
              .poll(
                async () =>
                  asOptionalRecord((await gateway.getRequests("sessions.patch")).at(-1)?.params)
                    ?.cyberAccessProgram,
              )
              .toBeNull();
            await expect.poll(() => select.locator('[aria-checked="true"]').count()).toBe(0);
          }
        },
      );
    },
  );
});
