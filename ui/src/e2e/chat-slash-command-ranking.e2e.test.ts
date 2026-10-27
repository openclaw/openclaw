import { text } from "node:stream/consumers";
import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import type { CommandEntry } from "../../../packages/gateway-protocol/src/index.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import { polledAttribute, polledText } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { setupPages } from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI slash command ranking",
});
const withPage = setupPages(suite, () => ({ viewport: { width: 1280, height: 900 } }));

function makeCommand(
  name: string,
  description: string,
  category: CommandEntry["category"],
  args?: CommandEntry["args"],
): CommandEntry {
  return {
    name,
    description,
    category,
    acceptsArgs: true,
    scope: "both",
    source: "plugin",
    textAliases: [`/${name}`],
    ...(args ? { args } : {}),
  };
}

async function installCommands(
  page: Page,
  commands: CommandEntry[],
  sessionId: string,
  metadata = false,
) {
  return installMockGateway(page, {
    methodResponses: {
      "chat.startup": {
        agentsList: agentRoster({ main: "OpenClaw" }, "main", "agent"),
        messages: [],
        metadata: { commands, models: [] },
        sessionId,
        thinkingLevel: null,
      },
      ...(metadata ? { "chat.metadata": { commands, models: [] } } : {}),
      "commands.list": { commands },
    },
  });
}

async function openChat(page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  await page.goto(`${suite.server.baseUrl}chat`);
  await gateway.waitForRequest("sessions.messages.subscribe");
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await composer.waitFor({ state: "visible" });
  return composer;
}

suite.define(() => {
  it.each(["/export-session", "/export"])(
    "shows an empty export result and retains staged attachments for %s",
    async (command) => {
      await withPage(async ({ page }) => {
        const gateway = await installMockGateway(page, { historyMessages: [] });
        const downloads: string[] = [];
        page.on("download", (download) => downloads.push(download.suggestedFilename()));

        const composer = await openChat(page, gateway);
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "export-proof.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("keep this staged"),
        });
        const attachment = page.locator(".chat-attachment-file__name", {
          hasText: "export-proof.txt",
        });
        await attachment.waitFor({ state: "visible" });

        await composer.fill(command);
        await page.getByRole("button", { name: "Send message" }).click();

        await page
          .locator(".chat-thread-inner")
          .getByText("There are no messages to export yet.", { exact: true })
          .waitFor({ state: "visible" });
        await expect.poll(() => composer.inputValue()).toBe("");
        expect(await attachment.isVisible()).toBe(true);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(downloads).toEqual([]);
      });
    },
  );

  it.each(["/export", "/export-session"])(
    "downloads the complete conversation without scrolling for %s",
    async (command) => {
      await withPage(async ({ page }) => {
        const messages = Array.from({ length: 160 }, (_, index) => ({
          __openclaw: { seq: index + 1 },
          role: index % 2 ? "assistant" : "user",
          content: `Export marker ${index + 1} ${"Synthetic detail. ".repeat(15)}`,
        }));
        const history = (rows: unknown[], hasMore: boolean, nextOffset?: number) => ({
          messages: rows,
          hasMore,
          nextOffset,
          totalMessages: messages.length,
          sessionId: "export-pagination",
          deltaCursor: "stable-export-cursor",
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "chat.startup": history(messages.slice(80), true, 80),
            "chat.history": {
              cases: [
                { match: { offset: 0, limit: 1 }, response: history(messages.slice(-1), true, 1) },
                { match: { offset: 0 }, response: history(messages.slice(80), true, 80) },
                { match: { offset: 80 }, response: history(messages.slice(0, 80), false) },
              ],
            },
          },
        });
        const composer = await openChat(page, gateway);
        await page
          .locator(".chat-thread-inner")
          .getByText("Export marker 160", { exact: false })
          .waitFor();
        const firstMessage = messages[0];
        assert(firstMessage, "paginated export fixture needs an earliest message");
        expect(await page.getByText(firstMessage.content, { exact: true }).count()).toBe(0);
        expect(await gateway.getRequests("chat.history")).toHaveLength(0);

        await composer.fill(command);
        const pending = page.waitForEvent("download");
        await page.getByRole("button", { name: "Send message" }).click();
        const download = await pending;
        expect(download.suggestedFilename()).toMatch(/^chat-OpenClaw-.+\.md$/);
        const stream = await download.createReadStream();
        assert(stream, "chat export did not provide a readable download");
        const markdown = await text(stream);
        expect(markdown.match(/Export marker \d+ /g)).toHaveLength(160);
        let previous = -1;
        for (let index = 1; index <= 160; index += 1) {
          const position = markdown.indexOf(`Export marker ${index} `);
          expect(position).toBeGreaterThan(previous);
          previous = position;
        }
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );

  it.each(["Enter", "Tab", "pointer"])(
    "shows the first argument after selecting from a scrolled command menu with %s",
    async (selection) => {
      await withPage(async ({ page }) => {
        const choices = Array.from(
          { length: 16 },
          (_, index) => `choice-${String(index).padStart(2, "0")}`,
        );
        const description = "Choose a synthetic viewport option.";
        const commands = Array.from({ length: 16 }, (_, index) =>
          makeCommand(`viewport-${String(index).padStart(2, "0")}`, description, "tools", [
            {
              name: "choice",
              description,
              type: "string",
              choices: choices.map((value) => ({ value, label: value })),
            },
          ]),
        );
        const gateway = await installCommands(page, commands, "slash-viewport-session", true);
        const composer = await openChat(page, gateway);
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await composer.fill("/viewport-");

        const picker = page.locator(".slash-menu[role='listbox']");
        const scroll = picker.locator(".slash-menu__scroll");
        const options = picker.getByRole("option");
        await expect.poll(() => options.count()).toBeGreaterThanOrEqual(commands.length);
        const names = options.locator(".slash-menu-name");
        const targetIndex = await names.evaluateAll((nodes) =>
          nodes.findIndex((node) => node.textContent?.trim().startsWith("/viewport-15")),
        );
        expect(targetIndex).toBeGreaterThan(10);
        for (let index = 0; index < targetIndex; index += 1) {
          await composer.press("ArrowDown");
        }
        await polledAttribute(options.nth(targetIndex), "aria-selected").toBe("true");
        await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        if (selection === "pointer") {
          await options.nth(targetIndex).click();
          await page.mouse.move(0, 0);
        } else {
          await composer.press(selection);
        }

        await expect.poll(() => composer.inputValue()).toBe("/viewport-15 ");
        const active = picker.locator("[role='option'][aria-selected='true']");
        const first = options.first();
        await polledText(first.locator(".slash-menu-name")).toBe("choice-00");
        // Pointer selection may activate the option under the cursor after the viewport changes.
        if (selection !== "pointer") {
          await polledText(active.locator(".slash-menu-name")).toBe("choice-00");
        }
        expect(
          await scroll.evaluate((element) => element.scrollHeight > element.clientHeight),
        ).toBe(true);
        await expect
          .poll(() =>
            first.evaluate((element) => {
              const viewport = element.closest(".slash-menu__scroll")?.getBoundingClientRect();
              const option = element.getBoundingClientRect();
              return Boolean(
                viewport && option.top >= viewport.top && option.bottom <= viewport.bottom,
              );
            }),
          )
          .toBe(true);

        const activeIndex = choices.indexOf(
          (await active.locator(".slash-menu-name").textContent())?.trim() ?? "",
        );
        expect(activeIndex).toBeGreaterThanOrEqual(0);
        for (let index = activeIndex; index < choices.length - 1; index += 1) {
          await composer.press("ArrowDown");
        }
        await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await composer.fill("/viewport-");
        await polledText(active.locator(".slash-menu-name")).toContain("/viewport-00");
        await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );

  it("keeps visible search results and keyboard selection in relevance order", async () => {
    await withPage(async ({ page }) => {
      const commands = [
        makeCommand("pair", "Generate setup codes.", "tools"),
        makeCommand("pair-device", "Pair a specific device.", "session"),
      ];
      const gateway = await installCommands(page, commands, "slash-command-ranking-session");
      const composer = await openChat(page, gateway);
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await composer.fill("/pair");

      const picker = page.locator(".slash-menu[role='listbox']");
      await picker.waitFor({ state: "visible" });
      const options = picker.getByRole("option");
      const names = options.locator(".slash-menu-name");
      await expect
        .poll(() =>
          names.evaluateAll((nodes) => nodes.slice(0, 3).map((node) => node.textContent?.trim())),
        )
        .toEqual(["/pair", "/pair-device", "/openclaw"]);

      await composer.press("ArrowDown");
      await polledAttribute(options.nth(1), "aria-selected").toBe("true");
      await polledText(options.nth(1).locator(".slash-menu-name")).toContain("/pair-device");

      await composer.press("Enter");
      await expect.poll(() => composer.inputValue()).toBe("/pair-device ");
      await expect.poll(() => picker.count()).toBe(0);
    });
  });
});
