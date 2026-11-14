import { withTimeout } from "@openclaw/fs-safe/advanced";
import type { Locator, Page, Request, Response } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { recordControlUiE2eFailureFacts } from "../test-helpers/control-ui-e2e-diagnostics.ts";
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
import {
  openSessionMenuSubmenu,
  sessionMenuLabels,
  sessionMenuSubmenu,
} from "./session-management.test-support.ts";
import { routeAvatarFixtures } from "./session-ownership-visuals.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session owner assignment mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const ownerNames = ["Me", "OpenClaw", "Bob", "Carol"];
const sessionKey = "agent:main:dashboard:owner-outcome";
function sessionsListResponse(archived = false) {
  const row = (key: string, label: string, id: string, name: string, updatedAt: number) => {
    const actor = { type: "human", id, label: name };
    return { key, kind: "direct", label, createdActor: actor, owner: { actor }, updatedAt };
  };
  return {
    count: 2,
    owners: [
      { type: "human" as const, id: "profile-ada", label: "Ada" },
      { type: "human" as const, id: "profile-bob", label: "Bob" },
    ],
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      row("agent:main:ada-research", "Ada research", "profile-ada", "Ada", 2),
      { ...row(sessionKey, "Owner outcome", "profile-bob", "Bob", 1), archived },
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

async function installOwnerGateway(
  page: Page,
  archived = false,
  extraNames: string[] = [],
  initialPage: "chat" | "sessions" = "chat",
) {
  await routeAvatarFixtures(page, [{ id: "profile-ada", background: "#7c3aed", label: "A" }]);
  const result = sessionsListResponse(archived);
  const gateway = await installMockGateway(page, {
    featureMethods: [
      "chat.startup",
      "sessions.assignOwner",
      "sessions.create",
      "sessions.patch",
      "users.list",
    ],
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
    initialPage === "sessions"
      ? `${suite.server.baseUrl}sessions`
      : archived
        ? `${suite.server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`
        : controlUiSessionUrl(suite.server.baseUrl, sessionKey),
  );
  if (initialPage === "chat") {
    await page.getByText("Owner assignment outcome proof.", { exact: true }).waitFor();
  }
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

async function expectAssignmentAvatarLayout(page: Page, compact = false): Promise<void> {
  const rows = ownerChoices(page, compact);
  const choices = rows.filter({ has: page.locator(".session-menu__avatar") });
  await expectBrowser(choices).toHaveCount((await rows.count()) - (compact ? 1 : 0));
  const layout = await choices.evaluateAll(
    (items, isCompact) =>
      items.map((item) => {
        const avatar = item.querySelector(".viewer-avatar")!;
        const slot = item.querySelector(".session-menu__avatar")!;
        const label = item.querySelector(
          isCompact ? ":scope > span:not([aria-hidden])" : ".session-menu__text",
        )!;
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
    compact,
  );
  expect(layout.length).toBeGreaterThan(0);
  for (const avatar of layout) {
    expect(avatar).toMatchObject({ width: "24px", height: "24px", square: true, contained: true });
    expect(avatar.gap).toBeGreaterThanOrEqual(5.5);
  }
}

async function chooseMe(page: Page): Promise<void> {
  const action = assignee(page, "Me");
  await action.waitFor({ state: "visible" });
  await action.click();
}

function menuItem(scope: Page | Locator, name: string) {
  return scope.getByRole("menuitem", { name, exact: true });
}

function assignee(scope: Page | Locator, name: string, compact = false) {
  return compact
    ? scope.getByRole("button", { name, exact: true })
    : scope
        .getByRole("menuitemradio", { name, exact: true })
        .or(scope.getByRole("radio", { name, exact: true }));
}

function ownerChoices(page: Page, compact: boolean) {
  return compact
    ? page.locator(".session-actions-page:visible button[aria-pressed]")
    : page.getByRole("menuitemradio");
}

async function confirmOwner(
  gateway: Awaited<ReturnType<typeof installOwnerGateway>>,
  label: string,
) {
  const owner = { actor: { type: "human", id: `profile-${label.toLowerCase()}`, label } };
  const result = sessionsListResponse();
  await gateway.setSessionsListResponse({
    ...result,
    sessions: result.sessions.map((session) =>
      session.key === sessionKey ? Object.assign(session, { owner }) : session,
    ),
  });
  await gateway.resolveDeferred("sessions.assignOwner", { ok: true, key: sessionKey, owner });
}

function ownerControls(page: Page) {
  const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
  const row = page.locator(`[data-session-key="${sessionKey}"]`);
  const assignTo = page.getByRole("menuitem", { name: /^Assign to…?$/u });
  return {
    activePane,
    row,
    assignTo,
    panel: sessionMenuSubmenu(assignTo),
    trigger: activePane.getByRole("button", { name: "Actions for Owner outcome", exact: true }),
  };
}

async function openSessionActions(page: Page, surface: string) {
  const { row, trigger } = ownerControls(page);
  if (surface === "sidebar") {
    await selectAllSidebarSessions(page);
    await row.hover();
    await row.click({ button: "right" });
  } else {
    await trigger.click();
  }
}

async function expandAssignment(assignTo: Locator, compact: boolean) {
  if (compact) {
    await assignTo.click();
  } else {
    await assignTo.hover();
  }
}

suite.define(() => {
  it.each(["sidebar", "header"])(
    "filters the hovered assignment submenu from the %s without clicking search",
    (surface) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installOwnerGateway(page);
        await openSessionActions(page, surface);
        const { assignTo, panel } = ownerControls(page);
        await assignTo.hover();
        const search = panel.getByRole("searchbox");
        await expectBrowser(panel.locator(".header-search__toggle")).toBeVisible();
        await page.keyboard.type("zz");
        await expectBrowser(search).toHaveValue("zz");
        await expectBrowser(panel).toContainText("No matching people or agents");
        await page.keyboard.press("Escape");
        await expectBrowser(search).toBeHidden();
        await page.keyboard.type("carol");
        await expectBrowser(search).toHaveValue("carol");
        await expectBrowser(search).toBeFocused();
        await expectBrowser(panel.locator('[role="menuitemradio"] .session-menu__text')).toHaveText(
          ["Carol"],
        );
        expect(await gateway.getRequests("sessions.assignOwner")).toHaveLength(0);
        await page.keyboard.press("ArrowDown");
        await expectBrowser(assignee(panel, "Carol")).toBeFocused();
        await page.keyboard.press("Enter");
        await expectAssignmentRequest(gateway, "profile-carol");
      }),
  );

  it.each([1280, 390])(
    "keeps the Sessions page owner selected and assignment failures visible at width %i",
    (width) =>
      suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          const gateway = await installOwnerGateway(page, false, [], "sessions");
          const roster = page.locator("openclaw-sessions-page");
          const row = roster.locator("tbody tr").filter({
            has: page.getByRole("checkbox", { name: `Select session: ${sessionKey}`, exact: true }),
          });
          await row.getByRole("button", { name: "Open session menu" }).click();
          const assignTo = page.getByRole("menuitem", { name: /^Assign to…?$/u });
          await expandAssignment(assignTo, width < 560);
          const current = assignee(page, "Bob");
          await current.waitFor();
          expect.soft(await current.getAttribute("aria-checked")).toBe("true");
          expect.soft(await current.isDisabled()).toBe(true);
          await chooseMe(page);
          const request = await gateway.waitForRequest("sessions.assignOwner");
          expect(request.params).toEqual({
            key: sessionKey,
            owner: { type: "human", id: "profile-ada" },
          });
          const message = "Owner assignment unavailable. Try again.";
          await gateway.rejectDeferred("sessions.assignOwner", { code: "UNAVAILABLE", message });
          await expectBrowser(roster.getByRole("alert").filter({ hasText: message })).toBeVisible();
          await expectBrowser(row).toContainText("Owner outcome");
        },
      ),
  );

  it.each(["sidebar", "header"] as const)(
    "moves from a tall assignee submenu to sibling rows and back from the %s",
    (surface) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installOwnerGateway(
          page,
          false,
          Array.from({ length: 40 }, (_, index) => `Teammate ${index + 1}`),
        );
        await openSessionActions(page, surface);
        const { assignTo, panel } = ownerControls(page);
        const sibling = menuItem(page, "Move to group");
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
        const me = assignee(panel, "Me");
        await expectBrowser(me).toBeVisible();

        // Native pointer steps matter: locator.hover retries around intercepting overlays.
        await page.mouse.move(target!.x + target!.width - 24, target!.y + target!.height / 2, {
          steps: 12,
        });
        await expectBrowser(assignTo).toHaveAttribute("aria-expanded", "false");
        await expect
          .poll(() => sibling.evaluate((element) => element.matches(":hover")))
          .toBe(true);
        await expectBrowser(me).toBeHidden();
        await expect
          .poll(() => sibling.evaluate((element) => getComputedStyle(element).backgroundColor))
          .not.toBe(inactiveBackground);

        await expectBrowser(sibling).toHaveAttribute("aria-expanded", "true");
        await assignTo.hover();
        await expectBrowser(sibling).toHaveAttribute("aria-expanded", "false");
        await expectBrowser(me).toBeVisible();

        const advanced = menuItem(page, "Advanced");
        await advanced.hover();
        await expectBrowser(advanced).toHaveAttribute("aria-expanded", "true");
        await assignTo.hover();
        await expectBrowser(advanced).toHaveAttribute("aria-expanded", "false");
        await expectBrowser(me).toBeVisible();

        // Follow a paced diagonal from the submenu-facing edge into a non-first
        // choice. The native menu owner must keep the destination usable.
        const choice = assignee(panel, "Carol");
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
      }),
  );

  it("assigns named and self owners through one themed keyboard-accessible submenu", () =>
    suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme: "dark" },
      async ({ page }) => {
        const avatarRequests = {
          avatarRequests: 0,
          avatarResponses: 0,
          avatarRequestFailures: 0,
          avatarResponseStatus: 0,
          avatarResponseImageMime: false,
        };
        const isAvatarRequest = (request: Request) =>
          new URL(request.url()).pathname === "/api/users/profile-ada/avatar";
        const onAvatarRequest = (request: Request) => {
          if (isAvatarRequest(request)) {
            avatarRequests.avatarRequests += 1;
          }
        };
        const onAvatarResponse = (response: Response) => {
          if (!isAvatarRequest(response.request())) {
            return;
          }
          avatarRequests.avatarResponses += 1;
          avatarRequests.avatarResponseStatus = response.status();
          avatarRequests.avatarResponseImageMime =
            response.headers()["content-type"]?.startsWith("image/") ?? false;
        };
        const onAvatarFailure = (request: Request) => {
          if (isAvatarRequest(request)) {
            avatarRequests.avatarRequestFailures += 1;
          }
        };
        const stopAvatarDiagnostics = () => {
          page.off("request", onAvatarRequest);
          page.off("response", onAvatarResponse);
          page.off("requestfailed", onAvatarFailure);
        };
        page.on("request", onAvatarRequest);
        page.on("response", onAvatarResponse);
        page.on("requestfailed", onAvatarFailure);
        page.once("close", stopAvatarDiagnostics);
        await page.addInitScript(
          ({ gatewayUrl }) => {
            localStorage.setItem(
              `openclaw.control.settings.v1:${gatewayUrl}`,
              JSON.stringify({ gatewayUrl, theme: "dash", themeMode: "dark" }),
            );
          },
          { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl) },
        );
        const gateway = await installOwnerGateway(page);
        await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dash");
        await selectAllSidebarSessions(page);
        const row = page.locator(`[data-session-key="${sessionKey}"]`);
        await row.hover();
        const trigger = row.locator(".sidebar-recent-session__link");
        await row.click({ button: "right" });

        const menu = page.locator("openclaw-session-menu");
        await expect
          .poll(async () =>
            (await sessionMenuLabels(menu.locator(".session-menu__panel"))).filter((label) =>
              label.startsWith("Assign to"),
            ),
          )
          .toEqual(["Assign to…"]);
        const assignTo = menuItem(menu, "Assign to…");
        const panel = sessionMenuSubmenu(assignTo);
        await openSessionMenuSubmenu(page, "Assign to…");
        const ownerItems = panel.locator('[role="menuitemradio"] .session-menu__text');
        await expectBrowser(ownerItems).toHaveText(ownerNames);
        const paint = await readThemedPopupPaint(panel, "surface");
        expect(paint.actual).toEqual(paint.expected);
        const selfAvatar = assignee(panel, "Me").locator("openclaw-viewer-avatar img");
        try {
          await expectBrowser(selfAvatar).toHaveCount(1);
          await expect
            .poll(() => selfAvatar.evaluate((image) => (image as HTMLImageElement).naturalWidth))
            .toBeGreaterThan(0);
        } catch (error) {
          recordControlUiE2eFailureFacts(page, avatarRequests);
          await withTimeout(
            page.evaluate(() => {
              const browserMenu = document.querySelector("openclaw-session-menu");
              const browserTrigger = browserMenu?.querySelector(
                '[role="menuitem"][aria-label="Assign to…"]',
              );
              const browserPanel =
                browserTrigger?.parentElement?.querySelector(':scope > [role="menu"]');
              const me = browserPanel?.querySelector(
                '[data-value="assign-owner:human:profile-ada"]',
              );
              const avatar = me?.querySelector("openclaw-viewer-avatar");
              const user = avatar?.user;
              const face = avatar?.querySelector(".viewer-avatar");
              const image = avatar?.querySelector("img");
              return {
                ownerMenuPresent: Boolean(browserMenu),
                ownerTriggerExpanded: browserTrigger?.getAttribute("aria-expanded") === "true",
                ownerPanelVisible:
                  browserPanel?.checkVisibility({ visibilityProperty: true }) ?? false,
                ownerMePresent: Boolean(me),
                avatarHostPresent: Boolean(avatar),
                avatarUserPresent: Boolean(user),
                avatarUserMatchesFixture: user?.id === "profile-ada",
                avatarUrlPresent: Boolean(user?.avatarUrl),
                avatarUrlMatchesFixture: user?.avatarUrl === "/api/users/profile-ada/avatar?v=1",
                avatarFailed: face?.getAttribute("data-avatar-state") === "failed",
                avatarImagePresent: Boolean(image),
                avatarImageComplete: image?.complete ?? false,
                avatarImageDecoded: (image?.naturalWidth ?? 0) > 0,
              };
            }),
            1_000,
          )
            .then((facts) => recordControlUiE2eFailureFacts(page, facts))
            .catch(() => undefined);
          throw error;
        } finally {
          stopAvatarDiagnostics();
          page.off("close", stopAvatarDiagnostics);
        }
        await expectAssignmentAvatarLayout(page);
        await expectBrowser(assignTo.locator(".session-menu__icon")).toHaveCSS("width", "15px");
        await expectBrowser(assignTo.locator(".session-menu__icon svg")).toHaveCSS("width", "15px");
        await assignee(panel, "Carol").click();
        await expectAssignmentRequest(gateway, "profile-carol");
        await confirmOwner(gateway, "Carol");

        await gateway.deferNext("sessions.assignOwner");
        await row.hover();
        await trigger.press("Shift+F10");
        await openSessionMenuSubmenu(page, "Assign to…");
        const keyboardAssignTo = menuItem(page, "Assign to…");
        await expectBrowser(assignee(page, "Me")).toBeFocused();
        await page.keyboard.press("Escape");
        await expectBrowser(keyboardAssignTo).toHaveAttribute("aria-expanded", "false");
        await expectBrowser(keyboardAssignTo).toBeFocused();
        await page.keyboard.press("Escape");
        await expectBrowser(menu).toHaveCount(0);
        await expectBrowser(trigger).toBeFocused();
        await trigger.press("Shift+F10");
        await openSessionMenuSubmenu(page, "Assign to…");
        await expectBrowser(keyboardAssignTo).toHaveAttribute("aria-expanded", "true");
        await expectBrowser(assignee(page, "Me")).toBeFocused();
        await page.keyboard.press("Enter");
        await expectAssignmentRequest(gateway, "profile-ada", 1);
        await confirmOwner(gateway, "Ada");
        await row.hover();
        await row.click({ button: "right" });
        const selfAssignment = menuItem(page, "Assign to…");
        await selfAssignment.hover();
        const checked = sessionMenuSubmenu(selfAssignment).locator(
          '[role="menuitemradio"][aria-checked="true"]',
        );
        await expectBrowser(checked).toHaveCount(1);
        await expectBrowser(checked.locator(".session-menu__text")).toHaveText("Me");
        await expectBrowser(
          sessionMenuSubmenu(selfAssignment).locator('[role="menuitemradio"] .session-menu__text'),
        ).toHaveText(ownerNames);
      },
    ));

  it.each([
    { surface: "sidebar", width: 1280 },
    { surface: "header", width: 1280 },
    { surface: "compact header", width: 390 },
  ])("assigns an archived session to an offline teammate from the $surface", ({ surface, width }) =>
    suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { height: 900, width } },
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
        await openSessionActions(page, surface);
        const { assignTo } = ownerControls(page);
        const compact = surface === "compact header";
        await expandAssignment(assignTo, compact);
        await assignee(page, "Me", compact).waitFor();
        await expectBrowser(
          ownerChoices(page, compact).locator(
            compact ? ":scope > span:not([aria-hidden])" : ".session-menu__text",
          ),
        ).toHaveText([...(compact ? ["Unassigned"] : []), ...ownerNames, ...extraNames]);
        if (compact) {
          const unassigned = assignee(page, "Unassigned", true);
          await expectBrowser(unassigned).toBeDisabled();
          await expectBrowser(unassigned).toHaveAttribute("aria-pressed", "false");
          const selected = assignee(page, "Bob", true);
          await expectBrowser(selected).toBeDisabled();
          await expectBrowser(selected).toHaveAttribute("aria-pressed", "true");
        }
        await expectAssignmentAvatarLayout(page, compact);
        const target = extraNames.at(-1) ?? "Carol";
        if (extraNames.length > 0) {
          await page.locator(".header-search__toggle:visible").last().click();
          await page.getByRole("searchbox", { name: "Search people and agents…" }).fill(target);
          await expectBrowser(page.locator('button[value^="assign-owner:"]:visible')).toHaveCount(
            1,
          );
        }
        const owner = assignee(page, target, compact);
        await owner.scrollIntoViewIfNeeded();
        await expectBrowser(owner).toBeInViewport();
        await owner.click();
        await expectAssignmentRequest(
          gateway,
          `profile-${target.toLowerCase().replaceAll(" ", "-")}`,
        );
      },
    ),
  );

  it.each([1280, 390])(
    "assigns a renamed teammate from a 1,000-person directory at width %i",
    (width) =>
      suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          const compact = width < 560;
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
            const assignTo = page.getByRole("menuitem", { name: /^Assign to…?$/u });
            await expandAssignment(assignTo, compact);
          };
          await openAssignment();
          if (compact) {
            const unassigned = assignee(page, "Unassigned", true);
            await expectBrowser(unassigned).toBeDisabled();
            await expectBrowser(unassigned).toHaveAttribute("aria-pressed", "false");
          }
          await page.locator(".header-search__toggle:visible").last().click();
          const search = page.getByRole("searchbox", { name: "Search people and agents…" });
          await search.fill("Teammate 0999");
          await gateway.resolveDeferred("users.list", directoryResponse(names));
          await expectBrowser(search).toHaveValue("Teammate 0999");
          await expectBrowser(ownerChoices(page, compact)).toHaveCount(compact ? 2 : 1);
          await search.clear();
          await expectBrowser(ownerChoices(page, compact)).toHaveCount(compact ? 1005 : 1004);
          await search.fill("Teammate 0999");
          await search.press("Escape");
          await expectBrowser(search).toBeHidden();
          await page.keyboard.press("Escape");
          if (width < 560) {
            await expectBrowser(page.locator(".session-actions-page")).toBeHidden();
            await expectBrowser(trigger).toBeFocused();
          } else {
            await expectBrowser(trigger).toHaveAttribute("aria-expanded", "true");
            const assignment = menuItem(page, "Assign to…");
            await expectBrowser(assignment).toHaveAttribute("aria-expanded", "false");
            await page.keyboard.press("Escape");
          }
          await expectBrowser(trigger).toHaveAttribute("aria-expanded", "false");

          const directory = directoryResponse(names);
          const renamed = directory.profiles.find(
            (profile) => profile.id === "profile-teammate-0999",
          )!;
          renamed.displayName = "Renamed teammate";
          renamed.updatedAt = 2;
          await gateway.setMethodResponse("users.list", directory);
          await openAssignment();
          await page.locator(".header-search__toggle:visible").last().click();
          await search.fill("Renamed teammate");
          const match = assignee(page, "Renamed teammate", compact);
          await expectBrowser(match).toBeVisible();
          await expectBrowser(ownerChoices(page, compact)).toHaveCount(compact ? 2 : 1);
          await search.press(width < 560 ? "Tab" : "ArrowDown");
          if (width < 560) {
            await page.keyboard.press("Tab");
          }
          await expectBrowser(match).toBeFocused();
          await page.keyboard.press("Enter");
          await expectAssignmentRequest(gateway, "profile-teammate-0999");
        },
      ),
  );

  it.each(["header", "sidebar"] as const)(
    "keeps rejected owner assignments visible from the %s, retrying a failed header directory",
    (surface) =>
      suite.withPage(
        {
          ...createControlUiE2eContextOptions(),
          ...(surface === "header" ? { colorScheme: "dark" as const } : {}),
        },
        async ({ page }) => {
          const gateway = await installOwnerGateway(page);
          const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
          const row = page.locator(`[data-session-key="${sessionKey}"]`);
          if (surface === "header") {
            const menuTrigger = activePane.getByRole("button", {
              name: "Actions for Owner outcome",
            });
            await gateway.deferNext("users.list");
            await menuTrigger.press("Enter");
            const { assignTo, panel } = ownerControls(page);
            await assignTo.hover();
            await expectBrowser(panel).toBeVisible();
            await gateway.waitForRequest("users.list");
            const expectCurrentOwner = async () => {
              expect.soft(await assignee(panel, "Bob").isVisible()).toBe(true);
              const selectedOwners = await panel
                .getByRole("menuitemradio", { checked: true })
                .evaluateAll((owners) =>
                  owners.map((owner) => ({
                    label: owner.querySelector(".session-menu__text")?.textContent?.trim(),
                    disabled: owner.hasAttribute("disabled"),
                  })),
                );
              expect.soft(selectedOwners).toEqual([{ label: "Bob", disabled: true }]);
            };
            await expectBrowser(panel).toContainText("Loading");
            await expectCurrentOwner();
            const directoryError = "The team directory is temporarily unavailable.";
            await gateway.rejectDeferred("users.list", {
              code: "UNAVAILABLE",
              message: directoryError,
            });
            await expectBrowser(panel.getByRole("alert")).toContainText(directoryError);
            await expectCurrentOwner();
            await menuItem(panel, "Retry").click();
            await expectBrowser(menuTrigger).toHaveAttribute("aria-expanded", "true");
            await expectBrowser(assignee(panel, "Carol")).toBeVisible();
            await expectBrowser(panel.getByRole("menuitemradio")).toHaveCount(4);
          } else {
            await selectAllSidebarSessions(page);
            await row.hover();
            await row.click({ button: "right" });
            await openSessionMenuSubmenu(page, "Assign to…");
          }
          await chooseMe(page);
          await expectAssignmentRequest(gateway);
          const message =
            surface === "header"
              ? "Owner assignment rejected for visible outcome proof."
              : "Sidebar owner assignment rejected for visible outcome proof.";
          await gateway.rejectDeferred("sessions.assignOwner", {
            code: "INVALID_REQUEST",
            message,
          });
          await expectBrowser(
            (surface === "header" ? activePane : page)
              .getByRole("alert")
              .filter({ hasText: message }),
          ).toBeVisible();
          if (surface === "header") {
            await openSessionActions(page, surface);
            await openSessionMenuSubmenu(page, "Assign to…");
            const { panel } = ownerControls(page);
            const retainedOwner = assignee(panel, "Bob");
            await expectBrowser(retainedOwner).toHaveAttribute("aria-checked", "true");
            await expectBrowser(retainedOwner).toBeDisabled();
          } else {
            await expectBrowser(
              row.getByRole("img", { name: "Created by Bob", exact: true }),
            ).toHaveCount(1);
          }
        },
      ),
  );
});
