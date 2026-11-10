import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForSessionRosterHydration } from "./session-management.test-support.ts";
import { chooseSidebarOwner } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Selected agent session management" });
const viewer = { type: "human" as const, id: "viewer", label: "Viewer" };
const mentor = { type: "agent" as const, id: "mentor-a", label: "Mentor A" };
const ownedRow = (
  key: string,
  label: string,
  agentId: string,
  actor: typeof viewer | typeof mentor,
  options: Parameters<typeof sessionRow>[3] = {},
) => ({
  ...sessionRow(key, label, 100, options),
  agentId,
  owner: { actor },
});
const rows = [
  ownedRow("agent:main:dashboard:mine", "Main conversation", "main", viewer),
  ownedRow("agent:mentor-a:dashboard:mine", "Mentor conversation", "mentor-a", viewer),
  ownedRow("agent:mentor-a:telegram:group:students", "Student discussions", "mentor-a", mentor, {
    kind: "group",
  }),
  ownedRow("agent:mentor-a:dashboard:student", "Student A", "mentor-a", mentor, {
    parentSessionKey: "agent:mentor-a:telegram:group:students",
    category: "Students",
  }),
];

suite.define(() => {
  it.each([null, "viewer", "mentor-a"])(
    "keeps an agent's sessions scoped through switching and reload (explicit owner: %s)",
    (ownerId) =>
      suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
        async ({ page }) => {
          await page.addInitScript(
            ({ key }) =>
              localStorage.setItem(
                key,
                JSON.stringify({ sidebarAgentsMode: "chip", navWidth: 360 }),
              ),
            { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
          );
          const gateway = await installMockGateway(
            page,
            {
              authMode: "trusted-proxy",
              authMethod: "trusted-proxy",
              hasMultipleSessionSharingIdentities: true,
              sessions: rows,
              presenceUsers: [{ id: viewer.id, name: viewer.label, self: true }],
              sessionGroups: ["Students"],
              methodResponses: {
                "agents.list": agentRoster(
                  { main: "Main", "mentor-a": "Mentor A", "new-mentor": "New mentor" },
                  "main",
                  "per-sender",
                ),
              },
            },
            {
              requestHandlers: {
                "sessions.list": (params) => {
                  const query = params as { agentId?: string; ownerId?: string };
                  const sessions = rows.filter(
                    (row) =>
                      (!query.agentId || row.agentId === query.agentId) &&
                      (!query.ownerId || row.owner?.actor.id === query.ownerId),
                  );
                  return {
                    ts: 100,
                    path: "",
                    count: sessions.length,
                    sessions,
                    defaults: {},
                    owners: [viewer, mentor].filter((owner) =>
                      rows.some(
                        (row) =>
                          (!query.agentId || row.agentId === query.agentId) &&
                          row.owner.actor.id === owner.id,
                      ),
                    ),
                    hasMore: false,
                  };
                },
              },
            },
          );
          await page.goto(`${suite.server.baseUrl}chat/mentor-a`);
          await page.locator(".agent-chat__composer-combobox textarea").waitFor();
          await waitForSessionRosterHydration(page);
          const sidebar = page.locator("openclaw-app-sidebar");
          if (ownerId) {
            await chooseSidebarOwner(page, `owner:${ownerId}`);
          }
          const surface = sidebar.locator("aside.sidebar");
          const frame = await takeControlUiScreenshotFrame(page, surface, [], {
            elements: [surface],
            animations: "disabled",
          });
          await writeFile(
            path.join(suite.artifactDir, `agent-scope-${ownerId ?? "all"}.png`),
            frame.elements[0]!.png,
          );
          if (!ownerId) {
            expect(await sidebar.locator("#sidebar-session-owner-title").textContent()).toContain(
              "All owners",
            );
          }
          if (!ownerId) {
            const list = await gateway.waitForRequest("sessions.list", {
              match: { agentId: "mentor-a" },
            });
            expect(list.params).toMatchObject({ agentId: "mentor-a" });
          }
          if (ownerId !== mentor.id) {
            await sidebar.locator('[data-session-key="agent:mentor-a:dashboard:mine"]').waitFor();
          }
          expect(
            await sidebar.locator('[data-session-key="agent:main:dashboard:mine"]').count(),
          ).toBe(0);
          await expect
            .poll(() =>
              sidebar.locator('[data-session-key="agent:mentor-a:dashboard:student"]').count(),
            )
            .toBe(!ownerId || ownerId === mentor.id ? 1 : 0);
          for (const id of ["main", "new-mentor"]) {
            await sidebar.getByRole("button", { name: /Switch agent/ }).click();
            await sidebar.locator(`[data-value="agent:${id}"]`).click();
            await expect
              .poll(() => sidebar.locator(".sidebar-agent-card__main").getAttribute("aria-label"))
              .toContain(id === "main" ? "Main" : "New mentor");
            if (id === "new-mentor") {
              await gateway.waitForRequest("sessions.list", {
                match: {
                  agentId: id,
                  ...(ownerId ? { ownerId } : {}),
                },
              });
            } else if (ownerId !== mentor.id) {
              await sidebar.locator('[data-session-key="agent:main:dashboard:mine"]').waitFor();
            }
            await waitForSessionRosterHydration(page);
            expect(await sidebar.locator('[data-session-key^="agent:mentor-a:"]').count()).toBe(0);
            if (id === "new-mentor") {
              expect(await sidebar.locator("[data-session-key]").count()).toBe(0);
            }
          }
          await page.reload();
          await page.locator(".agent-chat__composer-combobox textarea").waitFor();
          await waitForSessionRosterHydration(page);
          await gateway.waitForRequest("sessions.list", {
            match: { agentId: "new-mentor", ...(ownerId ? { ownerId } : {}) },
          });
          expect(await sidebar.locator("[data-session-key]").count()).toBe(0);
        },
      ),
  );
});
