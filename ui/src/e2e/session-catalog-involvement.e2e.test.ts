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
      const actor = (id: string, label: string) => ({
        type: "human" as const,
        id,
        label,
        identity: { type: "profile" as const, id },
      });
      const viewer = actor("profile-ada", "Ada");
      const other = actor("profile-bob", "Bob");
      const session = (sessionId: string, label: string, updatedAt: number, owner = other) => ({
        key: `agent:main:${sessionId === "own" ? sessionId : `${sessionId}-catalog`}`,
        sessionId,
        kind: "direct" as const,
        label,
        owner: { actor: owner },
        updatedAt,
      });
      const native = session("own", "My conversation", 3, viewer);
      // Gateway involvement can include participation beyond the bounded avatar preview.
      const involved = session("involved", "Collaborative coding", 2);
      const unrelated = session("unrelated", "Another person's coding", 1);
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
      const catalog = (
        id: string,
        label: string,
        hostId: string,
        hostLabel: string,
        sessions: ReturnType<typeof entry>[],
        continueSession = false,
      ) => ({
        id,
        label,
        capabilities: { continueSession, archive: false },
        hosts: [
          {
            hostId,
            label: hostLabel,
            kind: hostId.startsWith("node:") ? "node" : "gateway",
            connected: true,
            sessions,
          },
        ],
      });
      const catalogs = [
        catalog("session-share", "OpenClaw sessions", "node:remote", "Remote", [
          entry("shared", "Remote shared conversation"),
        ]),
        catalog("beam", "Beam", "gateway", "Imported", [entry("imported", "Imported meeting")]),
        catalog(
          "codex",
          "Coding",
          "gateway:local",
          "Local",
          [
            entry("involved", involved.label, involved.key),
            entry("unrelated", unrelated.label, unrelated.key),
          ],
          true,
        ),
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
      const text = (label: string) => sidebar.getByText(label, { exact: true });
      const expectVisible = async (...labels: string[]) => {
        for (const label of labels) {
          await expectBrowser(text(label)).toBeVisible();
        }
      };
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
      await expectVisible("Remote shared conversation", "Imported meeting", involved.label);
      await chooseSidebarOwner(page, "involving-me");
      await expect
        .poll(
          async () => (await gateway.getRequests("sessions.list", { involvingMe: true })).length,
        )
        .toBeGreaterThan(0);
      await expectVisible(native.label, involved.label);
      const artifactParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactParent) {
        const directory = createControlUiE2eArtifactDir("catalog-involvement", artifactParent);
        const frame = await takeControlUiScreenshotFrame(
          page,
          sidebar,
          [page.locator("#sidebar-session-owner-title"), text(native.label), text(involved.label)],
          { animations: "disabled" },
        );
        await writeFile(path.join(directory, "involving-me.png"), frame.png);
      }
      await expectBrowser(text("Remote shared conversation")).toHaveCount(0);
      await expectBrowser(text("Imported meeting")).toHaveCount(0);
      await expectBrowser(text(unrelated.label)).toHaveCount(0);
      await selectAllSidebarSessions(page);
      await expectVisible("Remote shared conversation", "Imported meeting", unrelated.label);
    });
  });
});
