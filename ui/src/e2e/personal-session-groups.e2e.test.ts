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
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const rows = [
          createControlUiSessionRow(key, "Reliability Tracker", Date.now(), {
            category: "Engineering",
          }),
          createControlUiSessionRow(releaseKey, "Release checklist", Date.now() - 1000),
        ];
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          operatorScopes: [scope],
          sessions: rows,
          methodResponses: { "sessions.list": sessionsListResponse(rows) },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`).waitFor();
        const capture =
          process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" && scope === "operator.sessions.read";
        const artifacts = capture
          ? createControlUiE2eArtifactDir(
              "personal-session-groups",
              process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
            )
          : undefined;
        if (artifacts && process.env.OPENCLAW_PERSONAL_GROUP_PROOF_STAGE === "before") {
          await captureFrame(artifacts, "before.png", page.locator(".shell"), [
            sidebar.locator(".sidebar-sessions"),
          ]);
          console.log("Personal groups before proof: " + artifacts);
        }
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
        await create("Focus", "Reliability Tracker");
        await group("Focus")
          .getByRole("link", { name: /Reliability Tracker/ })
          .waitFor();
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
        await editor.getByRole("checkbox", { name: "Reliability Tracker", exact: true }).uncheck();
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
        await group("Later").locator(".personal-session-groups__header").dragTo(group("This week"));
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
        await options("This week", "Remove personal group");
        await expect.poll(order).toEqual(["Later"]);
        expect(
          await sidebar
            .locator(`.sidebar-recent-session[data-session-key="${releaseKey}"]`)
            .count(),
        ).toBe(1);
        expect(await sidebar.locator('[data-session-section="category:Engineering"]').count()).toBe(
          1,
        );
        for (const method of [
          "sessions.patch",
          "sessions.groups.put",
          "sessions.groups.rename",
          "sessions.groups.delete",
          "config.patch",
        ]) {
          expect(await gateway.getRequests(method)).toEqual([]);
        }
      });
    },
  );

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
