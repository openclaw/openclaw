import type { Page } from "playwright";
import { it, expect } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../src/gateway/control-ui-contract.js";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import {
  actionOpacity,
  createSessionManagementE2eSuite,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const pullRequests = {
  featureMethods: ui.sessionMethods("sessions.patch", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD),
  methodResponses: { [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true } },
};
async function showPullRequests(
  page: Page,
  rows: ReturnType<typeof sessionRow>[],
  key: string,
  state: "open" | "merged",
  preview: boolean,
) {
  await page.addInitScript((show) => {
    localStorage.setItem("openclaw:sidebar:sessions:show-preview", String(show));
  }, preview);
  await ui.installSessionRows(page, rows, { ...pullRequests, sessionKey: "agent:main:main" });
  await page.goto(`${suite.server.baseUrl}chat`);
  const toggle = page.locator('[data-session-section="work"] .sidebar-session-group-toggle');
  await ui.visible(toggle);
  await toggle.click();
  await seedPullRequestSummary(page, key, state);
  return toggle;
}

async function seedPullRequestSummary(page: Page, key: string, state: "open" | "merged") {
  await evaluateControlUiContext(
    page,
    (context, summary) => {
      context.sessions.setPullRequestSummary(summary.key, {
        numbers: [1],
        state: summary.state,
      });
    },
    { key, state },
  );
}

const touchOptions = {
  ...createControlUiE2eContextOptions(),
  hasTouch: true,
};

suite.define(() => {
  it("keeps action-only text stable and active state visible with actions", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page, context }) => {
      await ui.installSessionRows(
        page,
        [
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:hover-actions",
            "A deliberately long action-only sidebar title",
            Date.now() - 1,
          ),
          sessionRow("agent:main:hover-active", "Hover active", Date.now() - 1, {
            hasActiveRun: true,
            status: "running",
            unread: true,
          }),
          sessionRow("agent:main:hover-queued", "Hover queued", Date.now() - 2, {
            hasActiveRun: true,
            status: "queued",
            unread: true,
          }),
        ],
        { sessionKey: "agent:main:main" },
      );

      await page.goto(`${suite.server.baseUrl}chat`);
      const actionOnlyRow = page.locator('[data-session-key="agent:main:hover-actions"]');
      await ui.visible(actionOnlyRow, 10_000);
      const actionOnlyText = actionOnlyRow.locator(".sidebar-recent-session__text");
      const actionOnlyLink = actionOnlyRow.locator(".sidebar-recent-session__link");
      const actionOnlyPin = ui.button(actionOnlyRow, "Pin session", false);
      await ui
        .pollAttribute(actionOnlyRow, "class")
        .toContain("sidebar-recent-session--single-line");
      await ui.expectRightPadding(actionOnlyLink, "2px");
      const restingTextBounds = await ui.bounds(actionOnlyText);

      await ui.forEachActionMode(page, actionOnlyRow, [actionOnlyPin], async () => {
        await ui.expectRightPadding(actionOnlyText, "52px");
        expect((await ui.bounds(actionOnlyText)).width).toBeCloseTo(restingTextBounds.width, 1);
      });

      const row = page.locator('[data-session-key="agent:main:hover-active"]');
      await ui.visible(row, 10_000);
      const accessibility = await context.newCDPSession(page);
      const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
      for (const [title, activity] of [
        ["Hover active", "Active run"],
        ["Hover queued", "Queued"],
      ] as const) {
        const linkNode = nodes.find(
          (node) => node.role?.value === "link" && node.name?.value.includes(title),
        );
        expect(linkNode).toBeDefined();
        const announced = `${linkNode?.name?.value} ${linkNode?.description?.value ?? ""}`;
        expect.soft(announced.match(new RegExp(activity, "g"))).toHaveLength(1);
        expect.soft(announced.match(/Unread/g)).toHaveLength(1);
      }
      await accessibility.detach();
      const state = row.locator(".sidebar-session-indicator .session-glyph__ring");
      const pin = ui.button(row, "Pin session", false);
      const menu = row.locator("[data-sidebar-session-archive]");
      await expect.poll(() => state.isVisible()).toBe(true);
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await page.mouse.move(500, 500);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

      await page.addStyleTag({ content: ".session-glyph__ring { animation: none !important; }" });
      const glyph = row.locator(".sidebar-session-indicator .session-glyph");
      const [restingNameBounds, restingGlyphBounds, restingStateBounds] = await Promise.all([
        ui.bounds(row.locator(".sidebar-recent-session__name")),
        ui.bounds(glyph),
        ui.bounds(state),
      ]);

      // A glyph-less row draws the compact 12px ring centered in its 20px lead
      // slot; the title keeps its 8px distance from the slot, not from the ring.
      expect(restingStateBounds.width).toBeCloseTo(12, 1);
      expect(restingStateBounds.x + restingStateBounds.width / 2).toBeCloseTo(
        restingGlyphBounds.x + restingGlyphBounds.width / 2,
        1,
      );
      expect(restingNameBounds.x - ui.right(restingGlyphBounds)).toBeCloseTo(8, 1);

      await ui.forEachActionMode(page, row, [state, pin, menu], async () => {
        const [nameBounds, pinBounds, menuBounds] = await Promise.all([
          ui.bounds(row.locator(".sidebar-recent-session__name")),
          ui.bounds(pin),
          ui.bounds(menu),
        ]);
        expect(ui.centerY(nameBounds)).toBeCloseTo(ui.centerY(pinBounds), 1);
        expect(ui.right(pinBounds)).toBeLessThanOrEqual(menuBounds.x);
      });
    }));

  it("keeps fork provenance in the title above always-visible touch actions", () =>
    suite.withPage(touchOptions, async ({ page }) => {
      await ui.installSessionRows(
        page,
        [
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:touch-forked",
            "A deliberately long non-running touch session title that must not overlap controls",
            Date.now() - 1,
            {
              forkSource: { sessionKey: "agent:main:main", sessionId: "source-session" },
            },
          ),
        ],
        { sessionKey: "agent:main:main" },
      );

      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:touch-forked"]');
      await ui.visible(row, 10_000);
      const fork = row.locator(".sidebar-recent-session__name .sidebar-session-fork-indicator");
      const pin = ui.button(row, "Pin session", false);
      const menu = row.locator("[data-sidebar-session-archive]");
      await expect.poll(() => fork.isVisible()).toBe(true);
      await ui.expectCount(row.locator(".session-row-state"), 0);

      const [nameBounds, forkBounds, pinBounds, menuBounds] = await Promise.all([
        ui.bounds(row.locator(".sidebar-recent-session__name")),
        ui.bounds(fork),
        ui.bounds(pin),
        ui.bounds(menu),
      ]);

      expect(Math.abs(ui.centerY(forkBounds) - ui.centerY(nameBounds))).toBeLessThanOrEqual(2);
      expect(ui.centerY(nameBounds)).toBeCloseTo(ui.centerY(pinBounds), 1);
      expect(ui.right(nameBounds)).toBeLessThanOrEqual(pinBounds.x + 1);
      expect(ui.right(pinBounds)).toBeLessThanOrEqual(menuBounds.x);
    }));

  it("keeps unread glyph badges visible while PR icons yield to hover actions", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page, context }) => {
      const plainKey = "agent:main:unread-plain";
      const pullRequestKey = "agent:main:unread-pr";

      const codingToggle = await showPullRequests(
        page,
        [
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(plainKey, "Inbox triage", Date.now() - 1, { unread: true, icon: "📬" }),
          sessionRow(pullRequestKey, "Fix login", Date.now() - 2, {
            unread: true,
            icon: "📬",
            worktree: {
              id: "unread-pr-worktree",
              branch: "fix/unread-pr",
              repoRoot: "/tmp/openclaw",
            },
          }),
        ],
        pullRequestKey,
        "merged",
        false,
      );

      const plainRow = page.locator(`[data-session-key="${plainKey}"]`);
      const pullRequestRow = page.locator(`[data-session-key="${pullRequestKey}"]`);
      await ui.visible(plainRow, 10_000);
      await expect
        .poll(() => pullRequestRow.locator("[data-pull-request-state='merged']").isVisible())
        .toBe(true);

      const badgeInsetFromGlyphRight = async (row: typeof plainRow) => {
        const [glyphBounds, badgeBounds] = await Promise.all([
          ui.bounds(row.locator(".sidebar-session-indicator .session-glyph")),
          ui.bounds(row.locator(".sidebar-session-indicator .session-glyph__badge--unread")),
        ]);

        expect(badgeBounds).toMatchObject({ width: 8, height: 8 });
        expect(badgeBounds.y).toBeCloseTo(glyphBounds.y - 1, 1);
        return ui.right(glyphBounds) - ui.right(badgeBounds);
      };
      // Trailing metadata cannot move unread off the row's own glyph corner.
      expect(await badgeInsetFromGlyphRight(pullRequestRow)).toBeCloseTo(-1, 1);
      expect(await badgeInsetFromGlyphRight(pullRequestRow)).toBeCloseTo(
        await badgeInsetFromGlyphRight(plainRow),
        1,
      );
      const pullRequestIcon = pullRequestRow.locator("[data-pull-request-state='merged']");
      const unreadBadge = pullRequestRow.locator(
        ".sidebar-session-indicator .session-glyph__badge--unread",
      );
      expect(await pullRequestRow.locator(".session-row-state").count()).toBe(0);
      const badgeBounds = await ui.bounds(unreadBadge);
      const accessibility = await context.newCDPSession(page);
      const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
      for (const title of ["Inbox triage", "Fix login"]) {
        const linkNode = nodes.find(
          (node) => node.role?.value === "link" && node.name?.value.includes(title),
        );
        expect(linkNode).toBeDefined();
        expect(
          `${linkNode?.name?.value} ${linkNode?.description?.value ?? ""}`.match(/Unread/g),
        ).toHaveLength(1);
        expect(linkNode?.description?.value ?? "").not.toContain("Unread");
      }
      await accessibility.detach();

      // Resting PR state takes the archive action's column, not the sidebar edge.
      await plainRow.hover();
      const plainArchive = plainRow.locator("[data-sidebar-session-archive] svg");
      await ui.visible(plainArchive);
      expect(ui.centerX(await ui.bounds(pullRequestIcon.locator(".session-css-icon")))).toBeCloseTo(
        ui.centerX(await ui.bounds(plainArchive)),
        1,
      );

      await pullRequestRow.hover();

      await pullRequestIcon.waitFor({ state: "hidden" });
      await pullRequestRow.locator(".session-row-badges").waitFor({ state: "hidden" });
      await ui.visible(unreadBadge);
      expect(await ui.bounds(unreadBadge)).toEqual(badgeBounds);
      await page.mouse.move(0, 0);
      await ui.visible(pullRequestIcon);
      await ui.visible(unreadBadge);
      await pullRequestRow.locator("[data-sidebar-session-archive]").focus();
      await pullRequestIcon.waitFor({ state: "hidden" });
      await pullRequestRow.locator(".session-row-badges").waitFor({ state: "hidden" });
      await ui.visible(unreadBadge);
      expect(await ui.bounds(unreadBadge)).toEqual(badgeBounds);
      await codingToggle.focus();
      await ui.visible(pullRequestIcon);
      await ui.visible(unreadBadge);
    }));

  it("does not widen desktop session text when hover actions appear beside trailing state", () =>
    ui.withSessionPage(suite, async (page) => {
      await showPullRequests(
        page,
        [
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:combined-state",
            "Combined state with a deliberately long resting sidebar title",
            Date.now() - 1,
            {
              forkSource: { sessionKey: "agent:main:main", sessionId: "source-session" },
              unread: true,
              worktree: {
                id: "combined-state-worktree",
                branch: "fix/combined-state",
                repoRoot: "/tmp/openclaw",
              },
            },
          ),
        ],
        "agent:main:combined-state",
        "open",
        true,
      );

      const row = page.locator('[data-session-key="agent:main:combined-state"]');
      await ui.visible(row, 10_000);
      const state = row.locator(".sidebar-session-indicator .session-unread-dot");
      expect(await row.locator(".session-row-state").count()).toBe(0);
      await expect
        .poll(() =>
          row.locator(".sidebar-recent-session__name .sidebar-session-fork-indicator").isVisible(),
        )
        .toBe(true);
      await ui.expectCount(row.locator('[aria-label="Forked session"]'), 1);
      await expect
        .poll(() => row.locator("[data-pull-request-state='open']").isVisible())
        .toBe(true);
      await expect.poll(() => state.isVisible()).toBe(true);
      await ui.expectCount(row.locator(".session-glyph__ring"), 0);
      const prIcon = row.locator("[data-pull-request-state='open'] .session-css-icon");
      expect(
        await prIcon.evaluate((icon) => {
          const { width, height } = icon.getBoundingClientRect();
          return { width, height };
        }),
      ).toEqual({ width: 14, height: 14 });
      const stateLayout = await row.evaluate((element) => {
        const layoutLeft = (node: HTMLElement) => {
          let left = 0;
          for (
            let current: HTMLElement | null = node;
            current;
            current = current.offsetParent as HTMLElement | null
          ) {
            left += current.offsetLeft;
          }
          return left;
        };
        return (
          [
            [".sidebar-recent-session__details-endcap", "[data-pull-request-state='open']"],
            [".sidebar-session-indicator", ".session-unread-dot"],
          ] as const
        ).map(([containerSelector, atomSelector]) => {
          const container = element.querySelector<HTMLElement>(containerSelector);
          const atom = container?.querySelector<HTMLElement>(atomSelector);
          if (!container || !atom) {
            throw new Error("Expected visible session state geometry");
          }
          return {
            containerLeft: layoutLeft(container),
            containerRight: layoutLeft(container) + container.offsetWidth,
            left: layoutLeft(atom),
            right: layoutLeft(atom) + atom.offsetWidth,
          };
        });
      });
      for (const atom of stateLayout) {
        expect(atom.left).toBeGreaterThanOrEqual(atom.containerLeft);
        expect(atom.right).toBeLessThanOrEqual(atom.containerRight);
      }
      const link = row.locator(".sidebar-recent-session__link");
      const titleRow = row.locator(".sidebar-recent-session__title-row");
      const pin = ui.button(row, "Pin session", false);
      const menu = row.locator("[data-sidebar-session-archive]");
      await ui.expectRightPadding(link, "2px");

      const [restingTextBounds, restingStateBounds, restingPinBounds, restingMenuBounds] =
        await Promise.all([
          ui.bounds(row.locator(".sidebar-recent-session__text")),
          ui.bounds(row.locator("[data-pull-request-state='open']")),
          ui.bounds(pin),
          ui.bounds(menu),
        ]);

      const actionSurfaceWidth = ui.right(restingMenuBounds) - restingPinBounds.x;
      expect(ui.right(restingTextBounds)).toBeGreaterThan(
        restingStateBounds.x - actionSurfaceWidth,
      );
      const restingNameBounds = await ui.bounds(row.locator(".sidebar-recent-session__name"));

      expect(ui.centerY(restingNameBounds)).toBeLessThan(ui.centerY(restingStateBounds));
      await ui.forEachActionMode(page, row, [state, pin, menu], async () => {
        await ui.expectRightPadding(titleRow, "52px");
        const [textBounds, nameBounds, pinBounds, menuBounds] = await Promise.all([
          ui.bounds(row.locator(".sidebar-recent-session__text")),
          ui.bounds(row.locator(".sidebar-recent-session__name")),
          ui.bounds(pin),
          ui.bounds(menu),
        ]);
        expect(textBounds.width).toBeCloseTo(restingTextBounds.width, 1);
        expect(ui.centerY(nameBounds)).toBeCloseTo(ui.centerY(pinBounds), 1);
        expect(ui.right(nameBounds)).toBeLessThanOrEqual(pinBounds.x + 1);
        expect(ui.right(pinBounds)).toBeLessThanOrEqual(menuBounds.x);
        expect(ui.centerX(restingStateBounds)).toBeCloseTo(ui.centerX(menuBounds), 1);
      });
    }));
});
