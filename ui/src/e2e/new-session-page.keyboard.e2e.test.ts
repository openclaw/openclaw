import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);

suite.define(() => {
  it("keeps the draft and Send above an iOS-style keyboard without shrinking the layout viewport", async () => {
    const page = await openPage({
      viewport: { width: 402, height: 874 },
      isMobile: true,
      hasTouch: true,
      colorScheme: "light",
    });
    await installMockGateway(page, {
      workspace: "/workspace/openclaw",
      workspaceGit: true,
      featureMethods: ["projects.list", "sessions.create", "worktrees.branches"],
      methodResponses: {
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          headBranch: "main",
          repositoryStatus: "git",
        },
      },
    });
    await page.goto(suite.server.baseUrl + "new");
    await page.locator("#new-session-checkout-trigger").click();
    await page
      .getByRole("button", { name: "New worktree Isolated copy of the repo", exact: true })
      .click();
    await page.keyboard.press("Escape");
    const editor = page.locator(".new-session-page__message");
    const composer = page.locator(".new-session-page__composer");
    const send = page.locator(".new-session-page__start-submit");
    await editor.fill("Please check the mobile layout.");
    const initialAvatar = await page.locator(".agent-chat__welcome-avatar").boundingBox();

    // Safari resizes VisualViewport, not the layout viewport/media queries.
    // It may also pan the whole layout to the caret, which keeps the shell tall.
    for (const offsetTop of [0, 48, 874 - 380]) {
      await page.evaluate((offset) => {
        for (const [key, value] of Object.entries({ height: 380, offsetTop: offset })) {
          Object.defineProperty(window.visualViewport!, key, { configurable: true, value });
        }
        window.visualViewport!.dispatchEvent(new Event("resize"));
        window.visualViewport!.dispatchEvent(new Event("scroll"));
      }, offsetTop);
      await waitForLayoutSettled(page, ".new-session-page__composer");
      for (const prompt of [
        "Please check the mobile layout.",
        "A longer first prompt.\n".repeat(20),
      ]) {
        await editor.fill(prompt);
        await waitForLayoutSettled(page, ".new-session-page__composer");
        const box = (await composer.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(offsetTop);
        expect(box.y + box.height).toBeLessThanOrEqual(380 + offsetTop);
        // Docked on the keyboard with the mobile chat composer's bottom gap.
        expect(380 + offsetTop - (box.y + box.height)).toBe(10);
        expect(
          await send.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return element.contains(
              document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
            );
          }),
        ).toBe(true);
      }
    }

    await page.evaluate(() => {
      for (const key of ["height", "offsetTop"]) {
        Reflect.deleteProperty(window.visualViewport!, key);
      }
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await editor.fill("Please check the mobile layout.");
    await waitForLayoutSettled(page, ".agent-chat__welcome-avatar");
    expect((await page.locator(".agent-chat__welcome-avatar").boundingBox())!.height).toBe(
      initialAvatar!.height,
    );
    expect(await editor.inputValue()).toBe("Please check the mobile layout.");
  });
});
