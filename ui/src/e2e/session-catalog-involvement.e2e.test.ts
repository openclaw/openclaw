import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { ownerRoster, sessionPerson } from "./session-ownership-fixtures.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";
import {
  chooseSidebarMenuOption,
  chooseSidebarOwner,
  closeSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Catalog session involvement" });

suite.define(() => {
  it("preserves mixed-provider involvement and carries the Team selection into reads", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const sidebar = page.locator(".sidebar");
      const viewer = sessionPerson("profile-ada", "Ada");
      const other = sessionPerson("profile-bob", "Bob");
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
        ...ownerRoster([native, involved, unrelated], [viewer, other]),
        hasMore: false,
        nextOffset: null,
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
                entry("unlinked", "Unlinked conversation"),
                entry("involved", involved.label, involved.key),
                entry("unrelated", unrelated.label, unrelated.key),
              ],
            },
          ],
        },
      ];
      const profileRelation = { relationship: "involving", target: { type: "me" } };
      const teamEntry = {
        ...entry("team-mentioned", "Team mention conversation"),
        canContinue: false,
      };
      const team = {
        id: "openclaw",
        label: "Team",
        capabilities: { continueSession: false, archive: false, profileRelation: true },
        requiresFreshList: true,
        hosts: [
          {
            hostId: "node:team",
            nodeId: "team",
            label: "Team source",
            kind: "node",
            connected: true,
            sessions: [
              teamEntry,
              { ...entry("team-unrelated", "Unrelated Team conversation"), canContinue: false },
            ],
          },
        ],
      };
      const selectedTeam = { ...team, hosts: [{ ...team.hosts[0], sessions: [teamEntry] }] };
      const gateway = await installMockGateway(page, {
        sessionKey: native.key,
        presenceUsers: [{ self: true, id: viewer.id, name: viewer.label }],
        sessions: [native, involved, unrelated],
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "sessions.catalog.list",
          "sessions.catalog.read",
        ],
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
          "sessions.catalog.list": {
            cases: [
              {
                match: { metadataOnly: true },
                response: {
                  catalogs: [...catalogs, team].map((catalog) => ({
                    id: catalog.id,
                    label: catalog.label,
                    capabilities: catalog.capabilities,
                    requiresFreshList:
                      "requiresFreshList" in catalog ? catalog.requiresFreshList : undefined,
                    hosts: [],
                  })),
                },
              },
              {
                match: { catalogId: "openclaw", profileRelation },
                response: { catalogs: [selectedTeam] },
              },
              { match: { catalogId: "openclaw" }, response: { catalogs: [team] } },
              { match: { catalogId: "codex" }, response: { catalogs } },
              { response: { catalogs: [...catalogs, team] } },
            ],
          },
          "sessions.catalog.read": {
            hostId: "node:team",
            threadId: "team-mentioned",
            items: [{ type: "agentMessage", text: "Selected Team transcript" }],
          },
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
      // Open the source so filter assertions inspect actual rows.
      for (const [id, label] of [
        ["codex", "Coding"],
        ["openclaw", "Team"],
      ]) {
        const source = page.getByRole("button", { name: label, exact: true });
        if (await source.count()) {
          await source.click();
        }
        const toggle = page
          .locator(`[data-session-section="catalog:${id}"] .sidebar-session-group-toggle`)
          .first();
        if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) === "false") {
          await toggle.click();
        }
      }
      await expectVisible("Unlinked conversation", involved.label, "Unrelated Team conversation");
      await chooseSidebarOwner(page, "involving-me");
      await expect
        .poll(
          async () => (await gateway.getRequests("sessions.list", { involvingMe: true })).length,
        )
        .toBeGreaterThan(0);
      await expectVisible(native.label, involved.label, teamEntry.name);
      await expect
        .poll(
          async () =>
            (
              await gateway.getRequests("sessions.catalog.list", {
                catalogId: "openclaw",
                profileRelation,
              })
            ).length,
        )
        .toBeGreaterThan(0);
      const codingRequests = await gateway.getRequests("sessions.catalog.list", {
        catalogId: "codex",
      });
      expect(codingRequests.length).toBeGreaterThan(0);
      for (const request of codingRequests) {
        expect(request.params).not.toHaveProperty("profileRelation");
      }
      await expectBrowser(text("Unrelated Team conversation")).toHaveCount(0);
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
      await expectBrowser(text("Unlinked conversation")).toHaveCount(0);
      await expectBrowser(text(unrelated.label)).toHaveCount(0);
      await text(teamEntry.name).click();
      await expectBrowser(
        page.getByText("Selected Team transcript", { exact: true }),
      ).toBeVisible();
      expect((await gateway.getRequests("sessions.catalog.read")).at(-1)?.params).toMatchObject({
        catalogId: "openclaw",
        hostId: "node:team",
        threadId: "team-mentioned",
        profileRelation,
      });
      await selectAllSidebarSessions(page);
      await expectVisible("Unlinked conversation", unrelated.label, "Unrelated Team conversation");
    });
  });
});
