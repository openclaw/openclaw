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
const visibilities = ["shared", "read-only", "suggest", "draft"];
const human = (id: string, label: string) => ({ type: "human", id, label });
const item = (host: Locator, name: string) => host.getByRole("menuitem", { name, exact: true });
const height = (locator: Locator) => locator.evaluate((e) => e.getBoundingClientRect().height);
const updatedAt = Date.parse("2026-08-28T12:00:00.000Z");
async function installDraft(page: Page, key: string, title: string, role: "owner" | "member") {
  const featureMethods = ["chat.metadata", "chat.startup", "session.visibility.set"];
  const methodResponses: Record<string, unknown> = {
    "sessions.list": sessionsListResponse([
      sessionRow(key, title, updatedAt, { sharingRole: role, visibility: "draft" }),
    ]),
  };
  if (role === "owner") {
    featureMethods.push(...["listEvidence", "add", "remove"].map((s) => `session.members.${s}`));
    const owner = human("owner", "Owner");
    methodResponses["session.members.listEvidence"] = {
      sessionKey: key,
      owner,
      members: [],
      role,
      allowedVisibilities: visibilities,
      identities: [
        owner,
        ...Array.from({ length: 30 }, (_, i) => human(`member-${i}`, `Member ${i}`)),
      ],
    };
  }
  await installMockGateway(page, {
    sessionKey: key,
    featureMethods,
    methodResponses,
    operatorScopes: role === "owner" ? ["operator.read", "operator.write"] : ["operator.read"],
  });
}
async function withMobilePage(run: (page: Page) => Promise<void>, colorScheme?: "light" | "dark") {
  await suite.withPage({ ...mobile, colorScheme }, ({ page }) => run(page));
}

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "keeps the %s mobile Layout menu bounded and its actions reachable without desktop shortcuts",
    (colorScheme) =>
      withMobilePage(async (page) => {
        const sessionKey = "agent:main:mobile-layout";
        await installMockGateway(page, {
          sessionKey,
          terminalEnabled: true,
          featureMethods: ["chat.metadata", "chat.startup", "terminal.open"],
          methodResponses: {
            "sessions.list": sessionsListResponse([
              sessionRow(sessionKey, "Mobile layout", updatedAt),
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
          const file = path.join(suite.artifactDir, `mobile-layout-${colorScheme}.png`);
          await writeFile(file, frame.png);
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
          const anchor = await host.locator("button.chat-pane__layout-trigger").boundingBox();
          if (!bounds || !anchor) {
            throw new Error("Expected visible Layout menu and trigger");
          }
          const right = bounds.x + bounds.width;
          for (const [name, valid] of [
            ["width cap", bounds.width <= 264],
            ["height cap", bounds.height <= Math.min(360, viewport.height * 0.5) + 1],
            ["left edge", bounds.x >= 0],
            ["right edge", right <= viewport.width],
            ["bottom edge", bounds.y + bounds.height <= viewport.height],
            ["trigger alignment", Math.abs(right - (anchor.x + anchor.width)) <= 1],
            ["below trigger", bounds.y >= anchor.y + anchor.height],
            ["trigger gap", bounds.y <= anchor.y + anchor.height + 12],
          ] as const) {
            expect(valid, name).toBe(true);
          }
          expect(await menu.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
          expect(await height(terminal)).toBeGreaterThanOrEqual(44);
        }
        expect(await menu.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
        await selectChatLayoutAction(page, "Subagents");
        await page.locator('[data-panel-slot="subagents"]:visible').waitFor();
        await expect.poll(() => host.getAttribute("open")).toBeNull();
      }, colorScheme),
  );

  it.each(["light", "dark"] as const)(
    "keeps mobile sharing inside the %s session More menu",
    (colorScheme) =>
      withMobilePage(async (page) => {
        const sessionKey = "agent:main:mobile-more";
        await installDraft(page, sessionKey, "Mobile menu", "owner");

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
      }, colorScheme),
  );

  it("keeps the mobile draft indicator for non-manager sessions", () =>
    withMobilePage(async (page) => {
      const sessionKey = "agent:main:mobile-member-draft";
      await installDraft(page, sessionKey, "Member draft", "member");

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.locator(".chat-pane__draft-indicator").waitFor();
      await page.getByRole("button", { name: "Actions for Member draft" }).click();
      const menuHost = page.locator("openclaw-chat-header-session-menu");
      await expect.poll(() => item(menuHost, "Session sharing").count()).toBe(0);
    }));
});
