import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const sessionKey = "agent:main:dashboard:619dfdde-5f1b-4f7f-be9c-68ab72f812f8";
const title = "Recognizable halftone claw QR for public conversations";
const owner = { type: "human", id: "owner", label: "Owner" };

async function openPublishedSession(page: Page) {
  await installMockGateway(page, {
    sessionKey,
    featureMethods: [
      "chat.metadata",
      "chat.startup",
      "session.visibility.set",
      "session.members.listEvidence",
      "session.publicShare.set",
    ],
    operatorScopes: ["operator.read", "operator.write"],
    methodResponses: {
      "sessions.list": sessionsListResponse([
        sessionRow(sessionKey, title, Date.parse("2026-10-21T12:00:00.000Z"), {
          sharingRole: "owner",
          visibility: "read-only",
        }),
      ]),
      "session.members.listEvidence": {
        sessionKey,
        owner,
        members: [],
        identities: [owner],
        role: "owner",
        allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
        publicShare: { token: `v1.${"a".repeat(43)}`, createdAt: 1 },
      },
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
}

async function expectClaw(page: Page, surface: Locator, url: string, name: string) {
  const image = surface.getByRole("img", {
    name: "Claw QR code for the public link",
    exact: true,
  });
  await image.waitFor();
  await image.evaluate(async (element) => {
    if (element instanceof HTMLImageElement) {
      await element.decode();
    }
  });
  expect(await surface.getByRole("button", { name: "Use claw QR" }).count()).toBe(0);
  expect(await surface.locator("a[download]").count()).toBe(0);
  const frame = await takeControlUiScreenshotFrame(page, surface, [image], {
    elements: [image],
    scrollTo: image,
    animations: "disabled",
  });
  const [surfaceBox, imageBox] = await Promise.all([surface.boundingBox(), image.boundingBox()]);
  expect(imageBox!.width).toBe(240);
  expect(imageBox!.x).toBeGreaterThanOrEqual(surfaceBox!.x);
  expect(imageBox!.x + imageBox!.width).toBeLessThanOrEqual(surfaceBox!.x + surfaceBox!.width);
  await writeFile(suite.artifactDir + "/" + name + ".png", frame.png);
  await writeFile(suite.artifactDir + "/display.png", frame.elements[0]!.png);
  await writeFile(suite.artifactDir + "/url.txt", url);
}

suite.define(() => {
  for (const colorScheme of ["light", "dark"] as const) {
    it(`shows a QR code for the copied public link in the desktop sharing menu (${colorScheme})`, async () => {
      await suite.withPage(
        { colorScheme, locale: "en-US", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          await openPublishedSession(page);
          await page.locator(".chat-pane__sharing-trigger").filter({ visible: true }).click();
          const panel = page.locator(".chat-pane__sharing-panel");
          await expect
            .poll(() => panel.evaluate((element) => element.matches(":popover-open")))
            .toBe(true);
          const url = panel.locator(".chat-pane__sharing-url-text");
          await expect.poll(() => url.textContent()).toMatch(/^http:\/\/.+\/chat\//u);
          await expectClaw(
            page,
            panel,
            (await url.textContent())!,
            `round-claw-desktop-${colorScheme}`,
          );
        },
      );
    });

    it(`shows a QR code for the copied public link on the mobile sharing page (${colorScheme})`, async () => {
      await suite.withPage(
        {
          colorScheme,
          hasTouch: true,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 390, height: 844 },
        },
        async ({ page }) => {
          await openPublishedSession(page);
          await page.getByRole("button", { name: `Actions for ${title}` }).click();
          await page
            .getByRole("menu", { name: `Actions for ${title}` })
            .getByRole("menuitem", { name: "Sharing options", exact: true })
            .click();
          const sharing = page
            .locator(".chat-mobile-host")
            .filter({ visible: true })
            .locator('[data-mobile-page="sharing"]');
          const url = sharing.locator(".chat-sharing-mobile__url");
          await expect.poll(() => url.textContent()).toMatch(/^http:\/\/.+\/chat\//u);
          await expectClaw(
            page,
            sharing,
            (await url.textContent())!,
            `round-claw-mobile-${colorScheme}`,
          );
        },
      );
    });
  }
});
