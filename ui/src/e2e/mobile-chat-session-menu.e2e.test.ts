import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { openChatLayoutMenu, selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);
const mobile = {
  hasTouch: true,
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { width: 390, height: 844 },
};
const visibilities: Array<"shared" | "read-only" | "suggest" | "draft"> = [
  "shared",
  "read-only",
  "suggest",
  "draft",
];
const item = (host: Locator, name: string) => host.getByRole("menuitem", { name, exact: true });
const height = (element: Locator) =>
  element.evaluate((node) => node.getBoundingClientRect().height);
const draftRow = (key: string, title: string, sharingRole: "owner" | "member") =>
  sessionsListResponse([
    {
      ...sessionRow(key, title, Date.parse("2026-08-28T12:00:00.000Z")),
      sharingRole,
      visibility: "draft",
    },
  ]);
async function withMobilePage(run: (page: Page) => Promise<void>, colorScheme?: "light" | "dark") {
  await suite.withPage({ ...mobile, colorScheme }, ({ page }) => run(page));
}

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "keeps the %s mobile Layout menu bounded and its actions reachable without desktop shortcuts",
    async (colorScheme) => {
      await withMobilePage(async (page) => {
        const sessionKey = "agent:main:mobile-layout";
        await installMockGateway(page, {
          sessionKey,
          terminalEnabled: true,
          featureMethods: ["chat.metadata", "chat.startup", "terminal.open"],
          methodResponses: {
            "sessions.list": sessionsListResponse([
              sessionRow(sessionKey, "Mobile layout", Date.parse("2026-08-28T12:00:00.000Z")),
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const host = await openChatLayoutMenu(page);
        const menu = host.getByRole("menu");
        const terminal = host.getByRole("menuitem", { name: "Toggle terminal", exact: true });
        await terminal.waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".shell"),
            [menu, terminal],
            { animations: "disabled" },
          );
          await writeFile(
            path.join(suite.artifactDir, "mobile-layout-" + colorScheme + ".png"),
            frame.png,
          );
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        expect(await terminal.locator("kbd").isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await expect
          .poll(() =>
            page
              .getByRole("button", { name: "Layout", exact: true })
              .evaluate((element) => element === document.activeElement),
          )
          .toBe(true);
        await page.setViewportSize({ width: 390, height: 844 });
        await openChatLayoutMenu(page);
        for (const viewport of [
          { width: 390, height: 844 },
          { width: 320, height: 568 },
          { width: 844, height: 390 },
        ]) {
          await page.setViewportSize(viewport);
          expect(await host.locator("kbd:visible").count()).toBe(0);
          const bounds = await menu.boundingBox();
          if (!bounds) {
            throw new Error("Expected visible Layout menu");
          }
          expect(bounds.width).toBeLessThanOrEqual(264);
          expect(bounds.height).toBeLessThanOrEqual(Math.min(360, viewport.height * 0.5) + 1);
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
          // The phone menu opens from its header trigger, not a viewport corner.
          const anchor = await host.locator("button.chat-pane__layout-trigger").boundingBox();
          if (!anchor) {
            throw new Error("Expected a visible Layout trigger");
          }
          expect(Math.abs(bounds.x + bounds.width - (anchor.x + anchor.width))).toBeLessThanOrEqual(
            1,
          );
          expect(bounds.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
          expect(bounds.y).toBeLessThanOrEqual(anchor.y + anchor.height + 12);
          expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true,
          );
          expect(
            await terminal.evaluate((element) => element.getBoundingClientRect().height),
          ).toBeGreaterThanOrEqual(44);
        }
        expect(await menu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
          true,
        );
        await selectChatLayoutAction(page, "Subagents");
        await page.locator('[data-panel-slot="subagents"]:visible').waitFor();
        await expect.poll(() => host.getAttribute("open")).toBeNull();
      }, colorScheme);
    },
  );

  it.each(["light", "dark"] as const)(
    "keeps mobile sharing inside the %s session More menu",
    async (colorScheme) => {
      const sessionKey = "agent:main:mobile-more";
      await withMobilePage(async (page) => {
        await installMockGateway(page, {
          allowedSessionVisibilities: visibilities,
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "session.visibility.set",
            "session.members.listEvidence",
            "session.members.add",
            "session.members.remove",
          ],
          operatorScopes: ["operator.read", "operator.write"],
          sessionKey,
          methodResponses: {
            "sessions.list": draftRow(sessionKey, "Mobile menu", "owner"),
            "session.members.listEvidence": {
              sessionKey,
              owner: { type: "human", id: "owner", label: "Owner" },
              members: [],
              identities: [
                { type: "human", id: "owner", label: "Owner" },
                ...Array.from({ length: 30 }, (_, index) => ({
                  type: "human" as const,
                  id: `member-${index}`,
                  label: `Member ${index}`,
                })),
              ],
              role: "owner",
              allowedVisibilities: visibilities,
            },
          },
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByRole("button", { name: "Actions for Mobile menu" }).click();
        const menu = page.getByRole("menu", { name: "Actions for Mobile menu" });
        const menuHost = page.locator("openclaw-chat-header-session-menu");
        await menu.waitFor({ state: "visible" });
        await item(menuHost, "Session sharing").waitFor({ state: "visible" });
        await expect.poll(() => height(menu)).toBeLessThan(550);
        await captureUiProof(suite, page, `mobile-more-followup-after-${colorScheme}.png`);

        await item(menuHost, "Advanced").click();
        const deleteAction = item(menuHost, "Delete…");
        const color = (selector: string) =>
          deleteAction.locator(selector).evaluate((element) => getComputedStyle(element).color);
        const deleteIconColor = await color(".session-menu__icon");
        const deleteLabelColor = await color(".session-menu__text");
        expect(deleteIconColor).toBe(deleteLabelColor);
        await item(menuHost, "Back").click();
        await expect
          .poll(() => page.getByRole("button", { name: "Session sharing" }).count())
          .toBe(0);
        await item(menuHost, "Session sharing").click();
        const publish = menuHost.locator(".chat-pane__publish-draft");
        await publish.waitFor();
        await menuHost.getByText("Members", { exact: true }).waitFor();
        await expect.poll(async () => Math.round(await height(menu))).toBeLessThanOrEqual(421);
        await expect
          .poll(() => menu.evaluate((element) => element.scrollHeight))
          .toBeGreaterThan(await menu.evaluate((element) => element.clientHeight));
        await expect.poll(async () => Math.round(await height(publish))).toBe(34);
        await captureUiProof(suite, page, `mobile-more-sharing-followup-after-${colorScheme}.png`);
      }, colorScheme);
    },
  );

  it("keeps the mobile draft indicator for non-manager sessions", async () => {
    const sessionKey = "agent:main:mobile-member-draft";
    await withMobilePage(async (page) => {
      await installMockGateway(page, {
        allowedSessionVisibilities: visibilities,
        featureMethods: ["chat.metadata", "chat.startup", "session.visibility.set"],
        operatorScopes: ["operator.read"],
        sessionKey,
        methodResponses: {
          "sessions.list": draftRow(sessionKey, "Member draft", "member"),
        },
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.locator(".chat-pane__draft-indicator").waitFor();
      await page.getByRole("button", { name: "Actions for Member draft" }).click();
      const menuHost = page.locator("openclaw-chat-header-session-menu");
      await expect.poll(() => item(menuHost, "Session sharing").count()).toBe(0);
    });
  });
});
