import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI leading slash command" });
const skill = (name: string, description: string) => ({
  acceptsArgs: true,
  description,
  name,
  scope: "both",
  source: "skill",
  skillDisplayName: name,
  skillReferenceable: true,
  skillModelVisible: true,
});
const commands = [
  skill("weather", "Check the weather."),
  skill(
    "event_loop_starvation_timeout_di",
    "Full-suite-only request timeouts or queued worker stalls.",
  ),
  skill(
    "paced_contributor_pr_loop",
    "Orchestrate an explicitly authorized paced contributor-PR loop.",
  ),
];
const prompt =
  "Apply the design notes: there should be vertical and horizontal rhythm, either left-right positioning or centering. Land many PRs starting with all the Control UI surfaces.";

async function openComposer(page: Page) {
  const gateway = await installMockGateway(page, {
    deferredMethods: ["chat.send"],
    methodResponses: {
      "chat.startup": {
        messages: [],
        metadata: { commands, models: [] },
        sessionId: "leading-command-session",
        thinkingLevel: null,
      },
      "commands.list": { commands },
    },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await gateway.waitForRequest("sessions.messages.subscribe");
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await composer.waitFor({ state: "visible" });
  await expect.poll(() => composer.isEnabled()).toBe(true);
  return { gateway, composer };
}

suite.define(() => {
  const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
    ? createControlUiE2eArtifactDir("chat-slash-leading-command")
    : undefined;
  const screenshot = async (page: Page, name: string, target: Locator) => {
    if (artifactDir) {
      await writeFile(
        path.join(artifactDir, name),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [target]),
      );
    }
  };

  it("completes a leading command typed in front of pasted prose", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, composer } = await openComposer(page);
      await composer.fill(prompt);
      // Home alone stops at the wrapped visual line; the command belongs at the draft start.
      await composer.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
      await composer.pressSequentially("/loo");

      const picker = page.locator(".slash-menu[role='listbox']");
      await picker.waitFor({ state: "visible" });
      const names = () => picker.getByRole("option").locator(".slash-menu-name").allTextContents();
      await expect.poll(names).toContainEqual(expect.stringContaining("paced_contributor_pr_loop"));
      await screenshot(page, "leading-command-menu.png", picker);
      await expect.poll(names).toContainEqual(expect.stringContaining("/loop"));

      await composer.press("Enter");
      await expect.poll(() => composer.inputValue()).toBe(`/loop ${prompt}`);
      await expect.poll(() => picker.count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await screenshot(page, "leading-command-completed.png", composer);

      // Completing inside a colon-terminated skill consumes the entire token.
      await composer.fill("Please use /wether:");
      await composer.press("Control+End");
      for (let index = 0; index < 5; index += 1) {
        await composer.press("ArrowLeft");
      }
      await composer.pressSequentially("a");
      await expect.poll(names).toEqual(["weather"]);
      await composer.press("Enter");
      await expect.poll(() => composer.inputValue()).toBe("Please use $weather ");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("opens Goal mode with the pasted prose as the objective", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, composer } = await openComposer(page);
      await composer.fill(prompt);
      // Home alone stops at the wrapped visual line; the command belongs at the draft start.
      await composer.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
      await composer.pressSequentially("/goa");
      const picker = page.locator(".slash-menu[role='listbox']");
      await expect
        .poll(() => picker.getByRole("option").locator(".slash-menu-name").allTextContents())
        .toContainEqual(expect.stringContaining("Goal"));
      await composer.press("Enter");

      const goalMode = page.locator(".agent-chat__goal-mode");
      await goalMode.waitFor({ state: "visible" });
      await expect.poll(() => composer.inputValue()).toBe(prompt);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await screenshot(page, "leading-goal-mode.png", goalMode);
    });
  });
});
