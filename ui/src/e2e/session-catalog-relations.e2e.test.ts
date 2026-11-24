import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { ownerRoster, sessionPerson } from "./session-ownership-fixtures.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";
import {
  chooseSidebarMenuOption,
  chooseSidebarOwner,
  closeSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Shared catalog relationship queries" });
suite.define(() => {
  it("keeps remote involvement through paging and chat reads and shows unsupported guidance", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const viewer = sessionPerson("profile-ada", "Ada");
      const native = {
        key: "agent:main:local",
        sessionId: "local",
        kind: "direct" as const,
        label: "Local conversation",
        owner: { actor: viewer },
        updatedAt: 1,
      };
      const relation = { relationship: "involving", target: { type: "me" } } as const;
      const entry = (threadId: string, name: string) => ({
        threadId,
        name,
        status: "idle",
        archived: false,
        canContinue: false,
        canArchive: false,
      });
      const catalog = (
        sessions: unknown[],
        profileRelation?: unknown,
        nextCursor?: string,
        error?: { code: string; message: string },
      ) => ({
        catalogs: [
          {
            id: "openclaw",
            label: "OpenClaw sessions",
            capabilities: {
              continueSession: false,
              archive: false,
              profileRelation: true,
            },
            hosts: [
              {
                hostId: "node:team",
                ...(profileRelation ? { profileRelation } : {}),
                label: "Team Gateway",
                kind: "node",
                connected: true,
                sessions,
                ...(nextCursor ? { nextCursor } : {}),
                ...(error ? { error } : {}),
              },
            ],
          },
        ],
      });
      const gateway = await installMockGateway(page, {
        sessionKey: native.key,
        presenceUsers: [{ self: true, id: viewer.id, name: viewer.label }],
        sessions: [native],
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "sessions.catalog.list",
          "sessions.catalog.read",
          "sessions.catalog.import",
        ],
        historyMessages: [],
        methodResponses: {
          "sessions.list": ownerRoster([native], [viewer, sessionPerson("profile-bob", "Bob")]),
          "sessions.catalog.list": {
            cases: [
              {
                match: { profileRelation: relation, cursors: { "node:team": "next" } },
                response: catalog([entry("remote-two", "Mentioned on source")], relation),
              },
              {
                match: { profileRelation: relation },
                response: catalog(
                  [entry("remote-one", "Participated on source")],
                  relation,
                  "next",
                ),
              },
              {
                match: { profileRelation: { relationship: "owned", target: { type: "me" } } },
                response: catalog(
                  [
                    {
                      ...entry("fallback", "Authorized fallback conversation"),
                      createdActor: viewer,
                    },
                  ],
                  undefined,
                  undefined,
                  {
                    code: "FILTER_PARTIAL",
                    message:
                      "Showing authorized rows with client-side matching. Check the source identity link.",
                  },
                ),
              },
              { response: catalog([entry("unrelated", "Unrelated source conversation")]) },
            ],
          },
          "sessions.catalog.read": {
            hostId: "node:team",
            threadId: "remote-two",
            items: [
              { id: "message", type: "agentMessage", text: "Remote transcript stays filtered" },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, native.key));
      await selectAllSidebarSessions(page);
      await chooseSidebarMenuOption(page, "Status", "All");
      await closeSidebarMenu(page);
      await expectBrowser(
        page.locator(".sidebar").getByText("Unrelated source conversation", { exact: true }),
      ).toBeVisible();
      const artifacts = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const directory = artifacts
        ? createControlUiE2eArtifactDir("catalog-relations", artifacts)
        : undefined;
      if (directory) {
        await writeFile(
          path.join(directory, "before-filter.png"),
          await page.screenshot({ animations: "disabled" }),
        );
      }
      await chooseSidebarOwner(page, "involving-me");
      const sidebar = page.locator(".sidebar");
      const group = sidebar.locator('[data-session-section="catalog:openclaw"]');
      const toggle = group.locator(".sidebar-session-group-toggle").first();
      if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
      }
      await expectBrowser(
        sidebar.getByText("Participated on source", { exact: true }),
      ).toBeVisible();
      await expectBrowser(
        sidebar.getByText("Unrelated source conversation", { exact: true }),
      ).toHaveCount(0);
      await group.getByRole("button", { name: "Show more", exact: true }).click();
      await expectBrowser(sidebar.getByText("Mentioned on source", { exact: true })).toBeVisible();
      if (directory) {
        await writeFile(
          path.join(directory, "involving-me.png"),
          await page.screenshot({ animations: "disabled" }),
        );
      }
      await sidebar.getByText("Mentioned on source", { exact: true }).click();
      await expect
        .poll(
          async () =>
            (
              await gateway.getRequests("sessions.catalog.read", {
                profileRelation: relation,
                threadId: "remote-two",
              })
            ).length,
        )
        .toBeGreaterThan(0);
      await expectBrowser(
        page.getByText("Remote transcript stays filtered", { exact: true }),
      ).toBeVisible();
      await chooseSidebarOwner(page, `owner:${viewer.id}`);
      await expectBrowser(
        group.locator(".sidebar-session-group-toggle").first(),
      ).toHaveAccessibleName(
        /Showing authorized rows with client-side matching\. Check the source identity link\./,
      );
      await expectBrowser(
        sidebar.getByText("Authorized fallback conversation", { exact: true }),
      ).toBeVisible();
      await expectBrowser(
        sidebar.getByText("Unrelated source conversation", { exact: true }),
      ).toHaveCount(0);
    });
  });
});
