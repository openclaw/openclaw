import { writeFile } from "node:fs/promises";
import type { Route } from "playwright";
import { expect, it } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectPath } from "./sidebar-assertions.test-support.ts";
import {
  captureUnionProof,
  createSidebarFooterProofSuite,
  openSidebarFooterProofPage,
} from "./sidebar-footer-proof.test-support.ts";

const featureBuild: ControlUiBuildInfo = {
  version: "2026.8.14",
  commit: "0123456789abcdef0123456789abcdef01234567",
  commitAt: "2026-08-14T12:00:00.000Z",
  builtAt: "2026-08-14T12:00:00.000Z",
  branch: "feat/sidebar-footer",
  dirty: false,
  release: false,
  buildId: "sidebar-account-footer-feat-sidebar-footer",
};

const avatarSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#527866"/><circle cx="32" cy="24" r="12" fill="#f5d6b5"/><path d="M10 64c0-30 44-30 44 0" fill="#e3b367"/></svg>';

const suite = createSidebarFooterProofSuite("Control UI sidebar build navigation", featureBuild);

suite.define(() => {
  it("keeps profile initials visible while the account photo is loading", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      let photo: Route | undefined;
      await page.route("**/api/users/riley/avatar*", (route) => {
        photo = route;
      });
      await installMockGateway(page, {
        presenceUsers: [
          {
            self: true,
            id: "riley",
            name: "Riley Morgan",
            avatarUrl: "/api/users/riley/avatar?v=slow",
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const avatar = page.locator(".sidebar-identity-card .viewer-avatar");
      await expect.poll(() => avatar.getAttribute("data-avatar-state")).toBe("pending");
      const before = await avatar.boundingBox();
      const fallback = avatar.locator(".viewer-avatar__fallback");
      try {
        await captureUnionProof(
          suite,
          page,
          "sidebar-account-footer",
          `photo-${process.env.OPENCLAW_SIDEBAR_PROOF_STAGE ?? "proof"}-pending.png`,
          [page.locator(".sidebar-identity-card")],
        );
        expect(await fallback.isVisible()).toBe(true);
        expect(await fallback.textContent()).toBe("RM");
        const fallbackBox = await fallback.boundingBox();
        expect(fallbackBox!.x + fallbackBox!.width / 2).toBe(before!.x + before!.width / 2);
      } finally {
        await photo?.fulfill({ contentType: "image/svg+xml", body: avatarSvg });
      }
      await expect.poll(() => avatar.getAttribute("data-avatar-state")).toBe("loaded");
      await avatar.locator("img").evaluate((image: HTMLImageElement) => image.decode());
      expect(await avatar.boundingBox()).toEqual(before);
      expect(await fallback.isVisible()).toBe(false);
    });
  });
  it("keeps account identity and sidebar geometry through disconnect and recovery", async () => {
    const rows = [
      "Museum itinerary",
      "Exhibit inventory",
      "Accessibility notes",
      "Weekend route",
    ].map((label, index) =>
      Object.assign(createControlUiSessionRow(`agent:main:museum-${index}`, label, 100 - index), {
        owner: { actor: { type: "human" as const, id: "riley" } },
      }),
    );
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    await context.route("**/api/users/riley/avatar*", (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: avatarSvg }),
    );
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      authMethod: "token",
      authMode: "token",
      subscriptionInitialHistory: false,
      // Warm reload deliberately holds hello; observe cached chrome before roster readiness.
      awaitInitialRoster: false,
      methodResponses: {
        "chat.startup": {
          sessionId: "museum-session",
          sessionInfo: rows[0],
          messages: [
            {
              role: "assistant",
              content: "Your museum itinerary is ready.",
              __openclaw: { id: "museum-note", seq: 1 },
            },
          ],
          deltaCursor: "museum-cursor",
          hasMore: false,
        },
        "sessions.list": {
          ts: Date.now(),
          path: "",
          count: rows.length,
          sessions: rows,
          defaults: { model: null, modelProvider: null, contextTokens: null },
          ownerSessionCounts: [],
        },
      },
      sessions: rows,
      sessionKey: rows[0]!.key,
      presenceUsers: [
        {
          self: true,
          id: "riley",
          identity: { type: "profile", id: "riley" },
          name: "Riley Morgan",
          email: "riley@example.test",
          avatarUrl: "/api/users/riley/avatar?v=1",
        },
      ],
    });
    try {
      await page.goto(
        controlUiSessionUrl(suite.server.baseUrl, rows[0]!.key) + "#token=test-token",
      );
      const sidebar = page.locator("openclaw-app-sidebar");
      await waitForControlUiGatewayReady(page);
      await sidebar.getByText("Exhibit inventory", { exact: true }).waitFor();
      const account = sidebar.locator(".sidebar-identity-card");
      const avatar = account.locator(".viewer-avatar");
      await expect.poll(() => avatar.getAttribute("data-viewer-id")).toBe("riley");
      await avatar.locator("img").waitFor();
      const rail = sidebar.locator(".sidebar-rail");
      const list = sidebar.locator(".sidebar-shell__body");
      const readChrome = () =>
        page.evaluate(() => {
          const rect = (selector: string) => {
            const { x, y, width, height } = document
              .querySelector(selector)!
              .getBoundingClientRect();
            return { x, y, width, height };
          };
          return {
            account: rect(".sidebar-identity-card"),
            rail: rect(".sidebar-rail"),
            list: rect(".sidebar-shell__body"),
          };
        });
      const connected = await readChrome();
      const capture = async (state: string) => {
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
          return;
        }
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".shell"),
          [account, rail, list],
          { animations: "disabled", elements: [sidebar.locator("aside.sidebar")] },
        );
        await writeFile(
          `${suite.artifactDir}/sidebar-${process.env.OPENCLAW_SIDEBAR_PROOF_STAGE ?? "proof"}-${state}.png`,
          frame.png,
        );
        await writeFile(
          `${suite.artifactDir}/sidebar-${process.env.OPENCLAW_SIDEBAR_PROOF_STAGE ?? "proof"}-${state}-crop.png`,
          frame.elements[0]!.png,
        );
      };
      await capture("connected");
      await gateway.setOnline(false);
      await gateway.closeLatest(1001, "synthetic network interruption");
      await page.waitForFunction(
        () => window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting",
      );
      // The grace window suppresses feedback, not the fixed connection slot.
      expect.soft(await readChrome()).toEqual(connected);
      await waitForControlUiGatewayReconnecting(page);
      await capture("reconnecting");
      expect.soft(await account.getAttribute("aria-label")).toContain("Riley Morgan");
      expect.soft(await avatar.locator("img").isVisible()).toBe(true);
      expect.soft(await readChrome()).toEqual(connected);
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await capture("recovered");
      expect(await account.getAttribute("aria-label")).toContain("Riley Morgan");
      expect(await readChrome()).toEqual(connected);
      await expect
        .poll(() => sidebar.locator("aside.sidebar").getAttribute("data-snapshot-saved"))
        .toBe("true");
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(localStorage).some((key) =>
              key.startsWith("openclaw.control.bootRecord.v1:"),
            ),
          ),
        )
        .toBe(true);
      await page.addInitScript(() => {
        const mockWindow: MockGatewayWindow = window;
        mockWindow.openclawControlUiE2eGateway?.deferNext("connect");
      });
      await page.reload();
      await gateway.waitForRequest("connect");
      await sidebar.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
      await sidebar.getByText("Exhibit inventory", { exact: true }).waitFor();
      await avatar.locator("img").waitFor();
      await capture("saved-connecting");
      expect(await account.getAttribute("aria-label")).toContain("Riley Morgan");
      expect(await readChrome()).toEqual(connected);
      await gateway.resolveDeferred("connect");
      await waitForControlUiGatewayReady(page);
      await sidebar.locator('aside.sidebar[data-snapshot-state="live"]').waitFor();
      expect(await account.getAttribute("aria-label")).toContain("Riley Morgan");
      expect(await readChrome()).toEqual(connected);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("navigates from the build link without opening its hovercard on click", async () => {
    const { page, sidebar, context } = await openSidebarFooterProofPage(suite, {
      serverVersion: featureBuild.version ?? undefined,
      serverBuildId: featureBuild.buildId,
    });
    try {
      await sidebar.locator(".sidebar-identity-card").click();
      const buildLink = sidebar.getByRole("menuitem", {
        name: "Control UI build details",
        exact: true,
      });
      const tooltip = sidebar.locator("openclaw-sidebar-build-chip openclaw-tooltip");
      const surface = tooltip.locator(".tooltip-surface[popover]");
      await buildLink.hover();
      await expect
        .poll(() => surface.evaluate((element) => element.matches(":popover-open")))
        .toBe(true);
      await captureUnionProof(suite, page, "sidebar-account-footer", "build-hover.png", [
        sidebar.locator(".sidebar-build-hover-card"),
      ]);
      await page.mouse.move(0, 0);
      await sidebar.locator(".sidebar-build-hover-card").waitFor({ state: "hidden" });
      await tooltip.evaluate((element) => {
        document.documentElement.dataset.buildTooltipOpenedByClick = "false";
        element.addEventListener(
          "overlay-show",
          () => {
            document.documentElement.dataset.buildTooltipOpenedByClick = "true";
          },
          { once: true },
        );
      });
      await buildLink.click();
      await expectPath(page, "/settings/about");
      expect(await page.locator("html").getAttribute("data-build-tooltip-opened-by-click")).toBe(
        "false",
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
