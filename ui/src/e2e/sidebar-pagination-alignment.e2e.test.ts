import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sidebarSessionList } from "./sidebar-contract.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar pagination alignment" });

async function textLeft(locator: Locator) {
  return locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().left;
  });
}

suite.define(() => {
  it.each([1280, 390])("aligns section pagination with session titles at %s px", (width) =>
    suite.withPage(
      { viewport: { width, height: 900 }, hasTouch: width === 390, colorScheme: "dark" },
      async ({ page }) => {
        await page.addInitScript(() => {
          localStorage.setItem("openclaw:sidebar:sessions:grouping", "person");
        });
        const owner = {
          type: "human",
          id: "riley",
          identity: { type: "profile", id: "riley" },
          label: "Riley",
        };
        const roots = Array.from({ length: 31 }, (_, index) => ({
          key: `agent:main:review-${index}`,
          kind: "direct",
          label: index === 0 ? "Control UI alignment review" : `Review session ${index + 1}`,
          updatedAt: 1_790_000_000_000 - index * 60_000,
          owner: { actor: owner },
        }));
        const parentKey = roots[0]!.key;
        const children = Array.from({ length: 11 }, (_, index) => ({
          ...roots[0]!,
          key: `agent:main:dashboard:research-${index}`,
          label: `Research task ${index + 1}`,
          spawnedBy: parentKey,
        }));
        const sessions = [
          { ...roots[0]!, childSessions: children.map((child) => child.key) },
          ...roots.slice(1),
          ...children,
        ];
        await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
          sessionKey: parentKey,
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [{ id: owner.id, name: owner.label, self: true }],
          sessions,
          methodResponses: {
            "sessions.catalog.list": {
              catalogs: [
                {
                  id: "codex",
                  label: "Codex",
                  capabilities: { continueSession: true, archive: true },
                  hosts: [
                    {
                      hostId: "gateway:local",
                      label: "Local coding sessions",
                      kind: "gateway",
                      connected: true,
                      sessions: Array.from({ length: 6 }, (_, index) => ({
                        threadId: `coding-${index}`,
                        name: `Interface review ${index + 1}`,
                        cwd: "/workspace/interface",
                        status: "idle",
                        archived: false,
                        canContinue: true,
                        canArchive: true,
                      })),
                    },
                  ],
                },
              ],
            },
            "sessions.list": {
              cases: [
                { match: { spawnedBy: parentKey }, response: sidebarSessionList(children, {}, []) },
                {
                  response: sidebarSessionList(sessions, {}, [
                    owner,
                    {
                      type: "human",
                      id: "devon",
                      identity: { type: "profile", id: "devon" },
                      label: "Devon",
                    },
                  ]),
                },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        if (width === 390) {
          await navigationDrawerToggle(page).click();
        }
        const childToggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
        await childToggle.waitFor();
        if ((await childToggle.getAttribute("aria-expanded")) === "true") {
          await childToggle.click();
        }
        const group = page.locator(".sidebar-recent-sessions__group--inline-owner");
        const more = group.getByRole("button", { name: "Show more", exact: true });
        const title = group.locator(".sidebar-recent-session__name").first();
        await more.waitFor();
        await page.mouse.move(width - 10, 850);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const sidebar = page.locator("aside.sidebar");
          const frame = await takeControlUiScreenshotFrame(page, group, [title, more], {
            elements: [sidebar, group],
            animations: "disabled",
          });
          await writeFile(
            path.join(suite.artifactDir, `sidebar-${width}.png`),
            frame.elements[0]!.png,
          );
          await writeFile(
            path.join(suite.artifactDir, `pagination-${width}.png`),
            frame.elements[1]!.png,
          );
        }
        expect(await textLeft(more)).toBeCloseTo(await textLeft(title), 1);
        const rowLeft = await title.evaluate(
          (element) => element.closest(".sidebar-recent-session")!.getBoundingClientRect().left,
        );
        expect((await textLeft(title)) - rowLeft).toBe(width === 390 ? 10 : 8);
        await more.click();
        await more.click();
        await more.click();
        const collapse = group.getByRole("button", { name: "Collapse", exact: true });
        await collapse.waitFor();
        expect(await textLeft(collapse)).toBeCloseTo(await textLeft(title), 1);
        await collapse.click();
        await childToggle.click();
        const childMore = page.locator(`[data-show-more-children="${parentKey}"]`);
        await childMore.waitFor();
        const childTitle = page
          .locator(
            `[data-session-tree="${parentKey}"] .sidebar-session-tree__children .sidebar-recent-session__name`,
          )
          .first();
        expect(await textLeft(childMore)).toBeCloseTo(await textLeft(childTitle), 1);
        await childToggle.click();
        await selectAllSidebarSessions(page);
        const headedGroup = page
          .locator('.sidebar-recent-sessions__group[data-session-section^="person:"]')
          .filter({ has: page.locator(".sidebar-recent-sessions__head") })
          .filter({ has: page.getByRole("button", { name: "Show more", exact: true }) });
        const headedMore = headedGroup.getByRole("button", { name: "Show more", exact: true });
        await headedMore.waitFor();
        expect(await textLeft(headedMore)).toBeCloseTo(
          await textLeft(headedGroup.locator(".sidebar-recent-session__name").first()),
          1,
        );
        const catalog = page.locator('[data-session-section="catalog:codex"]');
        const catalogToggle = catalog.locator(".sidebar-session-group-toggle").first();
        await catalogToggle.waitFor();
        if ((await catalogToggle.getAttribute("aria-expanded")) === "false") {
          await catalogToggle.click();
        }
        const project = catalog.locator(".sidebar-session-catalog-project");
        const catalogMore = project.getByRole("button", { name: "Show more", exact: true });
        await catalogMore.waitFor();
        expect(await textLeft(catalogMore)).toBeCloseTo(
          await textLeft(project.locator(".sidebar-recent-session__name").first()),
          1,
        );
      },
    ),
  );
});
