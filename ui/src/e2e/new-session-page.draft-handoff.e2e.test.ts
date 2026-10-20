import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollValue,
  pollCount,
  waitForCommittedNewSessionDraft,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const image = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name: `Open image ${name}` });
const attach = (scope: Page | Locator, name: string) =>
  scope
    .locator(".agent-chat__photo-input")
    .setInputFiles(path.join(process.cwd(), "ui/public", name));
async function returnToDraft(page: Page) {
  await page.locator(".sidebar-rail .sidebar-new-session").click();
  await page.waitForURL((url) => url.pathname.endsWith("/new") && url.search === "?agent=main");
}

suite.define(() => {
  it.each([
    { name: "returning after acceptance", returnEarly: false, replacement: null },
    { name: "returning before acceptance", returnEarly: true, replacement: null },
    { name: "writing a newer draft", returnEarly: true, replacement: "A newer unsent draft" },
    { name: "retyping the same draft", returnEarly: true, replacement: "same" },
  ])("settles only the submitted draft when $name", async ({ returnEarly, replacement }) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const message = "Send this once, even if I leave the screen";
      const createdKey = "agent:main:submitted-in-background";
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.create"],
        methodResponses: {
          "sessions.list": createdSessionListResult("agent:main:existing-session"),
          "sessions.create": { key: createdKey, runStarted: true, runId: "created-run" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      const composer = page.locator(".new-session-page__message");
      const fill = async (text: string) => {
        await composer.fill(text);
        await waitForCommittedNewSessionDraft(page, text, ["favicon-32.png"]);
      };
      await composer.fill(message);
      await attach(page, "favicon-32.png");
      await waitForCommittedNewSessionDraft(page, message, ["favicon-32.png"]);
      await composer.press("Enter");
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ message });
      await page.locator(".sidebar-recent-session").filter({ hasText: "Created session" }).click();
      await waitForCommittedChatRoute(page);
      if (!returnEarly) {
        await gateway.resolveDeferred("sessions.create");
      }
      await page.locator(".sidebar-rail .sidebar-new-session").click();
      await page.waitForURL((url) => url.pathname.endsWith("/new"));
      await composer.waitFor();
      const expected = replacement === "same" ? message : (replacement ?? "");
      if (returnEarly) {
        await pollValue(composer).toBe(message);
        await image(page, "favicon-32.png").waitFor();
        if (replacement) {
          await fill("Temporary replacement draft");
          await fill(expected);
        }
        await gateway.resolveDeferred("sessions.create");
      }
      await pollValue(composer).toBe(expected);
      const files = replacement ? ["favicon-32.png"] : 0;
      await waitForCommittedNewSessionDraft(page, expected || null, files);
      expect(new URL(page.url()).pathname.endsWith("/new")).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      await page.reload();
      await pollValue(composer).toBe(expected);
      await pollCount(image(page, "favicon-32.png")).toBe(replacement ? 1 : 0);
    });
  });

  it("lets a newer durable prompt and file beat a stale navigation handoff", async () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ context, page: pageA }) => {
      const sessionKey = "agent:main:existing-session";
      const staleText = "stale draft from the first page";
      const durableText = "newer durable draft from the second page";
      const staleFileName = "favicon-32.png";
      const durableFileName = "apple-touch-icon.png";
      const expectDurableDraft = async (scope: Page | Locator) => {
        await pollValue(scope.locator(".new-session-page__message")).toBe(durableText);
        await image(scope, durableFileName).waitFor();
        await expect(image(scope, staleFileName).count()).resolves.toBe(0);
      };
      await installMockGateway(pageA, {
        methodResponses: {
          "sessions.list": createdSessionListResult(sessionKey),
        },
      });
      await pageA.goto(`${suite.server.baseUrl}chat`);
      const existingSession = pageA
        .locator(".sidebar-recent-session")
        .filter({ hasText: "Created session" });
      await existingSession.waitFor();
      await returnToDraft(pageA);

      await pageA.locator(".new-session-page__message").fill(staleText);
      await attach(pageA, staleFileName);
      await image(pageA, staleFileName).waitFor();

      await existingSession.click();
      await pageA.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));

      const pageB = await context.newPage();
      await installMockGateway(pageB);
      await pageB.goto(`${suite.server.baseUrl}new?agent=main`);
      const messageB = pageB.locator(".new-session-page__message");
      await pollValue(messageB).toBe(staleText);
      await image(pageB, staleFileName).waitFor();

      await messageB.fill(durableText);
      await pageB.getByRole("button", { name: `Remove ${staleFileName}` }).click();
      await attach(pageB, durableFileName);
      await image(pageB, durableFileName).waitFor();
      await waitForCommittedNewSessionDraft(pageB, durableText, [durableFileName]);
      await pageB.reload();
      await expectDurableDraft(pageB);
      await pageB.close();

      await returnToDraft(pageA);
      await expectDurableDraft(pageA);
      await pageA.close();

      const freshPage = await context.newPage();
      await installMockGateway(freshPage);
      await freshPage.goto(`${suite.server.baseUrl}new?agent=main`);
      await expectDurableDraft(freshPage);
    }));
});
