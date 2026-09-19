import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ComposerEditor } from "../components/composer-editor.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({ name: "composer skill chips" });
const commands = [
  { name: "score", skillDisplayName: "Score" },
  { name: "installed_skill_path_recovery", skillDisplayName: "Installed Skill Path Recovery" },
].map((skill) => ({
  name: skill.name,
  skillDisplayName: skill.skillDisplayName,
  description: `Use ${skill.skillDisplayName}.`,
  source: "skill",
  scope: "both",
  acceptsArgs: true,
  skillModelVisible: true,
  textAliases: [`/${skill.name}`],
}));
const models = [{ id: "demo-model", name: "Demo model", provider: "demo" }];

function installSkillsGateway(page: Page) {
  return installMockGateway(page, {
    models,
    agentModel: "demo/demo-model",
    methodResponses: {
      "chat.startup": {
        agentsList: {
          agents: [{ id: "main", name: "OpenClaw" }],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        metadata: { commands, models },
        messages: [],
        sessionId: "skill-chip-session",
        thinkingLevel: null,
      },
      "chat.metadata": { commands, models },
      "commands.list": { commands },
    },
  });
}

suite.define(() => {
  it.each([1280, 390])(
    "edits, restores, and sends skills as their original tokens at %ipx",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        const gateway = await installSkillsGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        const editor = page.locator(".agent-chat__composer-combobox > openclaw-composer-editor");
        const input = editor.locator(".cm-content");
        const value = () => editor.evaluate((element: ComposerEditor) => element.value);
        const chips = editor.locator(".composer-chip");
        const choose = async (query: string) => {
          await input.pressSequentially(query);
          await page
            .getByRole("listbox", { name: "Slash commands" })
            .getByRole("option")
            .first()
            .waitFor();
          await input.press("Enter");
        };
        await choose("/installed");
        await expect.poll(() => chips.count()).toBe(1);
        expect(await chips.first().getAttribute("aria-label")).toBe(
          "skill: Installed Skill Path Recovery",
        );
        expect(await value()).toBe("/installed_skill_path_recovery ");
        await input.press("Backspace");
        await input.press("Backspace");
        await expect.poll(value).toBe("");
        await input.press("ControlOrMeta+z");
        await expect.poll(() => chips.count()).toBe(1);
        await input.press("ControlOrMeta+a");
        await input.press("Backspace");
        await input.pressSequentially("Please use ");
        await choose("/installed");
        await input.pressSequentially("and ");
        await choose("/score");
        const raw = "Please use $installed_skill_path_recovery and $score ";
        await expect.poll(value).toBe(raw);
        await expect.poll(() => chips.count()).toBe(2);
        const geometry = await editor.evaluate((element) => ({
          width: element.getBoundingClientRect().width,
          scrollWidth: element.scrollWidth,
        }));
        expect(geometry.scrollWidth).toBeLessThanOrEqual(Math.ceil(geometry.width) + 1);

        // Copy uses the editor document, including the original command prefixes.
        await input.press("ControlOrMeta+a");
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await input.press("ControlOrMeta+c");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
        await input.press("ArrowRight");
        // A reload exercises the existing persisted draft owner.
        await waitForCommittedComposerDraft(
          page,
          "chat:v3:agent:main:main\u0000agent:main",
          raw,
          0,
        );
        await page.reload();
        await expect.poll(value).toBe(raw);
        await expect.poll(() => chips.count()).toBe(2);
        const updatedCommands = structuredClone(commands);
        for (const command of updatedCommands) {
          if (command.name === "score") {
            command.skillDisplayName = "Updated Score";
          }
        }
        await gateway.setMethodResponse("chat.metadata", { commands: updatedCommands, models });
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await expect
          .poll(() => chips.last().getAttribute("aria-label"))
          .toBe("skill: Updated Score");
        expect(await value()).toBe(raw);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({ message: raw.trim() });
        await expect.poll(value).toBe("");
      });
    },
  );
  it("preserves atomic chips and ordinary editing under macOS key bindings", async () => {
    await suite.withPage({}, async ({ page }) => {
      // Exercise the macOS keymap in Chromium; this does not claim real-device coverage.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
      });
      await installSkillsGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const editor = page.locator(".agent-chat__composer-combobox > openclaw-composer-editor");
      const input = editor.locator(".cm-content");
      const value = () => editor.evaluate((element: ComposerEditor) => element.value);
      await input.fill("/score ");
      await editor.locator(".composer-chip").waitFor();
      await editor.evaluate((element: ComposerEditor) => element.setSelectionRange(6, 6));
      await input.press("Control+t");
      expect(await value()).toBe("/score ");
      expect(await editor.locator(".composer-chip").count()).toBe(1);
      await input.fill("word");
      await editor.evaluate((element: ComposerEditor) => element.setSelectionRange(2, 2));
      await input.press("Control+t");
      await expect.poll(value).toBe("wrod");
      await input.fill("    text");
      await editor.evaluate((element: ComposerEditor) => element.setSelectionRange(4, 4));
      await input.press("Control+h");
      await expect.poll(value).toBe("   text");
      await input.fill("/score ");
      await editor.locator(".composer-chip").waitFor();
      await editor.evaluate((element: ComposerEditor) => element.setSelectionRange(6, 6));
      await input.press("Control+h");
      await expect.poll(value).toBe(" ");
      expect(await editor.locator(".composer-chip").count()).toBe(0);
      for (const [direction, key] of [
        ["ltr", "ArrowLeft"],
        ["rtl", "ArrowRight"],
      ] as const) {
        await editor.evaluate((element: ComposerEditor, dir) => {
          element.dir = dir;
        }, direction);
        await input.fill("  text");
        await editor.evaluate((element: ComposerEditor) => element.setSelectionRange(6, 6));
        await input.press(`Meta+${key}`);
        expect(await editor.evaluate((element: ComposerEditor) => element.selectionStart)).toBe(0);
        await editor.evaluate((element: ComposerEditor) => element.setSelectionRange(6, 6));
        await input.press(`Shift+Meta+${key}`);
        expect(
          await editor.evaluate((element: ComposerEditor) => [
            element.selectionStart,
            element.selectionEnd,
          ]),
        ).toEqual([0, 6]);
      }
      await editor.evaluate((element: ComposerEditor) => {
        element.dir = "ltr";
        element.style.cssText = "height:80px;min-height:80px;max-height:80px;overflow:auto";
      });
      const multiline = Array.from({ length: 40 }, (_, index) => `Row ${index}`).join("\n");
      await input.fill(multiline);
      await editor.evaluate((element: ComposerEditor) => element.setSelectionRange(0, 0));
      await input.press("Control+ArrowDown");
      const pageCaret = await editor.evaluate((element: ComposerEditor) => element.selectionStart);
      expect(pageCaret).toBeGreaterThan(0);
      expect(pageCaret).toBeLessThan(multiline.length / 2);
      await input.press("Control+ArrowUp");
      expect(await editor.evaluate((element: ComposerEditor) => element.selectionStart)).toBe(0);
      await input.press("Shift+Control+ArrowDown");
      expect(
        await editor.evaluate((element: ComposerEditor) => [
          element.selectionStart,
          element.selectionEnd,
        ]),
      ).toEqual([0, pageCaret]);
    });
  });
});
