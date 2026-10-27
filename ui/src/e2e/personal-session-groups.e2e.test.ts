import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();
const key = "agent:main:reliability";
const releaseKey = "agent:main:release";

suite.define(() => {
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
          const heading = sidebar.locator(".personal-session-groups__heading");
          const addGroup = heading.getByRole("button", { name: "New personal group", exact: true });
          await addGroup.hover();
          if (artifacts) {
            await captureFrame(
              artifacts,
              process.env.OPENCLAW_PERSONAL_GROUP_PROOF_STAGE === "before"
                ? "before.png"
                : "add-button-hover.png",
              page.locator(".shell"),
              [sidebar.locator(".sidebar-sessions")],
            );
            console.log("Personal groups add button proof: " + artifacts);
          }
          // The add button stays at the trailing edge without a row or button hover fill.
          await expect
            .poll(() =>
              heading.evaluate((element) => {
                const button = element.querySelector("button")!;
                return Math.round(
                  element.getBoundingClientRect().right - button.getBoundingClientRect().right,
                );
              }),
            )
            .toBe(10);
          await expect
            .poll(() => heading.evaluate((element) => getComputedStyle(element).backgroundColor))
            .toBe("rgba(0, 0, 0, 0)");
          await expect
            .poll(() => addGroup.evaluate((element) => getComputedStyle(element).backgroundColor))
            .toBe("rgba(0, 0, 0, 0)");
          const hoverColor = await addGroup.evaluate((element) => getComputedStyle(element).color);
          await page.mouse.move(900, 600);
          await expect
            .poll(() => addGroup.evaluate((element) => getComputedStyle(element).color))
            .not.toBe(hoverColor);
          await addGroup.focus();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Shift+Tab");
          expect(await addGroup.evaluate((element) => element.matches(":focus-visible"))).toBe(
            true,
          );
          expect(
            await addGroup.evaluate((element) => getComputedStyle(element).outlineStyle),
          ).not.toBe("none");
          const create = async (label: string, selected?: string) => {
            await sidebar.getByRole("button", { name: "New personal group", exact: true }).click();
            const dialog = page.getByRole("dialog", { name: "New personal group", exact: true });
            await dialog.getByLabel("Group name", { exact: true }).fill(label);
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
              .getByRole("button", { name: `Options for personal group ${label}`, exact: true })
              .click();
            await page.getByRole("menuitem", { name: action, exact: true }).click();
          };
          const childToggle = sidebar.locator(`[data-child-session-toggle="${key}"]`);
          await childToggle.waitFor();
          if ((await childToggle.getAttribute("aria-expanded")) === "false") {
            await childToggle.click();
          }
          await sidebar.locator(`[data-session-key="${childKey}"]`).waitFor();
          await create("Focus", "Reliability Tracker");
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
          // A guest's ordinary session drag adds a personal reference, not a shared move.
          await sidebar
            .locator(`.sidebar-recent-session[data-session-key="${releaseKey}"]`)
            .dragTo(group("Focus"));
          await group("Focus")
            .getByRole("link", { name: /Release checklist/ })
            .waitFor();
          await options("Focus", "Edit group");
          const editor = page.getByRole("dialog", { name: "Edit personal group", exact: true });
          await editor.getByLabel("Group name", { exact: true }).fill("This week");
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
            await addGroup.hover();
            await captureFrame(artifacts, "after.png", page.locator(".shell"), [
              sidebar.locator(".sidebar-sessions"),
            ]);
            console.log("Personal groups after proof: " + artifacts);
          }
          await options("This week", "Remove personal group");
          await expect.poll(order).toEqual(["Later"]);
          expect(
            await sidebar
              .locator(`.sidebar-recent-session[data-session-key="${releaseKey}"]`)
              .count(),
          ).toBe(1);
          expect(
            await sidebar.locator('[data-session-section="category:Engineering"]').count(),
          ).toBe(1);
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
        .getByRole("button", { name: "Options for personal group Focus", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Edit group", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit personal group", exact: true });
      await dialog.getByLabel("Group name", { exact: true }).fill("Renamed");
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
        .getByText("This group changed. Reopen it before saving your edits.", { exact: true })
        .waitFor();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      const group = page.locator('[data-personal-session-group="shared-tab"]');
      await group.getByRole("link", { name: /Release checklist/ }).waitFor();
      expect(await group.getByRole("link", { name: /Reliability Tracker/ }).count()).toBe(0);
      await page
        .getByRole("button", { name: "Options for personal group Focus", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Edit group", exact: true }).click();
      expect(
        await dialog.getByRole("checkbox", { name: "Release checklist", exact: true }).isChecked(),
      ).toBe(true);
      await dialog.getByLabel("Group name", { exact: true }).fill("Renamed");
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
      await page.getByRole("button", { name: "New personal group", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "New personal group", exact: true });
      await dialog.getByLabel("Group name", { exact: true }).fill("Long list");
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
      await page.reload();
      await group.getByRole("link", { name: /Release checklist/ }).waitFor();
      expect(await group.locator(".sidebar-recent-session").count()).toBe(1);
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      expect(await gateway.getRequests("sessions.groups.put")).toEqual([]);
    });
  });
});
