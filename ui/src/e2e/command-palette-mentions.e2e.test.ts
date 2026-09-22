import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  expectForegroundUnchanged,
  openFromForeground,
  scenario,
} from "./command-palette.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette people mentions" });
const people = [
  "Alex Chen",
  "Jordan Rivera",
  "Sam Taylor",
  "Morgan Lee",
  "Casey Williams",
  "Riley Patel",
  "Avery Thompson",
  "Quinn Davis",
  "Jamie Wilson",
  "Charlie Garcia",
].map((displayName, index) => ({
  profileId: "person-" + index,
  displayName,
  online: index % 2 === 0,
}));
function mentionScenario() {
  const base = scenario({
    "users.mentionable": { users: people, truncated: false },
    "sessions.create": {
      key: "agent:main:dashboard:palette-mentioned",
      runStarted: true,
      runId: "mentioned-run",
    },
  });
  return {
    ...base,
    featureMethods: [...base.featureMethods!, "users.mentionable"],
    presenceUsers: [
      {
        self: true,
        id: "sender",
        identity: { type: "profile" as const, id: "sender" },
        name: "Sender",
      },
    ],
  };
}
async function anchors(palette: Locator) {
  return palette.evaluate((element) =>
    [
      ".cmd-palette",
      ".cmd-palette__input",
      ".cmd-palette__create",
      'button[aria-label="New session settings"]',
    ].map((selector) => {
      const rect = element.querySelector(selector)!.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    }),
  );
}
async function selectPerson(input: Locator, palette: Locator, index: number) {
  await input.press("@");
  const menu = palette.getByRole("listbox", { name: "Mention a person" });
  await menu.getByRole("option").nth(9).waitFor({ state: "visible" });
  expect(await menu.getByRole("option").count()).toBe(10);
  await input.press("Home");
  for (let step = 0; step < index; step++) {
    await input.press("ArrowDown");
  }
  await input.press(index % 2 ? "Tab" : "Enter");
  await menu.waitFor({ state: "detached" });
  expect(await menu.count()).toBe(0);
}

suite.define(() => {
  it("continues an explicitly typed mention across the first-open lazy handoff", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, mentionScenario());
      const heldModule = await holdModuleResponse(
        page,
        /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
      );
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".agent-chat__composer-combobox textarea:visible").waitFor();
        await page.keyboard.press("ControlOrMeta+K");
        const cold = page.locator(".cmd-palette[aria-busy=true] textarea");
        await cold.waitFor({ state: "visible" });
        await cold.pressSequentially("@Al");
        heldModule.release();
        const palette = page.locator("openclaw-command-palette");
        const input = palette.locator(".cmd-palette__input");
        const menu = palette.getByRole("listbox", { name: "Mention a person" });
        await menu.getByRole("option").nth(9).waitFor({ state: "visible" });
        expect(await menu.getByRole("option").count()).toBe(10);
        expect((await gateway.waitForRequest("users.mentionable")).params).toMatchObject({
          query: "Al",
          agentId: "main",
        });
        await input.press("Enter");
        expect(await input.inputValue()).toBe("@Alex Chen ");
        expect(await palette.locator(".composer-context-strip__person").count()).toBe(1);
      } finally {
        heldModule.release();
      }
    });
  });

  it.each([1280, 390])(
    "keeps one, two, and many people compact and anchored at %s px",
    async (width) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, mentionScenario());
          const { palette, input, composer, url } = await openFromForeground(
            page,
            suite.server.baseUrl,
          );
          await page.evaluate(() => document.fonts.ready);
          const before = await anchors(palette);
          const mentions = [];
          for (let index = 0; index < people.length; index++) {
            const start = (await input.inputValue()).length;
            await selectPerson(input, palette, index);
            mentions.push({
              profileId: people[index]!.profileId,
              start,
              end: start + people[index]!.displayName.length + 1,
            });
            if ([1, 2, 10].includes(index + 1)) {
              expect(await anchors(palette)).toEqual(before);
              expect(await palette.locator(".composer-context-strip__person").count()).toBe(
                index + 1,
              );
              expect(await input.getAttribute("aria-activedescendant")).toBeNull();
            }
          }
          await palette.locator(".composer-context-strip__more").waitFor({ state: "visible" });
          expect(
            await palette
              .locator(".composer-context-strip__people")
              .evaluate((element) => element.scrollWidth <= element.clientWidth),
          ).toBe(true);
          await input.press("@");
          const menu = palette.getByRole("listbox", { name: "Mention a person" });
          await menu.getByText(/10 people/u).waitFor();
          expect(await menu.textContent()).toContain("10 people");
          expect(await menu.getByRole("option").count()).toBe(0);
          expect(await input.getAttribute("aria-activedescendant")).toBeNull();
          const limited = await input.inputValue();
          await input.press("Enter");
          expect(await input.inputValue()).toBe(limited);
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          await input.press("Escape");
          expect(await input.isVisible()).toBe(true);
          await input.press("Backspace");
          const message = (await input.inputValue()).trim();
          await input.press("ControlOrMeta+Enter");
          expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
            message,
            mentions,
          });
          await input.waitFor({ state: "hidden" });
          await expectForegroundUnchanged(page, composer, url);
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          expect(await gateway.getRequests("sessions.sharing.set")).toEqual([]);
        },
      );
    },
  );
});
