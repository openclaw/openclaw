import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Composer reply author" });
const sessionKey = "agent:main:composer-reply-author";
function participant(id: string, senderName: string) {
  return { senderId: id, senderName, senderIdentity: { type: "profile" as const, id } };
}
const self = participant("alice", "Alice Chen");
const peer = participant("jordan", "Jordan Lee");
const history = [
  ["own-question", "user", "Can you check the release checklist before we share it?", self],
  ["agent-answer", "assistant", "The checklist is ready to share.", {}],
  ["peer-note", "user", "I checked the mobile controls too.", peer],
].map(([id, role, content, metadata], index) => ({
  role,
  content,
  timestamp: 1_800_000_000_000 + index * 1000,
  __openclaw: { id, seq: index + 1, ...(metadata as object) },
}));

async function preparePage(page: Page) {
  await installMockGateway(page, {
    sessionKey,
    historyMessages: history,
    presenceUsers: [self, peer].map((person, index) => ({
      id: person.senderId,
      name: person.senderName,
      identity: person.senderIdentity,
      self: index === 0,
    })),
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  await page.evaluate(async () => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.themeMode = "dark";
    await document.fonts.ready;
  });
}

async function replyTo(page: Page, entryId: string, text: string): Promise<Locator> {
  const bubble = page.locator(`[data-entry-id="${entryId}"]`);
  await bubble.waitFor();
  const key = await bubble.getAttribute("data-message-id");
  const owner = page.locator(`[data-message-actions-for="${key}"]`);
  await bubble.hover();
  await owner.getByRole("button", { name: "Reply to message", exact: true }).click();
  const strip = page
    .locator(".chat-reply-preview")
    .filter({ has: page.getByRole("button", { name: "Cancel reply" }) });
  await expect.poll(() => strip.locator(".chat-reply-preview__text").textContent()).toBe(text);
  return strip;
}

suite.define(() => {
  it("names the reply author with the same avatar span the sent reply shows", async () => {
    const artifacts = createControlUiE2eArtifactDir("composer-reply-author");
    await suite.withPage(
      { viewport: { width: 1280, height: 820 }, locale: "en-US" },
      async ({ page }) => {
        await preparePage(page);
        const cases = [
          ["own-question", "Can you check the release checklist before we share it?", "You"],
          ["peer-note", "I checked the mobile controls too.", "Jordan Lee"],
          ["agent-answer", "The checklist is ready to share.", "OpenClaw"],
        ] as const;
        for (const [entryId, text, name] of cases) {
          const strip = await replyTo(page, entryId, text);
          const composer = page.locator(".agent-chat__input");
          // Settle the unrelated model controls so captures differ only in the strip.
          await composer.getByText("Speed", { exact: true }).waitFor();
          const frame = await takeControlUiScreenshotFrame(page, composer, [strip], {
            elements: [composer],
            animations: "disabled",
          });
          writeFileSync(path.join(artifacts, `${entryId}-page.png`), frame.png);
          writeFileSync(path.join(artifacts, `${entryId}-composer.png`), frame.elements[0]!.png);
          const person = strip.locator(".chat-reply-attribution__person");
          expect({
            label: await strip.locator(".composer-context-strip__label-text").textContent(),
            name: await person.locator(".chat-reply-attribution__name").textContent(),
            avatars: await person.locator(".chat-author-avatar").count(),
          }).toEqual({ label: "Replying to", name, avatars: 1 });
          expect(await strip.textContent()).not.toContain(name === "You" ? "Alice Chen" : "You");
          await strip.getByRole("button", { name: "Cancel reply" }).click();
          await strip.waitFor({ state: "detached" });
        }
      },
    );
  });
});
