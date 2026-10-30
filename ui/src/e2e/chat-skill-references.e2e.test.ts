import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI skill references" });
const command = (name: string, skillDisplayName?: string) => ({
  acceptsArgs: Boolean(skillDisplayName),
  description: name,
  name,
  scope: "both",
  source: skillDisplayName ? "skill" : "native",
  ...(skillDisplayName ? { skillDisplayName, skillModelVisible: true } : {}),
});

suite.define(() => {
  it("references multiple skills inside a normal prompt and sends their raw names", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
      ? createControlUiE2eArtifactDir("chat-skill-references")
      : undefined;
    const viewport = { width: 1280, height: 900 };
    await suite.withPage(
      {
        viewport,
        ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
      },
      async ({ page }) => {
        const commands = [
          command("autoreview", "Auto Review"),
          command("technical_documentation", "Technical Documentation"),
          command("status_report", "Status Report"),
          command("status"),
        ];
        const gateway = await installMockGateway(page, {
          deferredMethods: ["chat.send"],
          methodResponses: {
            "chat.startup": {
              messages: [],
              metadata: { commands, models: [] },
              sessionId: "skill-reference-session",
              thinkingLevel: null,
            },
            "commands.list": { commands },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("sessions.messages.subscribe");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const draft = (value: string) => expect.poll(() => composer.inputValue()).toBe(value);
        const screenshot = async (name: string, target: Locator) => {
          if (artifactDir) {
            await writeFile(
              path.join(artifactDir, name),
              await takeControlUiViewportScreenshot(page, page.locator(".shell"), [target]),
            );
          }
        };
        await composer.fill("Review this with $auto");

        const picker = page.getByRole("listbox", { name: "Skill references" });
        await picker.waitFor({ state: "visible" });
        await expect
          .poll(() => picker.getByRole("option").allTextContents())
          .toEqual([expect.stringContaining("Auto Review")]);
        await screenshot("skill-reference-picker.png", picker);
        await composer.press("Enter");
        await draft("Review this with $autoreview ");

        await composer.fill(`${await composer.inputValue()}and $technical`);
        await expect.poll(() => picker.getByRole("option").count()).toBe(1);
        await composer.press("Tab");
        await draft("Review this with $autoreview and $technical_documentation ");
        await screenshot("skill-references-selected.png", composer);

        await page.getByRole("button", { name: "Send message" }).click();
        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({
          message: "Review this with $autoreview and $technical_documentation",
        });

        await composer.fill("Print $HOME");
        await expect.poll(() => picker.count()).toBe(0);
        await composer.fill("Review this with /auto");
        const slashPicker = page.getByRole("listbox", { name: "Slash commands" });
        await slashPicker.waitFor({ state: "visible" });
        await expect.poll(() => slashPicker.getByRole("option").count()).toBe(1);
        await composer.press("Enter");
        await draft("Review this with $autoreview ");

        await composer.fill("/");
        await slashPicker.waitFor({ state: "visible" });
        await expect.poll(() => page.getByRole("option", { name: /\/status/u }).count()).toBe(2);

        const slashOptions = slashPicker.getByRole("option");
        await composer.fill("/sta");
        await expect
          .poll(async () => {
            const names = await slashOptions.locator(".slash-menu-name").allTextContents();
            return { first: names[0], last: names.at(-1) };
          })
          .toEqual({ first: "/status", last: "/status_report" });
        await composer.press("Tab");
        await draft("/status");
      },
    );
  });
});
