import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { routeAvatarFixtures } from "./session-ownership-visuals.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI assigned owner header",
  startServerBeforeBrowser: true,
});
const phase = process.env.OPENCLAW_OWNER_ASSIGNMENT_PROOF_PHASE;
const sessionKey = "agent:main:dashboard:assigned-owner";
const createPerson = (label: string) => ({
  type: "human" as const,
  id: label.toLowerCase(),
  identity: { type: "profile" as const, id: label.toLowerCase() },
  label,
  avatarUrl: `/api/users/${label.toLowerCase()}/avatar?v=1`,
});
const people = [createPerson("Patrick"), createPerson("Vyctor")] as const;
const [creator, assignee] = people;

suite.define(() => {
  it.each([1440, 390])(
    "keeps the assigned owner visible with sharing at width %i",
    async (width) => {
      const viewport = { width, height: 900 };
      await suite.withPage(
        {
          viewport,
          locale: "en-US",
          colorScheme: "dark",
          serviceWorkers: "block",
          ...(phase ? { recordVideo: { dir: suite.artifactDir, size: viewport } } : {}),
        },
        async ({ page }) => {
          await routeAvatarFixtures(
            page,
            people.map((person, index) => ({
              id: person.id,
              label: person.label.charAt(0),
              background: index ? "#2563eb" : "#7c3aed",
            })),
          );
          const row = {
            key: sessionKey,
            kind: "direct",
            label: "Test",
            updatedAt: 1,
            visibility: "shared",
            sharingRole: "owner",
            createdActor: creator,
            owner: { actor: creator },
            participants: [],
            participantCount: 0,
          };
          const list = { count: 1, owners: people, defaults: {}, path: "", sessions: [row], ts: 1 };
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessions: [row],
            historyMessages: [{ role: "assistant", content: "Received—I'm here." }],
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "sessions.assignOwner",
              "users.list",
            ],
            hasMultipleSessionSharingIdentities: true,
            operatorScopes: ["operator.read", "operator.write"],
            presenceUsers: [
              { self: true, id: creator.id, identity: creator.identity, name: creator.label },
            ],
            methodResponses: {
              "sessions.list": list,
              "session.members.listEvidence": {
                sessionKey,
                owner: creator,
                members: [],
                identities: people,
                role: "owner",
                allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
              },
              "users.list": {
                profiles: people.map((person) => ({
                  id: person.id,
                  displayName: person.label,
                  hasAvatar: true,
                  avatarMime: "image/png",
                  mergedInto: null,
                  createdAt: 1,
                  updatedAt: 1,
                  emails: [],
                  githubIdentity: null,
                })),
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page.getByText("Received—I'm here.", { exact: true }).waitFor();
          const header = page.locator(".chat-pane__header").first();
          await gateway.deferNext("sessions.assignOwner");
          await page.getByRole("button", { name: "Actions for Test", exact: true }).click();
          const assignTo = page.getByRole("menuitem", { name: "Assign to…", exact: true });
          if (width < 560) {
            await assignTo.click();
          } else {
            await assignTo.hover();
          }
          await page.getByRole("menuitemradio", { name: "Vyctor", exact: true }).click();
          const request = await gateway.waitForRequest("sessions.assignOwner");
          expect(request.params).toMatchObject({
            key: sessionKey,
            owner: { type: "human", id: "vyctor" },
          });
          const owner = { actor: assignee, assignedAt: 2, assignedBy: creator };
          const assignedRow = { ...row, owner, participants: [creator], participantCount: 1 };
          await gateway.setSessionsListResponse({ ...list, sessions: [assignedRow] });
          await gateway.resolveDeferred("sessions.assignOwner", { key: sessionKey, owner });
          await expectBrowser(header.getByRole("img", { name: /Owned by Vyctor/ })).toBeVisible();
          // Reload reads the persisted assignment, matching the reported failure after refresh.
          await page.reload();
          await page.getByText("Received—I'm here.", { exact: true }).waitFor();
          await expectBrowser(
            header.locator('.chat-pane__participants .viewer-avatar[aria-label="Patrick"]'),
          ).toBeVisible();
          if (phase) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `owner-${width}-${phase}.png`),
              animations: "disabled",
            });
          }
          await expectBrowser(header.locator(".session-owner-chip--header")).toHaveCount(1);
          await expectBrowser(header.getByRole("img", { name: /Owned by Vyctor/ })).toBeVisible();
          if (width < 560) {
            await page.getByRole("button", { name: "Actions for Test", exact: true }).click();
            await page.locator('wa-dropdown-item[value="compact:open-sharing"]').click();
          } else {
            await header.locator(".chat-pane__sharing-trigger").click();
          }
          await expectBrowser(page.locator(".chat-pane__sharing-visibility-title")).toBeVisible();
          await expectBrowser(page.locator(".chat-pane__sharing-member-label")).toHaveText([
            "Vyctor",
          ]);
          await expectBrowser(header.getByRole("img", { name: /Owned by Vyctor/ })).toBeVisible();
          await expectBrowser(page.locator(".chat-pane__sharing-owner")).toHaveCount(0);
          if (phase) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `sharing-${width}-${phase}.png`),
              animations: "disabled",
            });
          }
        },
      );
    },
  );
});
