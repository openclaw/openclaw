import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  sessionsListResponse,
  waitForMobileSidebarDrawerOpen,
} from "./session-management.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();

/** New sections name and scope first; edits open on session choice and go Back to rename. */
async function nameSection(dialog: Locator, name: string, options: { editing?: boolean } = {}) {
  if (options.editing) {
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
  }
  await dialog.getByLabel("Section name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Choose sessions", exact: true }).click();
}
const key = "agent:main:reliability";
const releaseKey = "agent:main:release";

suite.define(() => {
  it("places sections below Pinned and scopes the two-step editor", async () => {
    // OPENCLAW_SECTIONS_STAGE=after records proof screenshots for every touched surface.
    const stage = process.env.OPENCLAW_SECTIONS_STAGE;
    const artifacts = stage ? createControlUiE2eArtifactDir("sections-" + stage) : undefined;
    const capture = async (name: string, target: Locator) => {
      if (artifacts) {
        await captureFrame(artifacts, name, page.locator(".shell"), [target]);
      }
    };
    const self = "profile-jordan";
    const owner = (id: string, label: string) => ({
      owner: { actor: { type: "human", id, label, identity: { type: "profile", id } } },
    });
    const row = (
      sessionKey: string,
      title: string,
      index: number,
      who: [string, string] = [self, "Jordan Lee"],
      projectId = "openclaw",
    ) =>
      createControlUiSessionRow(sessionKey, title, 1793000000000 - index * 1000, {
        category: "Engineering",
        createdAt: 1792900000000 - index * 1000,
        projectId,
        ...owner(...who),
      });
    const maya: [string, string] = ["profile-maya", "Maya Chen"];
    const sam: [string, string] = ["profile-sam", "Sam Okafor"];
    const rows = [
      row(key, "Roadmap review", 0),
      row(releaseKey, "Release checklist", 1),
      row("agent:main:memory", "Gateway memory audit", 2, maya),
      row("agent:main:research", "Research notes", 3, undefined, "docs-site"),
      row("agent:main:incident", "Incident follow-up", 4, sam),
      row("agent:main:onboarding", "Onboarding copy", 5, undefined, "docs-site"),
      row("agent:main:ranking", "Search ranking", 6, maya, "clawhub"),
      row("agent:main:planning", "Weekly planning", 7),
      row("agent:main:benchmarks", "Benchmarks", 8, maya),
      row("agent:main:interviews", "Interview notes", 9),
      row("agent:main:triage", "Bug triage", 10),
    ];
    const mine = rows.filter((_, index) => ![2, 4, 6, 8].includes(index));
    const listed = (sessions: typeof rows) => ({ response: sessionsListResponse(sessions) });
    let page!: Page;
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async (opened) => {
      page = opened.page;
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        presenceUsers: [{ self: true, id: self, name: "Jordan Lee" }],
        featureMethods: [...defaultControlUiFeatureMethods, "projects.list"],
        sessions: rows,
        methodResponses: {
          "projects.list": {
            projects: [
              { id: "openclaw", displayName: "openclaw" },
              { id: "clawhub", displayName: "clawhub" },
              { id: "docs-site", displayName: "docs-site" },
            ],
          },
          "sessions.list": {
            cases: [
              {
                match: { search: "Release" },
                ...listed([rows[1]!]),
              },
              { match: { ownerId: self }, ...listed(mine) },
              {
                match: { projectId: "clawhub" },
                ...listed([rows[6]!]),
              },
              listed(rows),
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await page.locator("openclaw-app-sidebar .sidebar-recent-session").first().waitFor();
      await evaluateControlUiContext(page, ({ navigation, theme }) => {
        theme.setMode("light");
        navigation.update({
          sidebarEntries: ["session:agent:main:reliability"],
          // Saved in the opposite order to the sidebar's newest-first Sort by.
          personalSessionGroups: [
            {
              id: "focus",
              label: "Priorities this week",
              sessionKeys: ["agent:main:release", "agent:main:reliability", "agent:main:memory"],
            },
            { id: "reading", label: "Waiting on a reply", sessionKeys: ["agent:main:research"] },
          ],
        });
      });
      const sidebar = page.locator("openclaw-app-sidebar");
      const focus = sidebar.locator('[data-personal-session-group="focus"]');
      await focus.waitFor();
      await capture("1-sidebar.png", sidebar.locator(".sidebar-sessions"));
      expect(
        await sidebar.locator(".sidebar-sessions").evaluate((root) => {
          const pinned = root.querySelector(".sidebar-recent-sessions--pinned");
          const section = root.querySelector('[data-personal-session-group="focus"]');
          return Boolean(
            pinned &&
            section &&
            pinned.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
      ).toBe(true);
      // No heading: the icon distinguishes a personal section from a shared group.
      expect(
        await sidebar.locator(".personal-session-groups > .sidebar-recent-sessions__head").count(),
      ).toBe(0);
      expect(await focus.locator(".personal-session-groups__icon svg").count()).toBe(1);
      expect(
        await focus
          .locator(".sidebar-recent-session")
          .evaluateAll((items) => items.map((item) => item.getAttribute("data-session-key"))),
      ).toEqual([key, releaseKey, "agent:main:memory"]);

      // New section from Filter & sort: name and scope first, then choose sessions.
      await sidebar.getByRole("button", { name: /^Filter & sort/ }).click();
      const sortMenu = page.locator(".sidebar-session-sort-menu");
      await sortMenu.getByRole("button", { name: "New section", exact: true }).waitFor();
      await capture(
        "2-filter-sort-menu.png",
        sortMenu.getByRole("button", { name: "New section", exact: true }),
      );
      await sortMenu.getByRole("button", { name: "New section", exact: true }).click();
      const created = page.getByRole("dialog", { name: "New section", exact: true });
      await created.waitFor();
      await created.evaluate((element) =>
        Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished),
        ),
      );
      const height = (await created.boundingBox())?.height ?? 0;
      expect(height).toBeLessThanOrEqual(560);
      expect(await created.getByText("Only you", { exact: true }).isVisible()).toBe(true);
      expect(
        await created
          .getByText("Adding a session doesn't move it from its group.", { exact: true })
          .isVisible(),
      ).toBe(true);
      const scopes = created.getByRole("radiogroup", { name: "Choose sessions from" });
      expect(await scopes.getByRole("radio", { name: "My sessions" }).isChecked()).toBe(true);
      await capture("3-step1.png", created);
      await scopes.getByRole("radio", { name: "A project" }).check();
      await created.locator("#personal-section-project").click();
      await page.getByRole("option", { name: "clawhub", exact: true }).click();
      await capture("4-step1-project.png", created);
      await scopes.getByRole("radio", { name: "All sessions" }).check();
      const next = created.getByRole("button", { name: "Choose sessions", exact: true });
      expect(await next.isDisabled()).toBe(true);
      await created.getByLabel("Section name", { exact: true }).fill("Waiting on a reply");
      const beforeAll = (await gateway.getRequests("sessions.list")).length;
      await next.click();
      const sessions = created.getByRole("group", { name: "Sessions", exact: true });
      await sessions.getByRole("checkbox", { name: "Gateway memory audit" }).waitFor();
      // All sessions narrows nothing: the query carries no owner or relationship filter.
      const allRequest = (await gateway.getRequests("sessions.list")).slice(beforeAll).at(-1);
      expect(allRequest?.params).not.toHaveProperty("ownerId");
      expect(allRequest?.params).not.toHaveProperty("involvingMe");
      // Teammates' sessions name their owner; the viewer's own sessions do not.
      expect(await sessions.getByText("Maya", { exact: true }).first().isVisible()).toBe(true);
      expect((await created.boundingBox())?.height).toBe(height);
      await capture("5-step2-all.png", created);
      // The source is chosen only on step 1; Back returns there.
      await created.getByRole("button", { name: "Back", exact: true }).click();
      await scopes.getByRole("radio", { name: "My sessions" }).check();
      await next.click();
      await gateway.waitForRequest("sessions.list", { match: { ownerId: self } });
      await sessions.getByRole("checkbox", { name: "Bug triage" }).waitFor();
      expect(await sessions.getByRole("checkbox", { name: "Gateway memory audit" }).count()).toBe(
        0,
      );
      await created.getByRole("button", { name: "Cancel", exact: true }).click();

      // Editing opens on session choice; members outside the scope stay listed first.
      await sidebar
        .locator(".personal-session-groups__header", {
          has: page.getByRole("button", { name: "Options for section Priorities this week" }),
        })
        .hover();
      await sidebar
        .getByRole("button", { name: "Options for section Priorities this week", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Edit section", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit section", exact: true });
      const list = dialog.getByRole("group", { name: "Sessions", exact: true });
      await list.getByText("In this section", { exact: true }).waitFor();
      // Measure after the opening scale transition settles.
      await dialog.evaluate((element) =>
        Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished),
        ),
      );
      expect(await list.getByRole("checkbox", { name: "Gateway memory audit" }).isChecked()).toBe(
        true,
      );
      expect(await dialog.getByRole("searchbox").count()).toBe(0);
      await capture("6-edit.png", dialog);
      const listHeight = (await list.boundingBox())?.height;
      await dialog.getByRole("button", { name: "Search sessions", exact: true }).click();
      const search = dialog.getByRole("searchbox", { name: "Search sessions", exact: true });
      await expect.poll(() => search.evaluate((element) => element.matches(":focus"))).toBe(true);
      await search.fill("Release");
      // Search runs on the Gateway, so it reaches sessions outside the loaded sidebar page.
      await gateway.waitForRequest("sessions.list", { match: { search: "Release" } });
      // Enter filters; it must not save and close the editor.
      await search.press("Enter");
      expect(await dialog.isVisible()).toBe(true);
      await expect
        .poll(() => list.getByRole("checkbox", { name: "Roadmap review" }).count())
        .toBe(0);
      expect((await list.boundingBox())?.height).toBe(listHeight);
      // Leave the close button so its tooltip neither covers the proof nor takes Escape.
      await dialog.getByText("Adding a session doesn't move", { exact: false }).hover();
      await capture("7-search.png", dialog);
      await search.press("Escape");
      expect(await search.inputValue()).toBe("");
      await search.press("Escape");
      await expect.poll(() => dialog.getByRole("searchbox").count()).toBe(0);
      expect(await dialog.isVisible()).toBe(true);
      if (artifacts) {
        await evaluateControlUiContext(page, ({ theme }) => theme.setMode("dark"));
        await page.locator('html[data-theme-mode="dark"]').waitFor({ state: "attached" });
        await capture("8-edit-dark.png", dialog);
        await evaluateControlUiContext(page, ({ theme }) => theme.setMode("light"));
      }
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

      // From a teammate's session: it starts selected and stays listed as Added.
      await sidebar.getByRole("link", { name: /Incident follow-up/ }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Add to section", exact: true }).hover();
      await page.getByRole("menuitem", { name: "New section", exact: true }).waitFor();
      await capture(
        "9-session-menu.png",
        page.getByRole("menuitem", { name: "New section", exact: true }),
      );
      await page.getByRole("menuitem", { name: "New section", exact: true }).click();
      const fromSession = page.getByRole("dialog", { name: "New section", exact: true });
      await fromSession.getByLabel("Section name", { exact: true }).fill("Waiting on a reply");
      await fromSession.getByRole("button", { name: "Choose sessions", exact: true }).click();
      const fromList = fromSession.getByRole("group", { name: "Sessions", exact: true });
      await fromList.getByText("Added", { exact: true }).waitFor();
      expect(await fromList.getByRole("checkbox", { name: "Incident follow-up" }).isChecked()).toBe(
        true,
      );
      await capture("10-from-session.png", fromSession);
      await fromSession.getByRole("button", { name: "Save", exact: true }).click();
      await sidebar.getByRole("list", { name: "Waiting on a reply" }).first().waitFor();
      if (artifacts) {
        console.log("Sections proof: " + artifacts);
      }
    });
  });

  it.for(["operator.admin", "operator.sessions.read"])(
    "organizes a personal layout without shared mutations (%s)",
    async (scope) => {
      const capture =
        process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" && scope === "operator.sessions.read";
      const artifacts = capture
        ? createControlUiE2eArtifactDir(
            "personal-session-groups",
            process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
          )
        : undefined;
      await suite.withPage(
        {
          viewport: { width: 1280, height: 900 },
          ...(artifacts
            ? { recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } } }
            : {}),
        },
        async ({ page }) => {
          const childKey = "agent:main:reliability-child";
          const rows = [
            createControlUiSessionRow(key, "Reliability Tracker", Date.now(), {
              category: "Engineering",
              childSessions: [childKey],
            }),
            createControlUiSessionRow(releaseKey, "Release checklist", Date.now() - 1000),
            createControlUiSessionRow(childKey, "Verification notes", Date.now() - 2000, {
              spawnedBy: key,
            }),
          ];
          const gateway = await installMockGateway(page, {
            sessionKey: key,
            operatorScopes: [scope],
            sessions: rows,
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
          const sidebar = page.locator("openclaw-app-sidebar");
          await sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`).waitFor();
          expect(await sidebar.locator(".personal-session-groups").count()).toBe(0);
          if (artifacts) {
            await captureFrame(artifacts, "after-unused.png", page.locator(".shell"), [
              sidebar.locator(".sidebar-sessions"),
            ]);
          }
          const openCollections = async (sessionKey: string) => {
            await sidebar
              .locator('.sidebar-recent-session[data-session-key="' + sessionKey + '"]')
              .first()
              .click({ button: "right" });
            const panel = page.locator(".session-menu__panel").first();
            await panel.waitFor({ state: "visible" });
            // Shared organization stays present with its original guest disabled policy.
            const move = page.getByRole("menuitem", { name: "Move to group", exact: true });
            expect(await move.isDisabled()).toBe(scope === "operator.sessions.read");
            await page.getByRole("menuitem", { name: "Add to section", exact: true }).hover();
            await page.getByRole("menuitem", { name: "New section", exact: true }).waitFor();
          };
          // The first section is discoverable from the native session menu, without a heading.
          await openCollections(key);
          if (artifacts) {
            await captureFrame(artifacts, "native-discovery.png", page.locator(".shell"), [
              sidebar.locator(".sidebar-sessions"),
            ]);
          }
          await page.getByRole("menuitem", { name: "New section", exact: true }).click();
          const firstDialog = page.getByRole("dialog", { name: "New section", exact: true });
          await nameSection(firstDialog, "Focus");
          expect(
            await firstDialog
              .getByRole("checkbox", { name: "Reliability Tracker", exact: true })
              .isChecked(),
          ).toBe(true);
          if (artifacts) {
            await captureFrame(artifacts, "creation.png", page.locator(".shell"), [firstDialog]);
          }
          await firstDialog.getByRole("button", { name: "Save", exact: true }).click();
          await firstDialog.waitFor({ state: "hidden" });
          const create = async (label: string, selected?: string) => {
            await sidebar.getByRole("button", { name: /^Filter & sort/ }).click();
            await page
              .locator(".sidebar-session-sort-menu")
              .getByRole("button", { name: "New section", exact: true })
              .click();
            const dialog = page.getByRole("dialog", { name: "New section", exact: true });
            await nameSection(dialog, label);
            if (selected) {
              await dialog.getByRole("checkbox", { name: selected, exact: true }).check();
            }
            await dialog.getByRole("button", { name: "Save", exact: true }).click();
            await dialog.waitFor({ state: "hidden" });
          };
          const group = (label: string) =>
            sidebar
              .locator("[data-personal-session-group]")
              .filter({ has: page.getByRole("list", { name: label, exact: true }) });
          const options = async (label: string, action: string) => {
            await sidebar
              .locator(".personal-session-groups__header", {
                has: page.getByRole("button", {
                  name: `Options for section ${label}`,
                  exact: true,
                }),
              })
              .hover();
            await sidebar
              .getByRole("button", { name: `Options for section ${label}`, exact: true })
              .click();
            await page.getByRole("menuitem", { name: action, exact: true }).click();
          };
          const childToggle = sidebar
            .locator('[data-session-section="category:Engineering"]')
            .locator(`[data-child-session-toggle="${key}"]`);
          await childToggle.waitFor();
          if ((await childToggle.getAttribute("aria-expanded")) === "false") {
            await childToggle.click();
          }
          await sidebar.locator(`[data-session-key="${childKey}"]`).first().waitFor();

          await group("Focus")
            .getByRole("link", { name: /Reliability Tracker/ })
            .waitFor();
          if (artifacts) {
            await captureFrame(artifacts, "grouped-children.png", page.locator(".shell"), [
              group("Focus"),
              sidebar.locator('[data-session-section="category:Engineering"]'),
            ]);
            console.log("Personal group child-tree proof: " + artifacts);
          }
          await group("Focus")
            .getByRole("link", { name: /Verification notes/ })
            .waitFor();
          expect(await sidebar.locator(`[data-session-key="${childKey}"]`).count()).toBe(2);
          await create("Later");
          expect(
            await group("Later")
              .getByText("Drag sessions here or choose Edit section to add them.")
              .isVisible(),
          ).toBe(true);
          // Adding an existing reference is not a shared move, including for read-only guests.
          await openCollections(releaseKey);
          await page.getByRole("menuitem", { name: "Focus", exact: true }).click();
          await group("Focus")
            .getByRole("link", { name: /Release checklist/ })
            .waitFor();
          await options("Focus", "Edit section");
          const editor = page.getByRole("dialog", { name: "Edit section", exact: true });
          await nameSection(editor, "This week", { editing: true });
          await editor
            .getByRole("checkbox", { name: "Reliability Tracker", exact: true })
            .uncheck();
          await editor.getByRole("button", { name: "Save", exact: true }).click();
          await editor.waitFor({ state: "hidden" });
          expect(await group("This week").locator(".sidebar-recent-session").count()).toBe(1);
          await options("Later", "Move up");
          const order = () =>
            sidebar
              .locator("[data-personal-session-group] .sidebar-session-group-toggle")
              .allTextContents();
          await expect.poll(order).toEqual(["Later", "This week"]);
          // Native group dragging is also personal, with a keyboard menu equivalent above.
          await group("Later")
            .locator(".personal-session-groups__header")
            .dragTo(group("This week"));
          await expect.poll(order).toEqual(["This week", "Later"]);
          await page.reload();
          await expect.poll(order).toEqual(["This week", "Later"]);
          await group("This week")
            .getByRole("link", { name: /Release checklist/ })
            .waitFor();
          if (artifacts && process.env.OPENCLAW_PERSONAL_GROUP_PROOF_STAGE !== "before") {
            await captureFrame(artifacts, "after.png", page.locator(".shell"), [
              sidebar.locator(".sidebar-sessions"),
            ]);
            console.log("Personal groups after proof: " + artifacts);
          }
          await options("This week", "Remove section");
          await expect.poll(order).toEqual(["Later"]);
          expect(
            await sidebar
              .locator(`.sidebar-recent-session[data-session-key="${releaseKey}"]`)
              .count(),
          ).toBe(1);
          expect(
            await sidebar.locator('[data-session-section="category:Engineering"]').count(),
          ).toBe(1);
          await options("Later", "Remove section");
          expect(await sidebar.locator(".personal-session-groups").count()).toBe(0);
          await create("Empty by choice");
          expect(await group("Empty by choice").count()).toBe(1);
          console.log("Section UI proof: " + artifacts);
          for (const method of [
            "sessions.patch",
            "sessions.delete",
            "sessions.deleteMany",
            "sessions.groups.put",
            "sessions.groups.rename",
            "sessions.groups.delete",
            "config.patch",
          ]) {
            expect(await gateway.getRequests(method)).toEqual([]);
          }
        },
        async ({ page, context }) => {
          const video = page.video();
          await suite.closeBrowserContext(context);
          if (artifacts) {
            await video?.saveAs(path.join(artifacts, "personal-groups.webm"));
          }
        },
      );
    },
  );

  it("discovers sections without a selected session and keeps native compact Back", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.sessions.read"],
        sessions: [
          createControlUiSessionRow(key, "Reliability Tracker", Date.now(), {
            category: "Engineering",
          }),
        ],
      });
      await page.goto(suite.server.baseUrl + "new");
      await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
      await waitForMobileSidebarDrawerOpen(page);
      const sidebar = page.locator("openclaw-app-sidebar:visible");
      expect(await sidebar.locator(".personal-session-groups").count()).toBe(0);
      await sidebar.getByRole("button", { name: /^Filter & sort/ }).click();
      await page
        .locator(".sidebar-session-sort-menu")
        .getByRole("button", { name: "New section", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "New section", exact: true });
      await nameSection(dialog, "Reading");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await sidebar.getByRole("link", { name: /Reliability Tracker/ }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Add to section", exact: true }).click();
      await page.getByRole("menuitem", { name: "Back", exact: true }).waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const artifacts = createControlUiE2eArtifactDir("personal-collections-narrow");
        await captureFrame(artifacts, "narrow-menu.png", page.locator(".shell"), []);
      }
      await page.getByRole("menuitem", { name: "Back", exact: true }).click();
      expect(
        await page.getByRole("menuitem", { name: "Move to group", exact: true }).isDisabled(),
      ).toBe(true);
      await page.getByRole("menuitem", { name: "Add to section", exact: true }).click();
      await page.getByRole("menuitem", { name: "Reading", exact: true }).click();
      await sidebar
        .locator("[data-personal-session-group]")
        .getByRole("link", { name: /Reliability Tracker/ })
        .waitFor();
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      expect(await gateway.getRequests("sessions.groups.put")).toEqual([]);
    });
  });

  it("selects descriptor-only groups in visible order and batches each expanded member once", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const selected = createControlUiSessionRow(key, "Reliability Tracker", Date.now());
      const members = ["first", "middle", "last"].map((id) =>
        createControlUiSessionRow("agent:main:" + id, id + " project", Date.now()),
      );
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.admin"],
        sessions: [selected, ...members],
        methodResponses: { "sessions.list": sessionsListResponse([selected]) },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await evaluateControlUiContext(page, ({ navigation }) =>
        navigation.update({
          sidebarEntries: ["session:agent:main:first"],
          personalSessionGroups: [
            { id: "first", label: "First", sessionKeys: ["agent:main:first"] },
            { id: "middle", label: "Middle", sessionKeys: ["agent:main:middle"] },
            { id: "last", label: "Last", sessionKeys: ["agent:main:last", "agent:main:first"] },
          ],
        }),
      );
      const group = (id: string) => page.locator('[data-personal-session-group="' + id + '"]');
      const row = (id: string) =>
        group(id).getByRole("link", { name: id + " project", exact: true });
      for (const id of ["first", "middle", "last"]) {
        await row(id).waitFor();
      }
      await row("first").click({ modifiers: ["Alt"] });
      await row("last").click({ modifiers: ["Alt"] });
      await row("last").click({ button: "right" });
      const menu = page.locator("openclaw-session-menu");
      await expect
        .poll(() => menu.getByRole("menuitem", { name: "Archive 2", exact: true }).count())
        .toBe(1);
      await page.keyboard.press("Escape");

      // Ordinary navigation clears selection; Shift includes the intervening group.
      await page
        .locator("openclaw-app-sidebar")
        .getByRole("link", { name: /Reliability Tracker/ })
        .click();
      await row("first").click({ modifiers: ["Alt"] });
      await row("last").click({ modifiers: ["Shift"] });
      await row("last").click({ button: "right" });
      await expect
        .poll(() => menu.getByRole("menuitem", { name: "Archive 3", exact: true }).count())
        .toBe(1);
      await page.keyboard.press("Escape");

      // A duplicate's clicked appearance, not its first occurrence, bounds the range.
      await page
        .locator("openclaw-app-sidebar")
        .getByRole("link", { name: /Reliability Tracker/ })
        .click();
      await row("last").click({ modifiers: ["Alt"] });
      await group("last")
        .getByRole("link", { name: "first project", exact: true })
        .click({ modifiers: ["Shift"] });
      await row("last").click({ button: "right" });
      await expect
        .poll(() => menu.getByRole("menuitem", { name: "Archive 2", exact: true }).count())
        .toBe(1);
      await page.keyboard.press("Escape");
      await page
        .locator("openclaw-app-sidebar")
        .getByRole("link", { name: /Reliability Tracker/ })
        .click();
      await row("first").click({ modifiers: ["Alt"] });

      // Normal navigation must retain the clicked occurrence as the next Shift anchor.
      await group("last").getByRole("link", { name: "first project", exact: true }).click();
      await expect
        .poll(() =>
          group("last")
            .getByRole("link", { name: "first project", exact: true })
            .getAttribute("aria-current"),
        )
        .toBe("page");
      await row("last").click({ modifiers: ["Shift"] });
      await row("last").click({ button: "right" });
      await expect
        .poll(() =>
          menu
            .getByRole("menuitem", { name: /^Archive [0-9]+$/, exact: true })
            .getAttribute("aria-label"),
        )
        .toBe("Archive 2");
      await page.keyboard.press("Escape");
      await page
        .locator("openclaw-app-sidebar")
        .getByRole("link", { name: /Reliability Tracker/ })
        .click();
      await row("first").click({ modifiers: ["Alt"] });

      // A canonical pin must not inherit the first active personal-group appearance.
      const canonicalPin = page
        .locator('[data-session-section="pinned"]')
        .getByRole("link", { name: "first project", exact: true });
      const ordinary = page
        .locator("openclaw-app-sidebar")
        .getByRole("link", { name: /Reliability Tracker/ });
      await canonicalPin.click();
      await expect.poll(() => canonicalPin.getAttribute("aria-current")).toBe("page");
      await ordinary.click({ modifiers: ["Shift"] });
      await ordinary.click({ button: "right" });
      await expect
        .poll(() =>
          menu
            .getByRole("menuitem", { name: /^Archive [0-9]+$/, exact: true })
            .getAttribute("aria-label"),
        )
        .toBe("Archive 2");
      await page.keyboard.press("Escape");
      await ordinary.click();
      await row("first").click({ modifiers: ["Alt"] });

      // A collapsed group is not a batch target, and duplicate placements never duplicate writes.
      await group("middle").getByRole("button", { name: "Middle", exact: true }).click();
      await row("middle").waitFor({ state: "hidden" });
      await row("last").click({ modifiers: ["Shift"] });
      await row("last").click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Archive 2", exact: true }).click();
      const request = await gateway.waitForRequest("sessions.patchMany");
      expect(request.params).toMatchObject({
        patch: { archived: true },
        targets: [members[0], members[2]].map((member) => ({
          key: member!.key,
          agentId: "main",
          expectedSessionId: member!.sessionId,
        })),
      });
    });
  });

  it("rejects an open editor that would overwrite newer group membership", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const rows = [
        createControlUiSessionRow(key, "Reliability Tracker", Date.now()),
        createControlUiSessionRow(releaseKey, "Release checklist", Date.now()),
      ];
      await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.sessions.read"],
        sessions: rows,
        methodResponses: { "sessions.list": sessionsListResponse(rows) },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await evaluateControlUiContext(page, ({ navigation }) =>
        navigation.update({
          personalSessionGroups: [
            { id: "shared-tab", label: "Focus", sessionKeys: ["agent:main:reliability"] },
          ],
        }),
      );
      await page
        .locator(".personal-session-groups__header", {
          has: page.getByRole("button", { name: "Options for section Focus", exact: true }),
        })
        .hover();
      await page.getByRole("button", { name: "Options for section Focus", exact: true }).click();
      await page.getByRole("menuitem", { name: "Edit section", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit section", exact: true });
      await nameSection(dialog, "Renamed", { editing: true });
      // The preference owner receives a newer saved layout while this editor is open.
      await evaluateControlUiContext(page, ({ navigation }) =>
        navigation.update({
          personalSessionGroups: [
            { id: "shared-tab", label: "Focus", sessionKeys: ["agent:main:release"] },
          ],
        }),
      );
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog
        .getByRole("alert")
        .getByText("This section changed. Reopen it before saving your edits.", { exact: true })
        .waitFor();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      const group = page.locator('[data-personal-session-group="shared-tab"]');
      await group.getByRole("link", { name: /Release checklist/ }).waitFor();
      expect(await group.getByRole("link", { name: /Reliability Tracker/ }).count()).toBe(0);
      await page
        .locator(".personal-session-groups__header", {
          has: page.getByRole("button", { name: "Options for section Focus", exact: true }),
        })
        .hover();
      await page.getByRole("button", { name: "Options for section Focus", exact: true }).click();
      await page.getByRole("menuitem", { name: "Edit section", exact: true }).click();
      expect(
        await dialog.getByRole("checkbox", { name: "Release checklist", exact: true }).isChecked(),
      ).toBe(true);
      await nameSection(dialog, "Renamed", { editing: true });
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await group.getByRole("list", { name: "Renamed", exact: true }).waitFor();
      await group.getByRole("link", { name: /Release checklist/ }).waitFor();
    });
  });

  it("keeps a long membership list scrollable with visible completion actions", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 600 } }, async ({ page }) => {
      const rows = Array.from({ length: 60 }, (_, index) =>
        createControlUiSessionRow(
          index === 0 ? key : `agent:main:project-${index}`,
          index === 0 ? "Reliability Tracker" : `Project ${index} ${"long-name-".repeat(20)}`,
          Date.now() - index,
        ),
      );
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.sessions.read"],
        sessions: rows,
        methodResponses: { "sessions.list": sessionsListResponse(rows) },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await page
        .locator("openclaw-app-sidebar")
        .getByRole("button", { name: /^Filter & sort/ })
        .click();
      await page
        .locator(".sidebar-session-sort-menu")
        .getByRole("button", { name: "New section", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "New section", exact: true });
      await nameSection(dialog, "Long list");
      const choices = dialog.getByRole("group", { name: "Sessions", exact: true });
      await expect
        .poll(() => choices.evaluate((element) => element.scrollHeight > element.clientHeight))
        .toBe(true);
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      await expect
        .poll(() =>
          dialog.evaluate((element) =>
            [element.querySelector("input"), element.querySelector('button[type="submit"]')].every(
              (control) => {
                const rect = control!.getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= innerHeight;
              },
            ),
          ),
        )
        .toBe(true);
      await expect
        .poll(() => choices.evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const artifacts = createControlUiE2eArtifactDir(
          "personal-group-long-list",
          process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
        );
        await captureFrame(artifacts, "long-list.png", page.locator(".shell"), [dialog]);
        console.log("Personal group long-list proof: " + artifacts);
      }
      await choices.getByRole("checkbox").last().check();
      await save.click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByRole("list", { name: "Long list", exact: true }).getByRole("link").waitFor();
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      expect(await gateway.getRequests("sessions.groups.put")).toEqual([]);
    });
  });

  it("resolves off-page members without revealing unavailable saved references", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const selected = createControlUiSessionRow(key, "Reliability Tracker", Date.now());
      const offPage = createControlUiSessionRow(releaseKey, "Release checklist", Date.now());
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.sessions.read"],
        sessions: [selected, offPage],
        methodResponses: { "sessions.list": sessionsListResponse([selected]) },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await evaluateControlUiContext(page, ({ navigation }) =>
        navigation.update({
          personalSessionGroups: [
            {
              id: "saved",
              label: "Saved work",
              sessionKeys: ["agent:main:release", "agent:main:unavailable"],
            },
          ],
        }),
      );
      const group = page.locator('[data-personal-session-group="saved"]');
      await group.getByRole("link", { name: /Release checklist/ }).waitFor();
      expect(await group.locator(".sidebar-recent-session").count()).toBe(1);
      expect(await group.textContent()).not.toContain("unavailable");
      await evaluateControlUiContext(page, ({ navigation }) =>
        navigation.update({
          personalSessionGroups: [
            ...(navigation.snapshot.personalSessionGroups ?? []),
            { id: "later", label: "Later", sessionKeys: [] },
          ],
        }),
      );
      const openOffPageCollections = async () => {
        await group.getByRole("link", { name: /Release checklist/ }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Add to section", exact: true }).hover();
        await page.getByRole("menuitem", { name: "New section", exact: true }).waitFor();
      };
      await openOffPageCollections();
      await page.getByRole("menuitem", { name: "Later", exact: true }).click();
      await page
        .locator('[data-personal-session-group="later"]')
        .getByRole("link", { name: /Release checklist/ })
        .waitFor();
      await openOffPageCollections();
      await page.getByRole("menuitem", { name: "New section", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "New section", exact: true });
      await nameSection(dialog, "Release work");
      expect(
        await dialog.getByRole("checkbox", { name: "Release checklist", exact: true }).isChecked(),
      ).toBe(true);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await page
        .getByRole("list", { name: "Release work", exact: true })
        .getByRole("link", { name: /Release checklist/ })
        .waitFor();
      await page.reload();
      await group.getByRole("link", { name: /Release checklist/ }).waitFor();
      expect(await group.locator(".sidebar-recent-session").count()).toBe(1);
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      expect(await gateway.getRequests("sessions.groups.put")).toEqual([]);
    });
  });
});
