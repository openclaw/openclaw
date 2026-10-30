import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Automatic composer height" });

suite.define(() => {
  it.each([
    { route: "chat", width: 1440, height: 900 },
    { route: "chat", width: 1280, height: 900 },
    { route: "chat", width: 1920, height: 900 },
    { route: "new", width: 1440, height: 900 },
    { route: "new", width: 1600, height: 900 },
    { route: "chat", width: 390, height: 844 },
    { route: "new", width: 390, height: 844 },
    { route: "chat", width: 1440, height: 400 },
  ])(
    "grows and scrolls $route drafts at $width × $height without changing width",
    async ({ route, width, height }) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: Array.from({ length: 24 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: `Message ${index + 1}: Keep the conversation visible while editing a long draft.`,
          })),
        });
        await page.goto(`${suite.server.baseUrl}${route}`);
        const editor = page.locator(".agent-chat__composer-combobox textarea");
        await editor.fill("Short draft");
        const shell = page.locator(".agent-chat__composer-shell");
        const measure = () =>
          editor.evaluate((el) => ({
            height: el.clientHeight,
            scrollHeight: el.scrollHeight,
            lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight),
            width: el.getBoundingClientRect().width,
            resize: getComputedStyle(el).resize,
          }));
        const initial = await measure();
        const initialShell = await shell.boundingBox();
        await editor.fill(Array.from({ length: 12 }, (_, i) => `Draft line ${i + 1}`).join("\n"));
        const expanded = await measure();
        const artifacts = createControlUiE2eArtifactDir(
          `composer-height-${route}-${width}-${height}`,
        );
        await page.screenshot({ path: `${artifacts}/expanded.png`, animations: "disabled" });
        if (height === 900) {
          await expect
            .poll(async () => (await measure()).height)
            .toBeGreaterThan(initial.lineHeight * (route === "new" ? 10 : 6));
          await expect
            .poll(async () => {
              const m = await measure();
              return m.scrollHeight - m.height;
            })
            .toBeLessThanOrEqual(1);
        }
        await editor.fill("Long draft\n".repeat(100));
        await expect
          .poll(async () => {
            const m = await measure();
            return m.scrollHeight - m.height;
          })
          .toBeGreaterThan(0);
        const capped = await measure();
        for (const lines of [5, 20, 40, 200]) {
          await editor.fill("A pasted prompt line\n".repeat(lines));
          await expect
            .poll(async () => (await measure()).height)
            .toBeLessThanOrEqual(capped.height);
        }
        await editor.pressSequentially("More text while already at the cap.");
        await expect.poll(async () => (await measure()).height).toBe(capped.height);
        expect(capped.resize).toBe("none");
        expect((await shell.boundingBox())!.width).toBeCloseTo(initialShell!.width, 0);
        expect(await page.getByRole("separator", { name: "Resize message width" }).count()).toBe(0);
        const send = page.getByRole("button", { name: /^(Send|Start)/ }).last();
        await send.scrollIntoViewIfNeeded();
        await send.click({ trial: true });
        await page.screenshot({ path: `${artifacts}/capped.png`, animations: "disabled" });
        if (route === "chat" && width > 600) {
          const thread = await page.locator(".chat-thread").boundingBox();
          expect(thread!.height).toBeGreaterThanOrEqual(height === 900 ? 159 : 59);
        }
        await editor.fill("Short draft");
        await expect.poll(async () => (await measure()).height).toBe(initial.height);
        writeFileSync(
          `${artifacts}/geometry.json`,
          JSON.stringify({ route, width, height, initial, expanded, capped }, null, 2),
        );
      });
    },
  );
  it("restores a long draft at its final height from the first painted frame", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:composer-height-reload";
      await seedChatSettings(page, suite.server.baseUrl, { chatMessageMaxWidth: "1000px" });
      await installMockGateway(page, {
        sessionKey,
        historyMessages: [{ role: "assistant", content: "Reload keeps the draft still." }],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const editor = page.locator(".agent-chat__composer-combobox > textarea");
      const draft = Array.from({ length: 40 }, (_, i) => `Draft line ${i}`).join("\n");
      await editor.fill(draft);
      await waitForCommittedComposerDraft(page, `chat:v3:${sessionKey}\u0000agent:main`, draft, 0);
      await page.addInitScript(() => {
        const frames: number[] = [];
        Object.assign(window, { composerHeightFrames: frames });
        const tick = () => {
          const text = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          if (text?.value) {
            frames.push(text.clientHeight);
          }
          if (frames.length < 30) {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      });
      await page.reload();
      const frames = () =>
        page.evaluate(() => {
          // SAFETY: The document-start script above owns this test-only array.
          return (window as unknown as { composerHeightFrames: number[] }).composerHeightFrames;
        });
      await expect.poll(async () => (await frames()).length).toBe(30);
      const heights = await frames();
      expect(new Set(heights).size, heights.join(", ")).toBe(1);
      const expected = await editor.evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          12 * Number.parseFloat(style.lineHeight) +
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.paddingBottom)
        );
      });
      expect(heights[0]).toBeCloseTo(expected, 0);
    });
  });
});
