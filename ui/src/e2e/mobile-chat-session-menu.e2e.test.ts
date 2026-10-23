import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it, onTestFinished } from "vitest";
import {
  nativePane,
  openChatPanels,
  selectChatLayoutAction,
} from "../test-helpers/chat-layout-menu.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { holdModuleResponse } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const mobile = {
  hasTouch: true,
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { width: 390, height: 844 },
};
const visibilities = ["shared", "read-only", "suggest", "draft"];
const human = (id: string, label: string) => ({ type: "human", id, label });
const height = (locator: Locator) => locator.evaluate((e) => e.getBoundingClientRect().height);
const updatedAt = Date.parse("2026-08-28T12:00:00.000Z");
async function installSessionSharing(
  page: Page,
  key: string,
  title: string,
  role: "owner" | "member",
  visibility: "draft" | "read-only" = "draft",
  includePeople = false,
) {
  const featureMethods = ["chat.metadata", "chat.startup", "session.visibility.set"];
  const methodResponses: Record<string, unknown> = {
    "sessions.list": sessionsListResponse([
      sessionRow(key, title, updatedAt, {
        sharingRole: role,
        visibility,
        ...(includePeople ? { createdActor: { type: "human", id: "owner", label: "Owner" } } : {}),
      }),
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
  return installMockGateway(page, {
    sessionKey: key,
    featureMethods,
    methodResponses,
    operatorScopes: role === "owner" ? ["operator.read", "operator.write"] : ["operator.read"],
  });
}
async function withMobilePage(run: (page: Page) => Promise<void>, colorScheme?: "light" | "dark") {
  await suite.withPage({ ...mobile, colorScheme }, ({ page }) => run(page));
}

async function openMobilePanelLauncher(page: Page) {
  await nativePane(page).locator(".agent-chat__header--mobile").waitFor();
  const trigger = await openChatPanels(page);
  const host = page.locator(".chat-mobile-host").filter({ visible: true });
  await host
    .locator(".chat-mobile-host__header")
    .getByRole("button", {
      name: "Panels",
      exact: true,
    })
    .click();
  const launcher = host.locator(".chat-panel-launcher-mobile");
  if (!(await launcher.isVisible())) {
    await host.getByRole("button", { name: "New tab", exact: true }).click();
  }
  await launcher.waitFor();
  return { host, launcher, trigger };
}

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "keeps the %s mobile Panels sheet bounded and its actions reachable",
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
        const { host, launcher, trigger } = await openMobilePanelLauncher(page);
        const terminal = launcher.getByRole("button", { name: "Terminal", exact: true });
        await terminal.waitFor();
        for (const viewport of [
          { width: 390, height: 844 },
          { width: 320, height: 568 },
          { width: 844, height: 390 },
        ]) {
          await page.setViewportSize(viewport);
          await terminal.scrollIntoViewIfNeeded();
          const bounds = await host.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
          expect(bounds!.y).toBeGreaterThanOrEqual(0);
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
          expect(await host.locator("kbd:visible").count()).toBe(0);
          expect(
            await launcher.evaluate((element) => element.scrollWidth <= element.clientWidth),
          ).toBe(true);
          expect(await height(terminal)).toBeGreaterThanOrEqual(44);
          await terminal.click({ trial: true });
        }
        expect(
          await launcher.evaluate((element) => element.scrollHeight > element.clientHeight),
        ).toBe(true);
        await expect
          .poll(() =>
            host.locator(".chat-mobile-host__scroll-edge--top").filter({ visible: true }).count(),
          )
          .toBe(1);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".shell"),
            [host, terminal],
            {
              animations: "disabled",
            },
          );
          await writeFile(
            path.join(suite.artifactDir, `mobile-panels-${colorScheme}.png`),
            frame.png,
          );
        }

        await host
          .locator(".chat-mobile-host__header")
          .getByRole("button", {
            name: "Close",
            exact: true,
          })
          .click();
        await host.waitFor({ state: "hidden" });
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
        await page
          .locator(".sidebar-region__panels-toggle")
          .getByRole("button", {
            name: "Panels",
            exact: true,
          })
          .waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        const reopened = await openMobilePanelLauncher(page);
        await expect
          .poll(() => reopened.host.locator(".chat-mobile-host__scroll-fades").count())
          .toBe(1);
        await reopened.launcher.getByRole("button", { name: "Subagents", exact: true }).click();
        await page.locator('[data-panel-slot="subagents"]:visible').waitFor();
        await reopened.launcher.waitFor({ state: "hidden" });
        expect(await reopened.host.isVisible()).toBe(true);
      }, colorScheme),
  );

  it.each(["light", "dark"] as const)(
    "keeps %s mobile session actions and sharing in the shared sheet",
    (colorScheme) =>
      withMobilePage(async (page) => {
        const sessionKey = "agent:main:mobile-more";
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const peopleModule = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-mobile-people.tsx"),
        );
        onTestFinished(peopleModule.release);
        const sharingRequest = controlUiE2eBuiltModuleRequest(
          "ui/src/pages/chat/components/chat-session-sharing-mobile.tsx",
        );
        let sharingAvailable = false;
        let documentAvailable = false;
        let documentRequests = 0;
        let documentProbes = 0;
        page.on("request", (request) => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            documentRequests += 1;
          }
        });
        let failedRequests = 0;
        const sharingModule =
          colorScheme === "dark" ? await holdModuleResponse(page, sharingRequest) : undefined;
        if (sharingModule) {
          onTestFinished(sharingModule.release);
        } else {
          await page.route(new URL("index.html", suite.server.baseUrl).href, async (route) => {
            if (route.request().method() === "HEAD") {
              documentProbes += 1;
              if (!documentAvailable) {
                await route.fulfill({ status: 503 });
                return;
              }
            }
            await route.fallback();
          });
          await page.route(sharingRequest, async (route) => {
            if (!sharingAvailable) {
              failedRequests += 1;
              await route.abort("internetdisconnected");
              return;
            }
            await route.fallback();
          });
        }
        const gateway = await installSessionSharing(
          page,
          sessionKey,
          "Mobile menu",
          "owner",
          "draft",
          colorScheme === "light",
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        if (colorScheme === "dark") {
          await page.setViewportSize({ width: 1440, height: 1000 });
          await page
            .locator(".chat-header-session-menu__trigger")
            .filter({ visible: true })
            .click();
          await page.getByRole("menuitem", { name: "Open split view", exact: true }).click();
          await expect.poll(() => page.locator(".chat-split-view__cell").count()).toBe(2);
          await page.setViewportSize(mobile.viewport);
        }
        const trigger = page.getByRole("button", { name: "Actions for Mobile menu" });
        await trigger.click();
        const menu = page.getByRole("menu", { name: "Actions for Mobile menu" });
        await menu.waitFor();
        if (colorScheme === "light") {
          expect(
            await menu.getByRole("menuitem", { name: "Sharing options", exact: true }).count(),
          ).toBe(0);
          await menu.getByRole("menuitem", { name: "People", exact: true }).waitFor();
        } else {
          await menu.getByRole("menuitem", { name: "Sharing options", exact: true }).waitFor();
        }
        await page.keyboard.press("Escape");
        const host = page.locator(".chat-mobile-host").filter({ visible: true });

        expect(peopleModule.requests()).toBe(0);
        expect(sharingModule?.requests() ?? failedRequests).toBe(0);
        if (colorScheme === "light") {
          await trigger.click();
          await menu.getByRole("menuitem", { name: "People", exact: true }).click();
          await peopleModule.request;
          await host.getByRole("status", { name: "Loading…", exact: true }).waitFor();
          await captureUiProof(suite, page, "mobile-people-loading-light.png");
          peopleModule.release();
          await host.getByRole("group", { name: "People", exact: true }).waitFor();
          await host.getByRole("button", { name: /^Sharing options/ }).click();
        } else {
          peopleModule.release();
          await trigger.click();
          await menu.getByRole("menuitem", { name: "Sharing options", exact: true }).click();
        }
        const sharing = host.locator('[data-mobile-page="sharing"]');
        if (sharingModule) {
          const moduleUrl = await sharingModule.request;
          await sharing.getByRole("status", { name: "Loading…", exact: true }).waitFor();
          await captureUiProof(suite, page, "mobile-sharing-pending-dark.png");
          const retiringPane = page.locator(".chat-split-view__cell--active openclaw-chat-pane");
          const retiringElement = await retiringPane.elementHandle();
          expect(retiringElement).not.toBeNull();
          await host
            .locator(".chat-mobile-host__header")
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await selectChatLayoutAction(retiringPane, "Close pane");
          await expect.poll(() => page.locator(".chat-split-view__cell").count()).toBe(1);
          expect(await retiringElement!.evaluate((element) => element.isConnected)).toBe(false);
          sharingModule.release();
          // Observe the already-requested native import settling after its header was retired.
          await page.evaluate(`import(${JSON.stringify(moduleUrl)}).then(() => undefined)`);
          expect(await sharing.isVisible()).toBe(false);
          expect(errors).toEqual([]);
          expect(await gateway.getRequests("session.visibility.set")).toHaveLength(0);
          await trigger.click();
          await menu.getByRole("menuitem", { name: "Sharing options", exact: true }).click();
        } else {
          const failure = sharing.getByRole("alert");
          await failure.waitFor();
          expect(await failure.textContent()).toContain(
            "Failed to fetch dynamically imported module",
          );
          expect(failedRequests).toBeGreaterThan(0);
          await captureUiProof(suite, page, "mobile-sharing-error-light.png");
          expect(documentRequests).toBe(1);
          await expect.poll(() => documentProbes).toBeGreaterThanOrEqual(1);
          const reloaded = page.waitForEvent("domcontentloaded");
          await failure.getByRole("button", { name: "Reload", exact: true }).click();
          sharingAvailable = true;
          documentAvailable = true;
          await reloaded;
          await trigger.waitFor();
          expect(new URL(page.url()).pathname).toBe(
            new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey)).pathname,
          );
          expect(await sharing.isVisible()).toBe(false);
          // Full-document recovery preserves the session route; the operator reopens the sheet.
          await trigger.click();
          await menu.getByRole("menuitem", { name: "People", exact: true }).click();
          await host.getByRole("button", { name: /^Sharing options/ }).click();
        }
        try {
          await sharing.getByRole("heading", { name: "Session members", exact: true }).waitFor();
        } finally {
          console.info("MOBILE_SHARING_RECOVERY", {
            documentRequests,
            documentProbes,
            failedRequests,
          });
        }
        const lastMember = sharing.getByRole("checkbox", { name: /^Member 29,/ });
        await lastMember.scrollIntoViewIfNeeded();
        expect(await sharing.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await lastMember.click({ trial: true });
        const bounds = await host.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(mobile.viewport.width);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(mobile.viewport.height);
        await captureUiProof(suite, page, `mobile-sharing-sheet-${colorScheme}.png`);

        await sharing.getByRole("button", { name: "Search people…", exact: true }).click();
        const search = sharing.getByRole("searchbox", { name: "Search people and agents…" });
        await search.fill("Member 29");
        await lastMember.waitFor();
        await sharing.getByRole("button", { name: /^Draft / }).click();
        const access = host.locator('[data-mobile-page="sharing-access"]');
        await access.getByRole("button", { name: /^Draft / }).waitFor();
        await host
          .locator(".chat-mobile-host__header")
          .getByRole("button", { name: "Back", exact: true })
          .click();
        await search.waitFor();
        expect(await search.inputValue()).toBe("Member 29");
        await host
          .locator(".chat-mobile-host__header")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await host.waitFor({ state: "hidden" });
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
        if (colorScheme === "light") {
          await trigger.click();
          await menu.getByRole("menuitem", { name: "People", exact: true }).click();
          await host.getByRole("button", { name: /^Sharing options/ }).click();
        } else {
          await trigger.click();
          await menu.getByRole("menuitem", { name: "Sharing options", exact: true }).click();
        }
        await search.waitFor();
        expect(await search.inputValue()).toBe("Member 29");
        await sharing.getByRole("button", { name: /^Draft / }).click();
        await access.getByRole("button", { name: /^Draft / }).waitFor();
        expect(
          await access.getByRole("button", { name: /^Draft / }).getAttribute("aria-pressed"),
        ).toBe("true");
        await gateway.deferNext("session.visibility.set");
        await access.getByRole("button", { name: /^Shared / }).click();
        const changed = await gateway.waitForRequest("session.visibility.set");
        expect(changed.params).toMatchObject({ sessionKey, visibility: "shared" });
        await gateway.setSessionsListResponse(
          sessionsListResponse([
            sessionRow(sessionKey, "Mobile menu", updatedAt, {
              sharingRole: "owner",
              visibility: "shared",
            }),
          ]),
        );
        await gateway.resolveDeferred("session.visibility.set", {
          ok: true,
          sessionKey,
          visibility: "shared",
        });
        await sharing.getByRole("button", { name: /^Shared / }).waitFor();
        expect(await gateway.getRequests("session.visibility.set")).toHaveLength(1);
        if (colorScheme === "light") {
          expect(peopleModule.requests()).toBe(documentRequests);
        }
        if (sharingModule) {
          expect(sharingModule.requests()).toBe(1);
        }
        expect(errors).toEqual([]);
        await host
          .locator(".chat-mobile-host__header")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await trigger.click();
        await menu.getByRole("menuitem", { name: "Advanced", exact: true }).click();

        const advanced = host.locator('[data-mobile-page="session-advanced"]');
        await advanced.waitFor();
        const deleteAction = advanced.getByRole("button", { name: "Delete", exact: true });
        const iconColor = await deleteAction
          .locator("svg")
          .first()
          .evaluate((element) => getComputedStyle(element).color);
        const labelColor = await deleteAction
          .locator("span")
          .last()
          .evaluate((element) => getComputedStyle(element).color);
        expect(iconColor).toBe(labelColor);
        await host
          .locator(".chat-mobile-host__header")
          .getByRole("button", {
            name: "Back",
            exact: true,
          })
          .click();
        await host.getByRole("button", { name: "Details", exact: true }).waitFor();
        await host
          .locator(".chat-mobile-host__header")
          .getByRole("button", {
            name: "Close",
            exact: true,
          })
          .click();
        await host.waitFor({ state: "hidden" });
      }, colorScheme),
  );

  it("keeps sharing changes unavailable to a non-manager in a read-only session", () =>
    withMobilePage(async (page) => {
      const sessionKey = "agent:main:mobile-member";
      const gateway = await installSessionSharing(
        page,
        sessionKey,
        "Member session",
        "member",
        "read-only",
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByRole("button", { name: "Actions for Member session" }).click();
      const menu = page.getByRole("menu", { name: "Actions for Member session" });
      await menu.waitFor();
      expect(
        await menu.getByRole("menuitem", { name: "Sharing options", exact: true }).count(),
      ).toBe(0);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Member session — Details", exact: true }).click();
      const details = page.locator('.chat-mobile-details-page[data-details-page="root"]:visible');
      await details.waitFor();
      expect(await details.getByRole("button", { name: /^Sharing options/ }).count()).toBe(0);
      for (const method of [
        "session.visibility.set",
        "session.members.add",
        "session.members.remove",
      ]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
    }));
});
