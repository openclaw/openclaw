import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  waitForCommittedNewSessionDraft,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([
    { name: "returning after acceptance", returnEarly: false, replacement: null },
    { name: "returning before acceptance", returnEarly: true, replacement: null },
    { name: "writing a newer draft", returnEarly: true, replacement: "A newer unsent draft" },
    { name: "retyping the same draft", returnEarly: true, replacement: "same" },
  ])("settles only the submitted draft when $name", async ({ returnEarly, replacement }) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const existingSession = "agent:main:existing-session";
      const createdSession = "agent:main:submitted-in-background";
      const message = "Send this once, even if I leave the screen";
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.create"],
        methodResponses: {
          "sessions.list": createdSessionListResult(existingSession),
          "sessions.create": { key: createdSession, runStarted: true, runId: "created-run" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      const composer = page.locator(".new-session-page__message");
      await composer.fill(message);
      await page
        .locator(".agent-chat__photo-input")
        .setInputFiles(path.join(process.cwd(), "ui/public/favicon-32.png"));
      await waitForCommittedNewSessionDraft(page, message, ["favicon-32.png"]);
      await composer.press("Enter");
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ message });
      await page.locator(".sidebar-recent-session").filter({ hasText: "Created session" }).click();
      await waitForCommittedChatRoute(page);
      if (!returnEarly) {
        await gateway.resolveDeferred("sessions.create");
      }
      await page.locator(".sidebar-brand__new-thread").click();
      await page.waitForURL((url) => url.pathname.endsWith("/new"));
      await composer.waitFor();
      const expected = replacement === "same" ? message : (replacement ?? "");
      if (returnEarly) {
        await expect.poll(() => composer.inputValue()).toBe(message);
        await page.getByRole("button", { name: "Open image favicon-32.png" }).waitFor();
        if (replacement) {
          await composer.fill("Temporary replacement draft");
          await waitForCommittedNewSessionDraft(page, "Temporary replacement draft", [
            "favicon-32.png",
          ]);
          await composer.fill(expected);
          await waitForCommittedNewSessionDraft(page, expected, ["favicon-32.png"]);
        }
        await gateway.resolveDeferred("sessions.create");
      }
      try {
        await expect.poll(() => composer.inputValue()).toBe(expected);
        await waitForCommittedNewSessionDraft(
          page,
          expected || null,
          replacement ? ["favicon-32.png"] : 0,
        );
      } finally {
        await captureUiProof(suite, page, "composer-after-background-acceptance.png");
      }
      expect(new URL(page.url()).pathname.endsWith("/new")).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      await page.reload();
      await expect.poll(() => composer.inputValue()).toBe(expected);
      expect(await page.getByRole("button", { name: "Open image favicon-32.png" }).count()).toBe(
        replacement ? 1 : 0,
      );
    });
  });

  it("lets a newer durable prompt and file beat a stale navigation handoff", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    try {
      const sessionKey = "agent:main:existing-session";
      const staleText = "stale draft from the first page";
      const durableText = "newer durable draft from the second page";
      const staleFileName = "favicon-32.png";
      const durableFileName = "apple-touch-icon.png";
      const pageA = await context.newPage();
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
      await pageA.locator(".sidebar-brand__new-thread").click();
      await pageA.waitForURL(
        (url) => url.pathname.endsWith("/new") && url.search === "?agent=main",
      );

      const newSessionA = pageA.locator("openclaw-new-session-page");
      const messageA = newSessionA.locator(".new-session-page__message");
      await messageA.fill(staleText);
      await newSessionA
        .locator(".agent-chat__photo-input")
        .setInputFiles(path.join(process.cwd(), "ui/public/favicon-32.png"));
      await newSessionA.getByRole("button", { name: `Open image ${staleFileName}` }).waitFor();
      await captureUiProof(suite, pageA, "new-session-draft-before-navigation.png");

      await existingSession.click();
      await pageA.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));

      const pageB = await context.newPage();
      await installMockGateway(pageB);
      await pageB.goto(`${suite.server.baseUrl}new?agent=main`);
      const newSessionB = pageB.locator("openclaw-new-session-page");
      const messageB = newSessionB.locator(".new-session-page__message");
      await expect.poll(() => messageB.inputValue()).toBe(staleText);
      await newSessionB.getByRole("button", { name: `Open image ${staleFileName}` }).waitFor();

      await messageB.fill(durableText);
      await newSessionB.getByRole("button", { name: `Remove ${staleFileName}` }).click();
      await newSessionB
        .locator(".agent-chat__photo-input")
        .setInputFiles(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      await newSessionB.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await waitForCommittedNewSessionDraft(pageB, durableText, [durableFileName]);
      await pageB.reload();
      await expect.poll(() => messageB.inputValue()).toBe(durableText);
      await newSessionB.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await expect(
        newSessionB.getByRole("button", { name: `Open image ${staleFileName}` }).count(),
      ).resolves.toBe(0);
      await pageB.close();

      await pageA.locator(".sidebar-brand__new-thread").click();
      await pageA.waitForURL(
        (url) => url.pathname.endsWith("/new") && url.search === "?agent=main",
      );
      await expect.poll(() => messageA.inputValue()).toBe(durableText);
      await newSessionA.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await expect(
        newSessionA.getByRole("button", { name: `Open image ${staleFileName}` }).count(),
      ).resolves.toBe(0);
      await captureUiProof(suite, pageA, "new-session-draft-restored.png");
      await pageA.close();

      const freshPage = await context.newPage();
      await installMockGateway(freshPage);
      await freshPage.goto(`${suite.server.baseUrl}new?agent=main`);
      await expect
        .poll(() => freshPage.locator(".new-session-page__message").inputValue())
        .toBe(durableText);
      await freshPage.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await expect(
        freshPage.getByRole("button", { name: `Open image ${staleFileName}` }).count(),
      ).resolves.toBe(0);
    } finally {
      await context.close();
    }
  });
});
