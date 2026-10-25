import type { Locator, Page } from "playwright";
import QRCode from "qrcode";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const sessionKey = "agent:main:gtc-demo";
const title = "GTC demo";
const owner = { type: "human", id: "owner", label: "Owner" };
const phase = process.env.OPENCLAW_PUBLIC_SHARE_QR_PHASE ?? "after";

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

/** Rebuild the rendered module grid and compare it with the encoder's matrix for `url`. */
async function expectQrEncodes(qr: Locator, url: string) {
  const rendered = await qr.evaluate((svg) => ({
    viewBox: svg.getAttribute("viewBox"),
    path: svg.querySelector("path")?.getAttribute("d") ?? "",
    width: svg.getBoundingClientRect().width,
    height: svg.getBoundingClientRect().height,
  }));
  const { size, data } = QRCode.create(url, { errorCorrectionLevel: "M" }).modules;
  const quiet = 4;
  expect(rendered.viewBox).toBe(`0 0 ${size + quiet * 2} ${size + quiet * 2}`);
  const dark = new Set<number>();
  for (const [, x, y, run] of rendered.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/gu)) {
    for (let offset = 0; offset < Number(run); offset += 1) {
      dark.add((Number(y) - quiet) * size + Number(x) - quiet + offset);
    }
  }
  const expected = new Set<number>();
  for (let index = 0; index < data.length; index += 1) {
    if (data[index]) {
      expected.add(index);
    }
  }
  expect(dark).toEqual(expected);
  // Phone cameras need enough pixels per module; keep the symbol square and legible.
  expect(Math.abs(rendered.width - rendered.height)).toBeLessThanOrEqual(1);
  expect(rendered.width / (size + quiet * 2)).toBeGreaterThanOrEqual(2.5);
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
          if (phase === "after") {
            const qr = panel.getByRole("img", { name: "QR code for the public link" });
            await qr.waitFor();
            await expectQrEncodes(qr, (await url.textContent())!);
            const [panelBox, qrBox] = await Promise.all([panel.boundingBox(), qr.boundingBox()]);
            expect(qrBox!.x).toBeGreaterThanOrEqual(panelBox!.x);
            expect(qrBox!.x + qrBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
          }
          await captureUiProof(suite, page, `public-share-qr-desktop-${colorScheme}-${phase}.png`);
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
          if (phase === "after") {
            const qr = sharing.getByRole("img", { name: "QR code for the public link" });
            await qr.waitFor();
            await expectQrEncodes(qr, (await url.textContent())!);
            await qr.scrollIntoViewIfNeeded();
            const qrBox = await qr.boundingBox();
            expect(qrBox!.x).toBeGreaterThanOrEqual(0);
            expect(qrBox!.x + qrBox!.width).toBeLessThanOrEqual(390);
          }
          await captureUiProof(suite, page, `public-share-qr-mobile-${colorScheme}-${phase}.png`);
        },
      );
    });
  }
});
