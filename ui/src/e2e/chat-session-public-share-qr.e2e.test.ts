import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import QRCode from "qrcode";
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
const title = "Recognizable halftone lobster QR for public conversations";
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

async function expectLobster(qr: Locator, page: Page, surface: Locator, url: string, name: string) {
  const toggle = surface.getByRole("button", { name: "Use lobster QR", exact: true });
  if (name.includes("desktop")) {
    await surface.locator(".chat-pane__sharing-url").focus();
    await page.keyboard.press("Tab");
    expect(await toggle.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
  } else {
    await toggle.click();
  }
  const image = surface.getByRole("img", {
    name: "Lobster QR code for the public link",
    exact: true,
  });
  await image.waitFor();
  await image.evaluate(async (element) => {
    if (element instanceof HTMLImageElement) {
      await element.decode();
    }
  });
  const download = surface.getByRole("link", { name: "Download lobster QR" });
  expect(await download.getAttribute("href")).toBe(await image.getAttribute("src"));
  const frame = await takeControlUiScreenshotFrame(page, surface, [image, download], {
    elements: [image],
    scrollTo: image,
    animations: "disabled",
  });
  await writeFile(suite.artifactDir + "/" + name + ".png", frame.png);
  await writeFile(suite.artifactDir + "/display.png", frame.elements[0]!.png);
  const downloaded = page.waitForEvent("download");
  await download.click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("openclaw-public-link-qr.png");
  await file.saveAs(suite.artifactDir + "/export.png");
  await writeFile(suite.artifactDir + "/url.txt", url);
  await surface.getByRole("button", { name: "Use standard QR", exact: true }).click();
  await qr.waitFor();
  await expectQrEncodes(qr, url);
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
          await expectLobster(
            panel.getByRole("img", { name: "QR code for the public link", exact: true }),
            page,
            panel,
            (await url.textContent())!,
            `halftone-after-desktop-${colorScheme}`,
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
          if (phase === "after") {
            const qr = sharing.getByRole("img", { name: "QR code for the public link" });
            await qr.waitFor();
            await expectQrEncodes(qr, (await url.textContent())!);
            await qr.scrollIntoViewIfNeeded();
            const qrBox = await qr.boundingBox();
            expect(qrBox!.x).toBeGreaterThanOrEqual(0);
            expect(qrBox!.x + qrBox!.width).toBeLessThanOrEqual(390);
          }
          await expectLobster(
            sharing.getByRole("img", { name: "QR code for the public link", exact: true }),
            page,
            sharing,
            (await url.textContent())!,
            `halftone-after-mobile-${colorScheme}`,
          );
        },
      );
    });
  }
});
