import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  controlUiSessionPath,
  SESSION_LIST_DEFAULTS,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const titleMethod = "sessions.title.prepare";

suite.define(() => {
  it("updates a newly created session URL when its generated title arrives without reloading", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const key = "agent:main:dashboard:12345678-1234-4234-8234-123456789abc";
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
        methodResponses: { "sessions.create": { key, runStarted: true } },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").fill("Explain node version requirements");
      await page.getByRole("button", { name: "Start session" }).click();
      await page.waitForURL(
        (url) => url.pathname === "/chat/main/12345678123442348234123456789abc",
      );
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Keep this unsent draft");
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      const historyLength = await page.evaluate(() => window.history.length);
      const reads = (await gateway.getRequests("chat.history")).length;
      const session = {
        ...(await gateway.getSessionRow(key)),
        updatedAt: Date.now(),
        displayName: "Node version requirements",
        derivedTitle: "Node version requirements",
      };
      // Route verification must read the same committed title as the live event.
      await gateway.setSessionsListResponse({ ...SESSION_LIST_DEFAULTS, sessions: [session] });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: key,
        reason: "title",
        session,
      });
      await expect.poll(() => page.title()).toContain("Node version requirements");
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe("/chat/main/node-version-requirements-12345678123442348234123456789abc");
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      expect(await composer.inputValue()).toBe("Keep this unsent draft");
      expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
      expect((await gateway.getRequests("chat.history")).length).toBe(reads);
    });
  });
  it.each(["idle", "composition blur", "pending"] as const)(
    "hands off creation title preparation: %s",
    async (mode) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const pending = mode === "pending";
        const key = `agent:main:${mode.replace(" ", "-")}-title`;
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create", titleMethod],
          deferredMethods: pending ? [titleMethod] : [],
          methodResponses: {
            [titleMethod]: { title: "Repair sidebar naming" },
            "sessions.create": { key, runStarted: true },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        const message = page.locator(".new-session-page__message");
        if (mode === "composition blur") {
          await page.clock.install();
          await message.dispatchEvent("compositionstart");
        }
        await message.fill("repair the sidebar naming");
        if (mode === "composition blur") {
          await page.clock.runFor(2_000);
          expect(await gateway.getRequests(titleMethod)).toHaveLength(0);
          await message.blur();
          await page.clock.runFor(1_500);
          expect(await gateway.getRequests(titleMethod)).toHaveLength(1);
        } else {
          await gateway.waitForRequest(titleMethod);
        }
        if (mode === "idle") {
          expect(
            await page.getByText(/When you pause, draft text is sent|Session name:/i).count(),
          ).toBe(0);
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        }
        await page.getByRole("button", { name: "Start session" }).click();
        const created = await gateway.waitForRequest("sessions.create");
        if (pending) {
          expect(created.params).not.toHaveProperty("displayName");
          await gateway.resolveDeferred(titleMethod, { title: "Too late to rename" });
        } else {
          expect(created.params).toMatchObject({
            displayName: "Repair sidebar naming",
            message: "repair the sidebar naming",
          });
        }
        if (mode === "composition blur") {
          return;
        }
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(key));
        if (pending) {
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
          await page.goto(`${suite.server.baseUrl}new`);
          await page.getByRole("switch", { name: "Incognito", exact: true }).click();
        }
        await page.clock.install();
        const laterComposer = pending
          ? message
          : page.locator(".agent-chat__composer-combobox textarea");
        await laterComposer.fill("another topic after creation");
        await page.clock.runFor(2_000);
        expect(await gateway.getRequests(titleMethod)).toHaveLength(pending ? 0 : 1);
      });
    },
  );
});
