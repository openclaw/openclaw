// Control UI E2E tests cover composable skill references in the chat composer.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI skill references" });
const skill = (name: string, skillDisplayName: string, description: string) => ({
  acceptsArgs: true,
  description,
  name,
  skillDisplayName,
  scope: "both",
  source: "skill",
  skillModelVisible: true,
  textAliases: [`/${name}`],
});

suite.define(() => {
  it("references multiple skills inside a normal prompt and sends their raw names", async () => {
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("chat-skill-references", artifactRoot)
      : undefined;
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        const commands = [
          skill("autoreview", "Auto Review", "Pre-commit and ship code review."),
          skill(
            "technical_documentation",
            "Technical Documentation",
            "Build and review technical documentation.",
          ),
          skill("status_report", "Status Report", "Prepare a detailed status report."),
          {
            acceptsArgs: false,
            description: "Show gateway status.",
            name: "status",
            scope: "both",
            source: "native",
            textAliases: ["/status"],
          },
        ];
        const gateway = await installMockGateway(page, {
          deferredMethods: ["chat.send"],
          methodResponses: {
            "chat.startup": {
              agentsList: {
                agents: [{ id: "main", name: "OpenClaw" }],
                defaultId: "main",
                mainKey: "main",
                scope: "agent",
              },
              messages: [],
              metadata: { commands, models: [] },
              sessionId: "skill-reference-session",
              thinkingLevel: null,
            },
            "commands.list": { commands },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
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
        await expect.poll(() => picker.getByRole("option").count()).toBe(1);
        await expect
          .poll(() => picker.getByRole("option").first().textContent())
          .toContain("Auto Review");
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
        expect((request.params as { message?: unknown }).message).toBe(
          "Review this with $autoreview and $technical_documentation",
        );

        await composer.fill("Print $HOME");
        await expect.poll(() => picker.count()).toBe(0);
        await composer.fill("Review this with /auto");
        const slashPicker = page.getByRole("listbox", { name: "Slash commands" });
        await slashPicker.waitFor({ state: "visible" });
        await expect.poll(() => slashPicker.getByRole("option").count()).toBe(1);
        await composer.press("Enter");
        await draft("Review this with $autoreview ");

        await composer.fill("/");
        await page.getByRole("listbox", { name: "Slash commands" }).waitFor({ state: "visible" });
        await expect.poll(() => page.getByRole("option", { name: /\/status/u }).count()).toBe(2);

        const slashOptions = page
          .getByRole("listbox", { name: "Slash commands" })
          .getByRole("option");
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
