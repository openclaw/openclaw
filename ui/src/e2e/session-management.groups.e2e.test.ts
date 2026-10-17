import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  actionOpacity,
  activateSelfRemovingControl,
  captureUiProof,
  collapsedSessionSectionsStorageKey,
  controlUiSessionPath,
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  openSessionMenuSubmenu,
  requireRecord,
  sessionsListResponse,
  submitInputDialog,
  waitForPatch,
} from "./session-management.test-support.ts";
import {
  expectAttribute,
  expectCount,
  expectText,
  withSessionPage,
} from "./session-page.test-support.ts";
import {
  chooseSidebarMenuOption,
  closeSidebarMenu,
  openSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();
const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
const categorizedRow = (key: string, name: string, age: number, category: string) =>
  sessionRow(`agent:main:${key}`, name, baseTime - age, { category });
const sessionLists = (...cases: [Record<string, unknown>, ReturnType<typeof sessionRow>[]][]) => ({
  cases: cases.map(([match, list]) => ({ match, response: sessionsListResponse(list) })),
});
const group = (page: Page, name: string) =>
  page.locator(`[data-session-section="category:${name}"]`);
const rows = (page: Page) => page.locator(".sidebar-recent-session");
const session = (page: Page, key: string) =>
  page.locator(`.sidebar-recent-session[data-session-key="agent:main:${key}"]`);
const memberRows = (section: ReturnType<typeof group>) =>
  section.locator(".sidebar-recent-session");
const sectionNames = (page: Page) =>
  page
    .locator('[data-session-section^="category:"]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-session-section")),
    );
function installGroups(
  page: Page,
  { methods = [], ...scenario }: ControlUiMockGatewayScenario & { methods?: string[] } = {},
) {
  return installMockGateway(page, {
    sessionKey: "agent:main:main",
    featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list", ...methods],
    methodResponses: { "sessions.list": sessionsListResponse([]) },
    ...scenario,
  });
}
const withPage = (run: (page: Page) => Promise<void>, height = 900) =>
  withSessionPage(suite, run, {
    colorScheme: "dark",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height, width: 1280 },
  });
const button = (target: Page | Locator, name: string) =>
  target.getByRole("button", { name, exact: true });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name });
const proof = (page: Page, name: string) => captureUiProof(suite, page, `${name}.png`);
async function openGroupMenu(page: Page, name: string, action: string) {
  const section = group(page, name);
  await section.locator(".sidebar-recent-sessions__head").hover();
  await section.getByRole("button", { name: `Group options for ${name}` }).click();
  await activateSelfRemovingControl(menuItem(page, action));
}
async function expectCategoryPatch(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  key: string,
  category: string | null,
) {
  const patch = await waitForPatch(
    gateway,
    (params) => params.key === key && params.category === category,
  );
  expect(requireRecord(patch.params)).toMatchObject({ key, category });
}

suite.define(() => {
  it("keeps long group titles on one line and reveals them on hover", async () => {
    const groupName = "OpenClaw Bugfixes / Miscellaneous Product Work and Release Coordination";
    await withPage(async (page) => {
      await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.groups.list"],
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow("agent:main:group-title", "Group title behavior", Date.now(), {
              category: groupName,
            }),
          ]),
        },
        sessionGroups: [groupName],
        sessionKey: "agent:main:group-title",
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:group-title"));
      const section = group(page, groupName);
      const header = section.locator(":scope > .sidebar-recent-sessions__head");
      const label = header.locator(".sidebar-recent-sessions__label-text");
      await section.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => label.evaluate((element) => getComputedStyle(element).maskImage))
        .toContain("linear-gradient");
      await proof(page, "sidebar-group-title-resting");

      const resting = await label.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          clientWidth: element.clientWidth,
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(style.lineHeight),
          scrollWidth: element.scrollWidth,
          maskImage: style.maskImage,
          whiteSpace: style.whiteSpace,
        };
      });
      expect(resting.whiteSpace).toBe("nowrap");
      expect(resting.maskImage).toContain("linear-gradient");
      expect(resting.height).toBeLessThanOrEqual(resting.lineHeight + 1);
      expect(resting.scrollWidth).toBeGreaterThan(resting.clientWidth);

      const text = label.locator(".hover-marquee__text");
      const offset = () =>
        text.evaluate((element) => {
          const transform = getComputedStyle(element).transform;
          return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
        });
      await header.hover();
      await expect.poll(offset).toBeLessThan(-2);
      const firstOffset = await offset();
      await expect.poll(offset).toBeLessThan(firstOffset - 5);
      expect(await label.evaluate((element) => getComputedStyle(element).maskImage)).toContain(
        "linear-gradient",
      );
      await proof(page, "sidebar-group-title-hovered");
    }, 720);
  });

  it("recovers an empty group catalog after a transient load failure", async () => {
    await withSessionPage(suite, async (page) => {
      const gateway = await installGroups(page, {
        deferredMethods: ["sessions.groups.list"],
        sessionGroups: ["Recovered group"],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.groups.list");
      await gateway.rejectDeferred("sessions.groups.list", {
        code: "UNAVAILABLE",
        message: "temporary catalog failure",
        retryable: true,
      });

      await expect
        .poll(async () => (await gateway.getRequests("sessions.groups.list")).length, {
          timeout: 10_000,
        })
        .toBe(2);
      await group(page, "Recovered group").waitFor({ state: "visible" });
    });
  });

  it("manages sessions through the sidebar groups and command palette", async () => {
    await withPage(async (page) => {
      await page.clock.install();
      await page.addInitScript((key) => {
        const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(
          key,
          JSON.stringify({ ...stored, railShortcuts: ["session:agent:main:release"] }),
        );
      }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "cron.list"],
        methodResponses: {
          "cron.list": { jobs: [{ id: "nightly-invoices", name: "Nightly invoices" }] },
          "sessions.list": sessionsListResponse([
            sessionRow("agent:main:main", "Main", baseTime),
            sessionRow("agent:main:release", "Release planning", baseTime - 60_000),
            sessionRow("agent:main:migration", "Data migration", baseTime - 90_000, {
              hasActiveRun: true,
              status: "running",
            }),
            sessionRow("agent:main:research", "Research notes", baseTime - 120_000),
          ]),
          "sessions.search": {
            results: [
              {
                score: 4.2,
                sessionKey: "agent:main:release",
                snippet: "The view-only handshake is ready for final review.",
              },
            ],
          },
          "sessions.patch": {},
        },
        sessionKey: "agent:main:main",
      });

      await page.goto(`${suite.server.baseUrl}chat`);

      const sidebarRows = rows(page);
      await sidebarRows.first().waitFor({ state: "visible", timeout: 10_000 });
      const pinnedZoneRow = page.locator(
        '.sidebar-rail [data-sidebar-entry="session:agent:main:release"]',
      );
      await pinnedZoneRow.getByRole("link", { name: "Release planning", exact: true }).waitFor();
      expect(await pinnedZoneRow.locator(".sidebar-recent-session").count()).toBe(0);
      const groups = page.locator(".sidebar-recent-sessions__group");
      await expectCount(groups, 1);
      await expectAttribute(groups.first(), "data-session-section", "ungrouped");
      await expectCount(page.locator('[data-session-section="pinned"]'), 0);

      const chatRows = page.locator('[data-session-section="ungrouped"] .sidebar-recent-session');
      const rowNames = () =>
        chatRows.evaluateAll((elements) =>
          elements.map(
            (row) => row.querySelector(".sidebar-recent-session__name")?.textContent ?? "",
          ),
        );
      await expect.poll(rowNames).toEqual(["Release planning", "Data migration", "Research notes"]);
      const sidebarMigration = sidebarRows.filter({ hasText: "Data migration" });
      await expect
        .poll(() =>
          sidebarMigration.locator(".sidebar-session-indicator .session-glyph__ring").isVisible(),
        )
        .toBe(true);

      const sidebarResearch = sidebarRows.filter({ hasText: "Research notes" });
      const sidebarResearchPin = sidebarResearch.getByRole("button", { name: "Pin session" });
      await page.mouse.move(900, 500);
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("0");
      const sidebarReleasePin = sidebarRows
        .filter({ hasText: "Release planning" })
        .getByRole("button", { name: "Unpin session" });
      await expect.poll(() => actionOpacity(sidebarReleasePin)).toBe("0");
      await sidebarResearch.hover();
      await expect.poll(() => actionOpacity(sidebarResearchPin)).toBe("1");
      await proof(page, "sidebar-sessions");

      await sidebarRows.filter({ hasText: "Release planning" }).hover();
      await expect.poll(() => actionOpacity(sidebarReleasePin)).toBe("1");
      const patchesBeforeUnpin = (await gateway.getRequests("sessions.patch")).length;
      await sidebarReleasePin.click();
      await expect.poll(() => pinnedZoneRow.count()).toBe(0);
      await sidebarRows
        .filter({ hasText: "Release planning" })
        .getByRole("button", { name: "Pin session", exact: true })
        .waitFor();
      await expect.poll(rowNames).toEqual(["Release planning", "Data migration", "Research notes"]);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(patchesBeforeUnpin);

      await sidebarMigration.hover();
      await sidebarMigration.click({ button: "right" });
      await expect.poll(() => menuItem(page, "Archive session").isDisabled()).toBe(false);
      await page.getByRole("menuitem", { name: "Advanced", exact: true }).click();
      await expect.poll(() => menuItem(page, "Delete…").isDisabled()).toBe(true);
      await page.keyboard.press("Escape");
      await page.getByRole("menu", { name: "Advanced", exact: true }).waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await page.locator("openclaw-session-menu [role=menu]").first().waitFor({ state: "hidden" });
      await sidebarResearch.hover();
      await sidebarResearch.click({ button: "right" });
      await activateSelfRemovingControl(menuItem(page, "Archive session"));
      const archivePatch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:research" && params.archived === true,
      );
      expect(requireRecord(archivePatch.params)).toMatchObject({
        archived: true,
        key: "agent:main:research",
      });

      await sidebarResearch.waitFor({ state: "detached" });
      const migrationLink = sidebarMigration.locator("a").first();
      await migrationLink.click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:migration"));
      await expect.poll(rowNames).toEqual(["Release planning", "Data migration"]);
      await expect
        .poll(() =>
          chatRows
            .filter({ hasText: "Data migration" })
            .first()
            .evaluate((row) => row.classList.contains("sidebar-recent-session--active")),
        )
        .toBe(true);

      const cronRequestsBeforePalette = (await gateway.getRequests("cron.list")).length;
      const transcriptRequestsBeforePalette = (await gateway.getRequests("sessions.search")).length;
      await page.getByRole("button", { name: "Open command palette" }).click();
      const paletteInput = page.locator(".cmd-palette__input");
      await paletteInput.waitFor({ state: "visible", timeout: 10_000 });
      await paletteInput.fill("nightly invoices");
      await page.clock.runFor(50);
      const automationOption = page.getByRole("option", { name: /Nightly invoices/u });
      await automationOption.waitFor({ state: "visible", timeout: 10_000 });
      expect(await gateway.getRequests("cron.list")).toHaveLength(cronRequestsBeforePalette + 1);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Open command palette" }).click();
      await paletteInput.waitFor({ state: "visible", timeout: 10_000 });
      await paletteInput.fill("view-only handshake");
      await page.clock.runFor(50);
      const paletteOption = page
        .locator(".cmd-palette__item")
        .filter({ hasText: "Release planning" });
      await paletteOption.waitFor({ state: "visible", timeout: 10_000 });
      await expectText(paletteOption, "view-only handshake");
      expect(await gateway.getRequests("cron.list")).toHaveLength(cronRequestsBeforePalette + 1);
      const transcriptRequests = await gateway.getRequests("sessions.search");
      expect(transcriptRequests).toHaveLength(transcriptRequestsBeforePalette + 2);
      expect(requireRecord(transcriptRequests.at(-1)?.params)).toMatchObject({
        query: "view-only handshake",
        limit: 25,
        scope: {
          includeGlobal: false,
          includeUnknown: false,
          configuredAgentsOnly: true,
          excludeSubagents: true,
          excludeCron: true,
          excludeSystem: true,
        },
      });
      await proof(page, "command-palette-session-search");
      await paletteOption.click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:release"));
    });
  });

  it("sorts threads from the keyboard and identifies destructive selection targets", async () => {
    await withSessionPage(suite, async (page) => {
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow("agent:main:alpha", "Alpha thread", 1),
            sessionRow("agent:main:zulu", "Zulu thread", 2),
          ]),
        },
        sessionKey: "agent:main:main",
      });

      await page.goto(`${suite.server.baseUrl}sessions`);
      const table = page.locator(".sessions-table");
      const rowNames = () =>
        table.locator("tbody .session-data-row .session-label-chip").allTextContents();
      await expect.poll(rowNames).toEqual(["Zulu thread", "Alpha thread"]);

      for (const name of ["Key", "Kind", "Updated", "Tokens"]) {
        await table.getByRole("columnheader", { name }).getByRole("button", { name }).waitFor();
      }

      const updatedHeader = table.getByRole("columnheader", { name: "Updated" });
      expect(await updatedHeader.getAttribute("aria-sort")).toBe("descending");
      await updatedHeader.getByRole("button", { name: "Updated" }).press("Space");
      await expect.poll(rowNames).toEqual(["Alpha thread", "Zulu thread"]);
      expect(await updatedHeader.getAttribute("aria-sort")).toBe("ascending");

      const keyHeader = table.getByRole("columnheader", { name: "Key" });
      await keyHeader.getByRole("button", { name: "Key" }).press("Enter");
      await expect.poll(rowNames).toEqual(["Zulu thread", "Alpha thread"]);
      expect(await keyHeader.getAttribute("aria-sort")).toBe("descending");
      expect(await updatedHeader.getAttribute("aria-sort")).toBeNull();

      const keyHeaderBounds = await keyHeader.boundingBox();
      if (!keyHeaderBounds) {
        throw new Error("Expected visible session sort header");
      }
      await page.mouse.click(
        keyHeaderBounds.x + keyHeaderBounds.width - 2,
        keyHeaderBounds.y + keyHeaderBounds.height / 2,
      );
      await expect.poll(rowNames).toEqual(["Alpha thread", "Zulu thread"]);
      expect(await keyHeader.getAttribute("aria-sort")).toBe("ascending");

      await table.getByRole("checkbox", { name: "Select session: agent:main:alpha" }).waitFor();
      await table.getByRole("checkbox", { name: "Select session: agent:main:zulu" }).waitFor();
    });
  });

  it("shows a rejected Sessions-page custom group instead of leaking a page error", async () => {
    await withSessionPage(suite, async (page) => {
      const gateway = await installGroups(page, {
        deferredMethods: ["sessions.groups.put"],
        methods: ["sessions.groups.put"],
      });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.goto(`${suite.server.baseUrl}sessions`);
      await page.getByRole("button", { name: "Filters" }).click();
      await page.locator(".sessions-filter-popover:popover-open").waitFor();
      await page.locator(".session-groupby__select").selectOption("category");
      await page.getByRole("button", { name: "New group" }).click();
      const field = page.locator("openclaw-modal-dialog input");
      await field.waitFor({ state: "visible" });
      await field.fill("X".repeat(513));
      await field.press("Enter");
      await gateway.waitForRequest("sessions.groups.put");
      await gateway.rejectDeferred("sessions.groups.put", {
        code: "INVALID_REQUEST",
        message: "group name exceeds 512 characters",
      });

      const error = page.locator('openclaw-modal-dialog [role="alert"]');
      await error.waitFor({ state: "visible" });
      await expectText(error, "group name exceeds 512 characters");
      expect(await field.inputValue()).toBe("X".repeat(513));
      expect(pageErrors).toEqual([]);
    });
  });

  it("renames, deletes, and toggles sidebar session groups", async () => {
    await withSessionPage(suite, async (page) => {
      const gateway = await installGroups(page, {
        methodResponses: {
          "sessions.list": sessionLists(
            [
              { archived: true },
              [
                sessionRow("agent:main:old-notes", "Old notes", baseTime - 300_000, {
                  archived: true,
                  category: "Research",
                }),
              ],
            ],
            [
              {},
              [
                sessionRow("agent:main:main", "Main", baseTime),
                categorizedRow("apps", "Apps", 30_000, "Apps"),
                categorizedRow("paper-a", "Paper A", 60_000, "Research"),
                categorizedRow("paper-b", "Paper B", 90_000, "Research"),
              ],
            ],
          ),
          "sessions.patch": {},
        },
        sessionGroups: ["Apps", "Research"],
        methods: ["sessions.groups.delete", "sessions.groups.rename"],
      });

      await page.goto(`${suite.server.baseUrl}chat`);

      const groups = page.locator(".sidebar-recent-sessions__group");
      const researchGroup = groups.filter({ hasText: "Research" });
      await researchGroup.waitFor({ state: "visible", timeout: 10_000 });
      await expectCount(memberRows(researchGroup), 2);
      await proof(page, "sidebar-session-groups");

      const groupMenuButton = researchGroup.getByRole("button", {
        name: "Group options for Research",
      });
      await researchGroup.locator(".sidebar-recent-sessions__head").hover();
      await groupMenuButton.click();
      await menuItem(page, "Rename group").waitFor({ state: "visible" });
      await proof(page, "sidebar-group-menu");
      await activateSelfRemovingControl(menuItem(page, "Rename group"));
      const renameDialog = page.getByRole("dialog", { name: 'Rename group "Research"' });
      await renameDialog.waitFor({ state: "visible" });
      await expect
        .poll(() => page.locator("openclaw-modal-dialog input").inputValue())
        .toBe("Research");
      await proof(page, "sidebar-group-rename-dialog");
      await submitInputDialog(page, "Projects");
      const renameRequest = await gateway.waitForRequest("sessions.groups.rename");
      expect(requireRecord(renameRequest.params)).toMatchObject({
        name: "Research",
        to: "Projects",
      });
      await expect.poll(() => sectionNames(page)).toEqual(["category:Apps", "category:Projects"]);
      const projectsGroup = groups.filter({ hasText: "Projects" });
      await expectCount(memberRows(projectsGroup), 2);

      await openGroupMenu(page, "Projects", "Delete group");
      await page
        .getByRole("dialog", { name: 'Delete group "Projects"' })
        .waitFor({ state: "visible" });
      const deleteConfirm = page.locator("openclaw-modal-dialog");
      await expectText(
        deleteConfirm,
        "The group is removed. Its sessions move back to the session list.",
      );
      await proof(page, "sidebar-group-delete-confirm");
      await button(deleteConfirm, "Delete").click();
      const deleteRequest = await gateway.waitForRequest("sessions.groups.delete");
      expect(requireRecord(deleteRequest.params)).toMatchObject({ name: "Projects" });
      await expect.poll(() => sectionNames(page)).toEqual(["category:Apps"]);
      await expectCount(memberRows(page.locator('[data-session-section="ungrouped"]')), 2);

      const filterAndSortButton = button(page, "Filter & sort");
      await filterAndSortButton.click();
      await openSidebarMenu(page);
      const showAutomationSessions = page.getByRole("switch", {
        name: "Show automation sessions",
        exact: true,
      });
      await showAutomationSessions.click();
      await expectAttribute(showAutomationSessions, "aria-checked", "true");
      await expectAttribute(filterAndSortButton, "aria-expanded", "true");
      await openSidebarMenu(page);
      const groupBy = button(page, "Group by: Custom groups");
      await groupBy.waitFor();
      await proof(page, "sidebar-groupby-sort-menu");
      await filterAndSortButton.click();
      await expectAttribute(filterAndSortButton, "aria-expanded", "false");
      await expectCount(page.locator(".sidebar-session-sort-menu"), 0);
      await proof(page, "sidebar-groupby-sort-menu-closed");

      await filterAndSortButton.click();
      await chooseSidebarMenuOption(page, "Group by", "None");
      await closeSidebarMenu(page);
      await expectCount(groups, 1);
      await expectCount(memberRows(groups.first()), 3);
    });
  });

  it("preserves a collapsed sidebar group when its rename is rejected", async () => {
    await withSessionPage(suite, async (page) => {
      await page.addInitScript(
        ({ key, value }) => {
          try {
            if (localStorage.getItem(key) === null) {
              localStorage.setItem(key, value);
            }
          } catch {
            // The opaque initial document has no storage; the app origin does.
          }
        },
        {
          key: collapsedSessionSectionsStorageKey,
          value: JSON.stringify(["category:Research"]),
        },
      );
      const gateway = await installGroups(page, {
        deferredMethods: ["sessions.groups.rename"],
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow("agent:main:main", "Main", baseTime),
            categorizedRow("paper", "Paper", 60_000, "Research"),
          ]),
        },
        sessionGroups: ["Research"],
        methods: ["sessions.groups.rename"],
      });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.goto(`${suite.server.baseUrl}chat`);
      const researchGroup = group(page, "Research");
      await researchGroup.waitFor({ state: "visible", timeout: 10_000 });
      await expectCount(memberRows(researchGroup), 0);
      await openGroupMenu(page, "Research", "Rename group");
      await submitInputDialog(page, "Projects");
      await gateway.waitForRequest("sessions.groups.rename");
      await gateway.rejectDeferred("sessions.groups.rename", {
        code: "INVALID_REQUEST",
        message: "rejected group rename",
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );

      expect(
        await page.evaluate((key) => localStorage.getItem(key), collapsedSessionSectionsStorageKey),
      ).toBe(JSON.stringify(["category:Research"]));
      await researchGroup.waitFor({ state: "visible" });
      expect(await page.locator('[data-session-section="category:Projects"]').count()).toBe(0);
      expect(pageErrors).toEqual([]);

      await page.reload();
      await researchGroup.waitFor({ state: "visible", timeout: 10_000 });
      await expectCount(memberRows(researchGroup), 0);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), collapsedSessionSectionsStorageKey),
      ).toBe(JSON.stringify(["category:Research"]));
    });
  });

  it("pages sidebar sessions and supports complete drag-managed groups", async () => {
    await withSessionPage(suite, async (page) => {
      const sessions = Array.from({ length: 13 }, (_, index) =>
        sessionRow(`agent:main:session-${index}`, `Session ${index}`, baseTime - index * 60_000, {
          ...(index === 0 ? { category: "Alpha" } : {}),
          ...(index === 1 ? { category: "Beta" } : {}),
        }),
      );
      const gateway = await installGroups(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse(sessions),
          "sessions.patch": {},
        },
        sessionKey: "agent:main:session-0",
        sessionGroups: ["Alpha", "Beta"],
        methods: ["sessions.groups.put", "sessions.patch"],
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-0"));
      const sidebarRows = rows(page);
      await expectCount(sidebarRows, 12);
      await page.getByRole("button", { name: "Show more" }).click();
      await expectCount(sidebarRows, 13);
      await expectCount(page.getByText("All sessions", { exact: true }), 0);
      await proof(page, "sidebar-all-sessions");

      const sessionTen = session(page, "session-10");
      await sessionTen.hover();
      await sessionTen.click({ button: "right" });
      await openSessionMenuSubmenu(page, "Move to group");
      await activateSelfRemovingControl(menuItem(page, "New group"));
      await submitInputDialog(page, "Gamma");
      const gamma = group(page, "Gamma");
      await gamma.waitFor({ state: "visible" });
      await expectCategoryPatch(gateway, "agent:main:session-10", "Gamma");

      const sessionEleven = session(page, "session-11");
      await sessionEleven.dragTo(gamma);
      await expectCategoryPatch(gateway, "agent:main:session-11", "Gamma");
      await expectCount(memberRows(gamma), 2, { timeout: 10_000 });
      await proof(page, "sidebar-session-dropped-into-group");

      const ungrouped = page.locator('[data-session-section="ungrouped"]');
      const ungroupedHead = ungrouped.locator(":scope > .sidebar-recent-sessions__head");
      await gamma
        .locator(session(page, "session-11"))
        .dragTo(ungroupedHead, { targetPosition: { x: 4, y: 2 } });
      await expectCategoryPatch(gateway, "agent:main:session-11", null);
      await expectCount(memberRows(ungrouped), 10, { timeout: 10_000 });

      const alpha = group(page, "Alpha");
      const alphaToggle = button(alpha, "Alpha").and(
        alpha.locator(".sidebar-session-group-toggle"),
      );
      await alphaToggle.click();
      await expectCount(memberRows(alpha), 0);
      await proof(page, "sidebar-session-group-collapsed");
      await alphaToggle.click();
      await expectCount(memberRows(alpha), 1);
      await alphaToggle.click();
      await expectCount(memberRows(alpha), 0);

      await gamma.locator(".sidebar-session-group-drag-handle").dragTo(alpha, {
        targetPosition: { x: 4, y: 2 },
      });
      const customGroupOrder = () => sectionNames(page);
      await expect
        .poll(customGroupOrder)
        .toEqual(["category:Gamma", "category:Alpha", "category:Beta"]);
      await proof(page, "sidebar-session-groups-reordered");

      await page.reload();
      await expect
        .poll(customGroupOrder)
        .toEqual(["category:Gamma", "category:Alpha", "category:Beta"]);
      await expectAttribute(
        alpha.locator(".sidebar-session-group-toggle"),
        "aria-expanded",
        "false",
      );
      await expectCount(rows(page), 11);

      const patchCountBeforeFlatDrag = (await gateway.getRequests("sessions.patch")).length;
      const filterAndSortButton = button(page, "Filter & sort");
      await filterAndSortButton.click();
      await chooseSidebarMenuOption(page, "Group by", "None");
      await closeSidebarMenu(page);
      const flatSection = page.locator('[data-session-section="ungrouped"]');
      await flatSection.locator(session(page, "session-1")).dragTo(flatSection);
      expect((await gateway.getRequests("sessions.patch")).length).toBe(patchCountBeforeFlatDrag);
    });
  });

  it("keeps a new empty group visible before the first saved session", async () => {
    await withSessionPage(suite, async (page) => {
      const gateway = await installGroups(page, {
        sessionGroups: ["First group"],
        methods: ["sessions.groups.put"],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const firstGroup = group(page, "First group");
      await firstGroup.waitFor({ state: "visible" });

      await openGroupMenu(page, "First group", "New group");
      await submitInputDialog(page, "Second group");
      await group(page, "Second group").waitFor({ state: "visible" });
      const putRequest = await gateway.waitForRequest("sessions.groups.put");
      expect(requireRecord(putRequest.params)).toMatchObject({
        names: ["First group", "Second group"],
      });
    });
  });

  it("keeps empty gateway groups compact for the selected agent", async () => {
    await withSessionPage(suite, async (page) => {
      const gateway = await installGroups(page, {
        assistantName: "Ivan",
        defaultAgentId: "ivan",
        methodResponses: {
          "sessions.list": sessionLists(
            [
              { agentId: "ivan" },
              [sessionRow("agent:ivan:main", "Ivan", Date.parse("2026-07-28T18:00:00.000Z"))],
            ],
            [
              { agentId: "main" },
              [
                sessionRow("agent:main:email", "Email intake", 1, { category: "Email intake" }),
                sessionRow("agent:main:replies", "Customer replies", 1, {
                  category: "Customer replies",
                }),
              ],
            ],
          ),
        },
        sessionGroups: ["Email intake", "Customer replies"],
        sessionKey: "agent:ivan:main",
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) => requireRecord(request.params).agentId === "ivan",
          ),
        )
        .toBe(true);

      const emptyGroups = page.locator('[data-session-section^="category:"]');
      await expectCount(emptyGroups, 2);

      for (const name of ["Email intake", "Customer replies"]) {
        const section = group(page, name);
        await section.waitFor({ state: "visible" });
        await expectCount(section.locator(":scope > .sidebar-recent-sessions__head"), 1);
        const toggle = section.getByRole("button", { name, exact: true });
        await toggle.waitFor({ state: "visible" });
        await expectAttribute(toggle, "aria-expanded", "true");
      }

      await expectCount(emptyGroups.locator(".sidebar-session-empty-hint"), 0);
      await expectCount(emptyGroups.locator(".sidebar-recent-sessions__list"), 0);

      const firstEmptyGroup = emptyGroups.first();
      const groupHeight = () =>
        firstEmptyGroup.evaluate((element) => element.getBoundingClientRect().height);
      await expect.poll(groupHeight).toBeGreaterThan(0);
      const expandedHeight = await groupHeight();
      await proof(page, "sidebar-empty-cross-agent-groups");

      const toggle = firstEmptyGroup.locator(".sidebar-session-group-toggle");
      await toggle.click();
      await expectAttribute(toggle, "aria-expanded", "false");
      // DOMRect measurements can differ by subpixel rounding without a layout change.
      await expect.poll(groupHeight).toBeCloseTo(expandedHeight, 2);
      await expectCount(firstEmptyGroup.locator(".sidebar-session-empty-hint"), 0);
      await expectCount(firstEmptyGroup.locator(".sidebar-recent-sessions__list"), 0);
    });
  });
});
