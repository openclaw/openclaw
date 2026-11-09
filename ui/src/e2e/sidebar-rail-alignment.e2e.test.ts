import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";
import { sidebarSessionList } from "./sidebar-contract.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar rail alignment" });

suite.define(() => {
  it.each([false, true])(
    "centers rail controls and the owner toolbar (touch: %s)",
    async (hasTouch) => {
      await suite.withPage(
        { hasTouch, viewport: { width: 1280, height: 800 } },
        async ({ page }) => {
          const sessions = [
            ...["Sidebar alignment review", "Release notes"].map((label, index) => ({
              key: `agent:main:${index === 0 ? "current" : "notes"}`,
              kind: "direct",
              label,
              updatedAt: Date.now(),
            })),
            // Home renders its session glyph only when the main session row exists.
            { key: "agent:main:main", kind: "direct", label: "Home", updatedAt: Date.now() },
          ];
          await installMockGateway(page, {
            sessionKey: "agent:main:current",
            presenceUsers: [
              { id: "riley", name: "Riley", self: true },
              { id: "devon", name: "Devon" },
            ],
            sessions,
            methodResponses: {
              "sessions.list": sidebarSessionList(
                sessions,
                { model: null, modelProvider: null, contextTokens: null },
                [
                  { type: "human", id: "riley", label: "Riley" },
                  { type: "human", id: "devon", label: "Devon" },
                ],
              ),
            },
          });
          await page.emulateMedia({ colorScheme: "dark" });
          await page.goto(suite.server.baseUrl + "chat");
          const rail = page.locator("openclaw-app-sidebar .sidebar-rail");
          const owner = page.locator(".sidebar-session-owner-filter .picker-select__trigger");
          await owner.waitFor();
          await selectAllSidebarSessions(page);
          const firstRow = page.locator(".sidebar-sessions .sidebar-recent-session").first();
          await firstRow.waitFor();
          // The Sessions title picker is one toolbar control among the header's
          // buttons and mirrors the row beneath it: a plain title starts on the
          // row glyph column; with an owner avatar, the avatar centers on that
          // column and the label starts on the row text column.
          const measureHeader = () =>
            page.locator(".sidebar-session-toolbar").evaluate((toolbar) => {
              const box = (selector: string) =>
                toolbar.querySelector(selector)?.getBoundingClientRect() ?? null;
              const leading = box(".picker-select__trigger .picker-select__leading");
              return {
                controls: [
                  ".sidebar-session-owner-filter .picker-select__trigger",
                  ".sidebar-session-sort",
                  ".sidebar-session-toolbar__collapse",
                ].map((selector) => ({
                  selector,
                  height: box(selector)!.height,
                  radius: getComputedStyle(toolbar.querySelector(selector)!).borderRadius,
                })),
                radiusToken: getComputedStyle(document.documentElement)
                  .getPropertyValue("--radius-md")
                  .trim(),
                avatarCenter: leading ? leading.x + leading.width / 2 : null,
                labelLeft: box(".picker-select__label")!.x,
              };
            });
          const rowGeometry = await firstRow.evaluate((element) => {
            const glyph = element
              .querySelector(".sidebar-session-indicator")!
              .getBoundingClientRect();
            return {
              glyphLeft: glyph.x,
              glyphCenter: glyph.x + glyph.width / 2,
              textLeft: element
                .querySelector(".sidebar-recent-session__text")!
                .getBoundingClientRect().x,
            };
          });
          const allOwners = await measureHeader();
          for (const control of allOwners.controls) {
            expect(control.height, control.selector).toBe(28);
            expect(control.radius, control.selector).toBe(allOwners.radiusToken);
          }
          expect(allOwners.avatarCenter).toBeNull();
          expect(allOwners.labelLeft).toBe(rowGeometry.glyphLeft);
          await page.locator("#sidebar-session-owner-title").click();
          await page
            .locator('.sidebar-session-owner-filter [role="option"][data-value="owner:riley"]')
            .click();
          // The owner avatar arrives with the picker's next render.
          await expect
            .poll(async () => {
              const mine = await measureHeader();
              return mine.avatarCenter === null
                ? null
                : {
                    avatarCentered: Math.abs(mine.avatarCenter - rowGeometry.glyphCenter) <= 0.5,
                    label: mine.labelLeft,
                  };
            })
            .toEqual({ avatarCentered: true, label: rowGeometry.textLeft });
          await selectAllSidebarSessions(page);
          await page
            .locator(".sidebar-recent-session__name")
            .filter({ hasText: "Release notes" })
            .waitFor();
          await rail.locator(".sidebar-issues-button").waitFor();
          const geometry = await rail.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const center =
              (rect.left +
                Number.parseFloat(style.borderLeftWidth) +
                rect.right -
                Number.parseFloat(style.borderRightWidth)) /
              2;
            return [
              ...element.querySelectorAll<HTMLElement>(
                ".sidebar-agent-card__main, .sidebar-new-session, [data-navigation-view], .sidebar-brand__search, .sidebar-footer-bar__home, .sidebar-issues-button, .sidebar-identity-card",
              ),
            ].map((control) => {
              const box = control.getBoundingClientRect();
              return {
                control: control.className,
                offset: box.x + box.width / 2 - center,
                size: [box.width, box.height, getComputedStyle(control).borderRadius].join(" "),
                top: box.top,
                bottom: box.bottom,
              };
            });
          });
          for (const measured of geometry) {
            expect(Math.abs(measured.offset), measured.control).toBeLessThanOrEqual(0.5);
            expect(measured.size, measured.control).toBe(geometry[0]!.size);
          }
          // The top stack (agent card, New session, views, search) keeps one 8px pitch;
          // New session differs from its neighbors only by its accent fill.
          for (let index = 1; index < 6; index += 1) {
            const control = geometry[index]!;
            expect(control.top - geometry[index - 1]!.bottom, control.control).toBeCloseTo(8, 1);
          }
          const agentBox = await rail.locator(".sidebar-agent-card__main").boundingBox();
          const ownerBox = await owner.boundingBox();
          expect(agentBox).not.toBeNull();
          expect(ownerBox).not.toBeNull();
          expect(
            Math.abs(agentBox!.y + agentBox!.height / 2 - ownerBox!.y - ownerBox!.height / 2),
          ).toBeLessThanOrEqual(0.5);
          await rail.locator(".sidebar-footer-bar__home .session-glyph svg").waitFor();
          const iconInk = await rail.evaluate((element) =>
            [".sidebar-footer-bar__home svg", ".sidebar-issues-button svg"].map((selector) => {
              const icon = element.querySelector<SVGElement>(selector)!;
              let opacity = 1;
              for (let node: Element | null = icon; node && node !== element;) {
                opacity *= Number(getComputedStyle(node).opacity);
                node = node.parentElement;
              }
              return { color: getComputedStyle(icon).color, opacity };
            }),
          );
          expect(iconInk[0]).toEqual(iconInk[1]);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" && !hasTouch) {
            const sidebar = page.locator(".sidebar.sidebar--rail");
            await captureFrame(suite.artifactDir, "sidebar.png", sidebar, [owner]);
          }
          const toolbarBox = await page.locator(".sidebar-session-toolbar").boundingBox();
          // Fresh preferences have no personal sections above the first row.
          const sessionsBox = await page.locator(".sidebar-sessions").boundingBox();
          const firstRowBox = await page
            .locator(".sidebar-sessions .sidebar-recent-session")
            .first()
            .boundingBox();
          expect(toolbarBox).not.toBeNull();
          expect(sessionsBox).not.toBeNull();
          expect(firstRowBox).not.toBeNull();
          expect(sessionsBox!.y - toolbarBox!.y - toolbarBox!.height).toBe(6);
          expect(firstRowBox!.y - sessionsBox!.y).toBe(0);

          // Every view's row fill starts at the panel content edge and every title
          // starts on one text column. Views slide in, so wait for each fill to settle.
          const left = (locator: ReturnType<typeof page.locator>) =>
            locator.evaluate((element) => element.getBoundingClientRect().left);
          const contentLeft = await left(
            page.locator("openclaw-app-sidebar .sidebar-shell__content"),
          );
          const columns: number[] = [];
          const measure = async (view: string, fill: string, text: string) => {
            const row = page.locator(fill).first();
            await row.waitFor();
            await expect.poll(() => left(row), { message: view }).toBeCloseTo(contentLeft, 1);
            columns.push(await left(row.locator(text)));
          };
          await measure(
            "sessions",
            ".sidebar-sessions .sidebar-recent-session",
            ".sidebar-recent-session__name",
          );
          await page.locator('[data-navigation-view="pages"]').click();
          await measure("pages", ".sidebar-pages__entry .nav-item", ".nav-item__text");
          await evaluateControlUiContext(
            page,
            ({ navigation }, entries) => navigation.update({ sidebarEntries: entries }),
            ["session:agent:main:notes"],
          );
          await measure(
            "pinned",
            ".sidebar-pages__entry .sidebar-recent-session",
            ".sidebar-recent-session__name",
          );
          await page.locator('[data-navigation-view="online"]').click();
          await measure("users", ".sidebar-online__person", ".sidebar-online__person-name");
          for (const text of columns) {
            expect(text, JSON.stringify(columns)).toBeCloseTo(columns[0]!, 1);
          }
        },
      );
    },
  );
});
