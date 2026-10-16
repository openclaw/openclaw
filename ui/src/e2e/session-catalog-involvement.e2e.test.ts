import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";
import {
  chooseSidebarMenuOption,
  chooseSidebarOwner,
  closeSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Catalog session involvement" });

suite.define(() => {
  it("keeps only Gateway-admitted catalog conversations under Involving me", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const sidebar = page.locator(".sidebar");
      const viewer = {
        type: "human" as const,
        id: "profile-ada",
        label: "Ada",
        identity: { type: "profile" as const, id: "profile-ada" },
      };
      const other = {
        type: "human" as const,
        id: "profile-bob",
        label: "Bob",
        identity: { type: "profile" as const, id: "profile-bob" },
      };
      const native = {
        key: "agent:main:own",
        sessionId: "own",
        kind: "direct" as const,
        label: "My conversation",
        owner: { actor: viewer },
        updatedAt: 3,
      };
      // Gateway involvement can include participation beyond the bounded avatar preview.
      const involved = {
        key: "agent:main:involved-catalog",
        sessionId: "involved",
        kind: "direct" as const,
        label: "Collaborative coding",
        owner: { actor: other },
        updatedAt: 2,
      };
      const unrelated = {
        key: "agent:main:unrelated-catalog",
        sessionId: "unrelated",
        kind: "direct" as const,
        label: "Another person's coding",
        owner: { actor: other },
        updatedAt: 1,
      };
      const response = {
        ts: 1,
        path: "",
        count: 3,
        hasMore: false,
        nextOffset: null,
        defaults: { contextTokens: null, model: null, modelProvider: null },
        owners: [viewer, other],
        sessions: [native, involved, unrelated],
      };
      const entry = (threadId: string, name: string, sessionKey?: string) => ({
        threadId,
        name,
        sessionKey,
        status: "stored",
        archived: false,
        canContinue: true,
        canArchive: false,
        createdActor: other,
      });
      const catalogs = [
        {
          id: "session-share",
          label: "OpenClaw sessions",
          capabilities: { continueSession: false, archive: false },
          hosts: [
            {
              hostId: "node:remote",
              label: "Remote",
              kind: "node",
              connected: true,
              sessions: [entry("shared", "Remote shared conversation")],
            },
          ],
        },
        {
          id: "beam",
          label: "Beam",
          capabilities: { continueSession: false, archive: false },
          hosts: [
            {
              hostId: "gateway",
              label: "Imported",
              kind: "gateway",
              connected: true,
              sessions: [entry("imported", "Imported meeting")],
            },
          ],
        },
        {
          id: "codex",
          label: "Coding",
          capabilities: { continueSession: true, archive: false },
          hosts: [
            {
              hostId: "gateway:local",
              label: "Local",
              kind: "gateway",
              connected: true,
              sessions: [
                entry("involved", involved.label, involved.key),
                entry("unrelated", unrelated.label, unrelated.key),
              ],
            },
          ],
        },
      ];
      const gateway = await installMockGateway(page, {
        sessionKey: native.key,
        presenceUsers: [{ self: true, id: viewer.id, name: viewer.label }],
        sessions: [native, involved, unrelated],
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
        methodResponses: {
          "sessions.list": {
            cases: [
              {
                match: { involvingMe: true },
                response: { ...response, count: 2, sessions: [native, involved] },
              },
              { response },
            ],
          },
          "sessions.catalog.list": { catalogs },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, native.key));
      await selectAllSidebarSessions(page);
      await chooseSidebarMenuOption(page, "Status", "All");
      await closeSidebarMenu(page);
      // Coding starts collapsed; open each source so filter assertions inspect actual rows.
      const coding = page.getByRole("button", { name: "Coding", exact: true });
      if (await coding.count()) {
        await coding.click();
      }
      for (const id of ["session-share", "beam", "codex"]) {
        const toggle = page
          .locator(`[data-session-section="catalog:${id}"] .sidebar-session-group-toggle`)
          .first();
        if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) === "false") {
          await toggle.click();
        }
      }
      await expectBrowser(
        sidebar.getByText("Remote shared conversation", { exact: true }),
      ).toBeVisible();
      await expectBrowser(sidebar.getByText("Imported meeting", { exact: true })).toBeVisible();
      await expectBrowser(sidebar.getByText(involved.label, { exact: true })).toBeVisible();
      await chooseSidebarOwner(page, "involving-me");
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) => (request.params as { involvingMe?: boolean }).involvingMe === true,
          ),
        )
        .toBe(true);
      await expectBrowser(sidebar.getByText(native.label, { exact: true })).toBeVisible();
      await expectBrowser(sidebar.getByText(involved.label, { exact: true })).toBeVisible();
      const artifactParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactParent) {
        const directory = createControlUiE2eArtifactDir("catalog-involvement", artifactParent);
        await writeFile(
          path.join(directory, "involving-me.png"),
          (
            await takeControlUiScreenshotFrame(
              page,
              page.locator(".sidebar"),
              [
                page.locator("#sidebar-session-owner-title"),
                sidebar.getByText(native.label, { exact: true }),
                sidebar.getByText(involved.label, { exact: true }),
              ],
              { animations: "disabled" },
            )
          ).png,
        );
      }
      await expectBrowser(
        sidebar.getByText("Remote shared conversation", { exact: true }),
      ).toHaveCount(0);
      await expectBrowser(sidebar.getByText("Imported meeting", { exact: true })).toHaveCount(0);
      await expectBrowser(sidebar.getByText(unrelated.label, { exact: true })).toHaveCount(0);
      await selectAllSidebarSessions(page);
      await expectBrowser(
        sidebar.getByText("Remote shared conversation", { exact: true }),
      ).toBeVisible();
      await expectBrowser(sidebar.getByText("Imported meeting", { exact: true })).toBeVisible();
      await expectBrowser(sidebar.getByText(unrelated.label, { exact: true })).toBeVisible();
    });
  });
});
