import path from "node:path";
import type { LitElement } from "lit";
import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { beforeEach, expect, it } from "vitest";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { readThemedPopupPaint } from "./popup-theme.test-support.ts";
import { openSessionMenuSubmenu } from "./session-management.test-support.ts";
import { routeAvatarFixtures } from "./session-ownership-visuals.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session owner assignment mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:dashboard:owner-outcome";
const proofPhase = process.env.OPENCLAW_OWNER_ASSIGNMENT_PROOF_PHASE;
let proofDir: string;
beforeEach(() => {
  if (proofPhase) {
    proofDir = createControlUiE2eArtifactDir("session-owner-assignment");
  }
});

function sessionsListResponse(archived = false) {
  return {
    count: 2,
    owners: [
      { type: "human" as const, id: "profile-ada", label: "Ada" },
      { type: "human" as const, id: "profile-bob", label: "Bob" },
    ],
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        key: "agent:main:ada-research",
        kind: "direct",
        label: "Ada research",
        createdActor: { type: "human", id: "profile-ada", label: "Ada" },
        owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
        updatedAt: 2,
      },
      {
        key: sessionKey,
        kind: "direct",
        label: "Owner outcome",
        archived,
        createdActor: { type: "human", id: "profile-bob", label: "Bob" },
        owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
        updatedAt: 1,
      },
    ],
    ts: 1,
  };
}

function directoryResponse(extraNames: string[]): UsersListResult {
  return {
    profiles: ["Ada", "Bob", "Carol", ...extraNames].map((displayName) => ({
      id: `profile-${displayName.toLowerCase().replaceAll(" ", "-")}`,
      displayName,
      avatarMime: displayName === "Ada" ? "image/png" : null,
      mergedInto: null,
      createdAt: 1,
      updatedAt: 1,
      emails: [],
      githubIdentity: null,
      hasAvatar: displayName === "Ada",
    })),
  };
}

async function installOwnerGateway(page: Page, archived = false, extraNames: string[] = []) {
  await routeAvatarFixtures(page, [{ id: "profile-ada", background: "#7c3aed", label: "A" }]);
  const result = sessionsListResponse(archived);
  const gateway = await installMockGateway(page, {
    featureMethods: ["chat.startup", "sessions.assignOwner", "sessions.create", "users.list"],
    historyMessages: [{ role: "assistant", content: "Owner assignment outcome proof." }],
    methodResponses: {
      "sessions.list": archived
        ? { ...result, count: 1, sessions: result.sessions.filter((row) => row.key !== sessionKey) }
        : result,
      "users.list": directoryResponse(extraNames),
    },
    operatorScopes: ["operator.read", "operator.write"],
    presenceUsers: [
      {
        self: true,
        id: "profile-ada",
        name: "Ada",
        avatarUrl: "/api/users/profile-ada/avatar?v=1",
      },
    ],
    sessions: result.sessions,
    sessionArchiveFiltering: true,
    sessionKey,
  });
  await page.goto(
    archived
      ? `${suite.server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`
      : controlUiSessionUrl(suite.server.baseUrl, sessionKey),
  );
  await page.getByText("Owner assignment outcome proof.", { exact: true }).waitFor();
  await gateway.deferNext("sessions.assignOwner");
  return gateway;
}

async function expectAssignmentRequest(
  gateway: Awaited<ReturnType<typeof installOwnerGateway>>,
  ownerId = "profile-ada",
  after?: number,
): Promise<void> {
  const request = await gateway.waitForRequest("sessions.assignOwner", { after });
  expect(request.params).toEqual({
    agentId: "main",
    key: sessionKey,
    owner: { type: "human", id: ownerId },
  });
}

async function captureProof(page: Page, surface: string): Promise<void> {
  if (!proofPhase) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, `${surface}-${proofPhase}.png`),
  });
}

async function expectAssignmentAvatarLayout(page: Page): Promise<void> {
  const layout = await page
    .locator('wa-dropdown-item[value^="assign-owner:"]:visible')
    .evaluateAll((items) =>
      items.map((item) => {
        const avatar = item.querySelector(".viewer-avatar")!;
        const slot = item.querySelector('[slot="icon"]')!;
        const label = item.querySelector(".session-menu__text")!;
        const bounds = avatar.getBoundingClientRect();
        const slotBounds = slot.getBoundingClientRect();
        const style = getComputedStyle(avatar);
        return {
          width: style.width,
          height: style.height,
          square: Math.abs(bounds.width - bounds.height) < 0.01,
          contained: bounds.left >= slotBounds.left && bounds.right <= slotBounds.right,
          gap: label.getBoundingClientRect().left - bounds.right,
        };
      }),
    );
  expect(layout.length).toBeGreaterThan(0);
  for (const avatar of layout) {
    expect(avatar).toMatchObject({ width: "24px", height: "24px", square: true, contained: true });
    expect(avatar.gap).toBeGreaterThanOrEqual(6);
  }
}

async function chooseMe(page: Page): Promise<void> {
  await page.getByRole("menuitem", { name: "Assign to…", exact: true }).hover();
  const action = page.getByRole("menuitemradio", { name: "Me", exact: true });
  await action.waitFor({ state: "visible" });
  await action.click();
}

suite.define(() => {
  it.each(["sidebar", "header"] as const)(
    "moves from a tall assignee submenu to sibling rows and back from the %s",
    async (surface) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installOwnerGateway(
          page,
          false,
          Array.from({ length: 40 }, (_, index) => `Teammate ${index + 1}`),
        );
        if (surface === "sidebar") {
          const row = page.locator(`[data-session-key="${sessionKey}"]`);
          await row.hover();
          await row.click({ button: "right" });
        } else {
          await page
            .getByRole("button", { name: "Actions for Owner outcome", exact: true })
            .click();
        }
        const assignTo = page.getByRole("menuitem", { name: "Assign to…", exact: true });
        const sibling = page.getByRole("menuitem", { name: "Fork conversation", exact: true });
        // Settle the opening animation before freezing raw pointer coordinates.
        await assignTo.click({ trial: true });
        const anchor = await assignTo.boundingBox();
        const target = await sibling.boundingBox();
        const inactiveBackground = await sibling.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        expect(anchor).not.toBeNull();
        expect(target).not.toBeNull();
        await page.mouse.move(anchor!.x + 24, anchor!.y + anchor!.height / 2);
        await expectBrowser(assignTo).toHaveAttribute("aria-expanded", "true");
        const me = assignTo.getByRole("menuitemradio", { name: "Me", exact: true });
        await expectBrowser(me).toBeVisible();
        await captureProof(page, `mouse-${surface}-submenu-open`);

        // Native pointer steps matter: locator.hover retries around intercepting overlays.
        await page.mouse.move(target!.x + target!.width - 24, target!.y + target!.height / 2, {
          steps: 12,
        });
        try {
          await expectBrowser(assignTo).toHaveAttribute("aria-expanded", "false");
          await expect
            .poll(() => sibling.evaluate((element) => element.matches(":hover")))
            .toBe(true);
          await expectBrowser(me).toBeHidden();
          await expect
            .poll(() => sibling.evaluate((element) => getComputedStyle(element).backgroundColor))
            .not.toBe(inactiveBackground);
        } finally {
          await captureProof(page, `mouse-${surface}-sibling-row`);
        }

        const copy = page.getByRole("menuitem", { name: "Copy", exact: true });
        await copy.hover();
        await expectBrowser(copy).toHaveAttribute("aria-expanded", "true");
        await assignTo.hover();
        await expectBrowser(copy).toHaveAttribute("aria-expanded", "false");
        await expectBrowser(me).toBeVisible();

        // Follow a paced diagonal from the submenu-facing edge into a non-first
        // choice. The existing dropdown owner must keep the destination usable.
        const choice = assignTo.getByRole("menuitemradio", { name: "Carol", exact: true });
        // Resolve animation/layout actionability before freezing pointer coordinates;
        // the trial does not click or move the pointer into the submenu.
        await choice.click({ trial: true });
        const destination = await choice.boundingBox();
        const origin = await assignTo.boundingBox();
        expect(destination).not.toBeNull();
        expect(origin).not.toBeNull();
        const left = destination!.x < origin!.x;
        const fromX = left ? origin!.x + 4 : origin!.x + origin!.width - 4;
        const fromY = origin!.y + origin!.height / 2;
        const toX = destination!.x + destination!.width / 2;
        const toY = destination!.y + destination!.height / 2;
        await page.mouse.move(fromX, fromY);
        for (let step = 1; step <= 12; step += 1) {
          await page.mouse.move(
            fromX + ((toX - fromX) * step) / 12,
            fromY + ((toY - fromY) * step) / 12,
          );
          // This delay models pointer travel, not a wait for application readiness.
          await page.waitForTimeout(25);
        }
        await expectBrowser(assignTo).toHaveAttribute("aria-expanded", "true");
        await expect.poll(() => choice.evaluate((element) => element.matches(":hover"))).toBe(true);
        await page.mouse.click(toX, toY);
        await expectAssignmentRequest(gateway, "profile-carol");
      });
    },
  );

  it("marks exactly one target when the session is assigned to self", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installOwnerGateway(page);
      const row = page.locator('[data-session-key="agent:main:ada-research"]');
      await row.hover();
      await row.click({ button: "right" });
      const assignTo = page.getByRole("menuitem", { name: "Assign to…", exact: true });
      await assignTo.hover();

      const checked = assignTo.locator(
        ':scope > wa-dropdown-item[slot="submenu"][aria-checked="true"]',
      );
      await expectBrowser(checked).toHaveCount(1);
      await expectBrowser(checked.locator(":scope > .session-menu__text")).toHaveText("Me");
      await expectBrowser(
        assignTo.locator(':scope > wa-dropdown-item[slot="submenu"] > .session-menu__text'),
      ).toHaveText(["Me", "OpenClaw", "Bob", "Carol"]);
    });
  });

  it("assigns named and self owners through one keyboard-accessible submenu", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installOwnerGateway(page);
      const row = page.locator(`[data-session-key="${sessionKey}"]`);
      await row.hover();
      const trigger = row.locator(".sidebar-recent-session__link");
      await row.click({ button: "right" });

      const menu = page.locator("openclaw-session-menu");
      // The context-menu event can return before the lazy renderer mounts the menu.
      await menu.evaluate((element) => (element as LitElement).updateComplete);
      const rootAssignmentLabels = await menu
        .locator(":scope > wa-dropdown > wa-dropdown-item > .session-menu__text")
        .allTextContents();
      expect(rootAssignmentLabels.filter((label) => label.startsWith("Assign to"))).toEqual([
        "Assign to…",
      ]);
      const assignTo = menu.getByRole("menuitem", {
        name: "Assign to…",
        exact: true,
      });
      await assignTo.hover();
      const ownerItems = assignTo.locator(
        ':scope > wa-dropdown-item[slot="submenu"] > .session-menu__text',
      );
      await captureProof(page, "assignment-submenu");
      await expectBrowser(ownerItems).toHaveText(["Me", "OpenClaw", "Bob", "Carol"]);
      const selfAvatar = assignTo
        .getByRole("menuitemradio", { name: "Me", exact: true })
        .locator("openclaw-viewer-avatar img");
      await expectBrowser(selfAvatar).toHaveCount(1);
      await expect
        .poll(() => selfAvatar.evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      await expectAssignmentAvatarLayout(page);
      await expectBrowser(assignTo.locator(":scope > .session-menu__icon")).toHaveCSS(
        "width",
        "14px",
      );
      await expectBrowser(assignTo.locator(":scope > .session-menu__icon svg")).toHaveCSS(
        "width",
        "14px",
      );
      await assignTo.getByRole("menuitemradio", { name: "Carol", exact: true }).click();
      await expectAssignmentRequest(gateway, "profile-carol");
      await gateway.resolveDeferred("sessions.assignOwner", {
        ok: true,
        key: sessionKey,
        owner: { actor: { type: "human", id: "profile-carol", label: "Carol" } },
      });

      await gateway.deferNext("sessions.assignOwner");
      await row.hover();
      await trigger.press("Shift+F10");
      await openSessionMenuSubmenu(page, "Assign to…");
      const keyboardAssignTo = page.getByRole("menuitem", {
        name: "Assign to…",
        exact: true,
      });
      await expectBrowser(
        page.getByRole("menuitemradio", { name: "Me", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expectBrowser(menu).toHaveCount(0);
      await expectBrowser(trigger).toBeFocused();
      await trigger.press("Shift+F10");
      await openSessionMenuSubmenu(page, "Assign to…");
      await expectBrowser(keyboardAssignTo).toHaveAttribute("aria-expanded", "true");
      await expectBrowser(
        page.getByRole("menuitemradio", { name: "Me", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expectAssignmentRequest(gateway, "profile-ada", 1);
    });
  });

  it.each([
    { surface: "sidebar", width: 1280 },
    { surface: "header", width: 1280 },
    { surface: "compact header", width: 390 },
  ])(
    "assigns an archived session to an offline teammate from the $surface",
    async ({ surface, width }) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width },
        },
        async ({ page }) => {
          const extraNames =
            surface === "sidebar"
              ? Array.from(
                  { length: 30 },
                  (_, index) => `Teammate ${String(index + 1).padStart(2, "0")}`,
                )
              : [];
          const gateway = await installOwnerGateway(page, true, extraNames);
          const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
          await expectBrowser(activePane.locator(".agent-chat__disabled-banner")).toContainText(
            "This session is archived.",
          );
          if (surface === "sidebar") {
            const row = page.locator(`[data-session-key="${sessionKey}"]`);
            await row.hover();
            await row.click({ button: "right" });
          } else {
            await activePane.getByRole("button", { name: "Actions for Owner outcome" }).click();
          }
          const assignTo = page.getByRole("menuitem", { name: "Assign to…", exact: true });
          if (surface === "compact header") {
            await assignTo.click();
          } else {
            await assignTo.hover();
          }
          await page.getByRole("menuitemradio", { name: "Me", exact: true }).waitFor();
          await captureProof(page, `archived-${surface.replaceAll(" ", "-")}`);
          await expectBrowser(
            page.getByRole("menuitemradio").locator(":scope > .session-menu__text"),
          ).toHaveText(["Me", "OpenClaw", "Bob", "Carol", ...extraNames].slice(0, 20));
          await expectAssignmentAvatarLayout(page);
          const target = extraNames.at(-1) ?? "Carol";
          if (extraNames.length > 0) {
            await page.getByRole("searchbox", { name: "Search people and agents…" }).fill(target);
            await expectBrowser(page.getByRole("menuitemradio")).toHaveCount(1);
          }
          const owner = page.getByRole("menuitemradio", { name: target, exact: true });
          await owner.scrollIntoViewIfNeeded();
          await expectBrowser(owner).toBeInViewport();
          await captureProof(page, `archived-${surface.replaceAll(" ", "-")}-selected`);
          await owner.click();
          await expectAssignmentRequest(
            gateway,
            `profile-${target.toLowerCase().replaceAll(" ", "-")}`,
          );
        },
      );
    },
  );

  it.each([1280, 390])(
    "assigns a renamed teammate from a 1,000-person directory at width %i",
    async (width) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          const names = Array.from(
            { length: 1000 },
            (_, i) => `Teammate ${String(i).padStart(4, "0")}`,
          );
          const gateway = await installOwnerGateway(page, false, names);
          await gateway.deferNext("users.list");
          const trigger = page.getByRole("button", {
            name: "Actions for Owner outcome",
            exact: true,
          });
          const openAssignment = async () => {
            await trigger.click();
            const assignTo = page.getByRole("menuitem", { name: "Assign to…", exact: true });
            if (width < 560) {
              await assignTo.click();
            } else {
              await assignTo.hover();
            }
          };
          await openAssignment();
          const search = page.getByRole("searchbox", { name: "Search people and agents…" });
          await search.fill("Teammate 0999");
          await gateway.resolveDeferred("users.list", directoryResponse(names));
          await expectBrowser(search).toHaveValue("Teammate 0999");
          await expectBrowser(page.getByRole("menuitemradio")).toHaveCount(1);
          await search.clear();
          await expectBrowser(page.getByRole("menuitemradio")).toHaveCount(20);
          await search.fill("Teammate 0999");
          await captureProof(page, `directory-${width}-search`);
          await search.press("Escape");
          await expectBrowser(trigger).toHaveAttribute("aria-expanded", "false");

          const directory = directoryResponse(names);
          const renamed = directory.profiles.find(
            (profile) => profile.id === "profile-teammate-0999",
          )!;
          renamed.displayName = "Renamed teammate";
          renamed.updatedAt = 2;
          await gateway.setMethodResponse("users.list", directory);
          await openAssignment();
          await search.fill("Renamed teammate");
          const match = page.getByRole("menuitemradio", { name: "Renamed teammate", exact: true });
          await expectBrowser(match).toBeVisible();
          await expectBrowser(page.getByRole("menuitemradio")).toHaveCount(1);
          await captureProof(page, `directory-${width}-renamed`);
          await search.press("ArrowDown");
          await expectBrowser(match).toBeFocused();
          await page.keyboard.press("Enter");
          await expectAssignmentRequest(gateway, "profile-teammate-0999");
        },
      );
    },
  );

  it("themes the assignee submenu with the active palette", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await page.addInitScript(
          ({ gatewayUrl }) => {
            localStorage.setItem(
              `openclaw.control.settings.v1:${gatewayUrl}`,
              JSON.stringify({ gatewayUrl, theme: "dash", themeMode: "dark" }),
            );
          },
          { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl) },
        );
        await installOwnerGateway(page);
        await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dash");

        const row = page.locator(`[data-session-key="${sessionKey}"]`);
        await row.hover();
        await row.click({ button: "right" });
        const assignTo = page.getByRole("menuitem", { name: "Assign to…", exact: true });
        await assignTo.hover();
        await assignTo.getByRole("menuitemradio", { name: "Me", exact: true }).waitFor();

        const paint = await readThemedPopupPaint(assignTo, "submenu");
        await captureProof(page, "assignee-submenu");
        expect(paint.actual).toEqual(paint.expected);
      },
    );
  });

  it("retries the header directory in place and keeps a rejected assignment visible", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installOwnerGateway(page);
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const menuTrigger = activePane.getByRole("button", { name: "Actions for Owner outcome" });
        await gateway.deferNext("users.list");
        await menuTrigger.press("Enter");
        const assignTo = page.getByRole("menuitem", { name: "Assign to…", exact: true });
        await assignTo.hover();
        await gateway.waitForRequest("users.list");
        const expectCurrentOwner = async (phase: string) => {
          await captureProof(page, `header-directory-${phase}`);
          expect
            .soft(
              await assignTo.getByRole("menuitemradio", { name: "Bob", exact: true }).isVisible(),
            )
            .toBe(true);
          const selectedOwners = await assignTo
            .getByRole("menuitemradio", { checked: true })
            .evaluateAll((owners) =>
              owners.map((owner) => ({
                label: owner.querySelector(".session-menu__text")?.textContent?.trim(),
                disabled: owner.hasAttribute("disabled"),
              })),
            );
          expect.soft(selectedOwners).toEqual([{ label: "Bob", disabled: true }]);
        };
        await expectBrowser(assignTo).toContainText("Loading");
        await expectCurrentOwner("pending");
        const directoryError = "The team directory is temporarily unavailable.";
        await gateway.rejectDeferred("users.list", {
          code: "UNAVAILABLE",
          message: directoryError,
        });
        await expectBrowser(assignTo.getByRole("alert")).toContainText(directoryError);
        await expectCurrentOwner("failed");
        await assignTo.getByRole("menuitem", { name: "Retry", exact: true }).click();
        await expectBrowser(menuTrigger).toHaveAttribute("aria-expanded", "true");
        await expectBrowser(
          assignTo.getByRole("menuitemradio", { name: "Carol", exact: true }),
        ).toBeVisible();
        await expectBrowser(assignTo.getByRole("menuitemradio")).toHaveCount(4);
        await chooseMe(page);
        await expectAssignmentRequest(gateway);

        const message = "Owner assignment rejected for visible outcome proof.";
        await gateway.rejectDeferred("sessions.assignOwner", {
          code: "INVALID_REQUEST",
          message,
        });
        await captureProof(page, "header");

        await expectBrowser(
          activePane.getByRole("alert").filter({ hasText: message }),
        ).toBeVisible();
        await expectBrowser(
          activePane.getByRole("img", { name: "Created by Bob", exact: true }),
        ).toHaveCount(1);
      },
    );
  });

  it("keeps a rejected sidebar owner assignment visible", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installOwnerGateway(page);
      const row = page.locator(`[data-session-key="${sessionKey}"]`);
      await row.hover();
      await row.click({ button: "right" });
      await chooseMe(page);
      await expectAssignmentRequest(gateway);

      const message = "Sidebar owner assignment rejected for visible outcome proof.";
      await gateway.rejectDeferred("sessions.assignOwner", {
        code: "INVALID_REQUEST",
        message,
      });

      await expectBrowser(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
      await expectBrowser(
        row.getByRole("img", { name: "Created by Bob", exact: true }),
      ).toHaveCount(1);
    });
  });
});
