import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterEach, expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionPerson } from "./session-ownership-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI session People" });
let activePage: Page | undefined;

suite.define(() => {
  afterEach(async () => {
    if (activePage) {
      await suite.closeBrowserContext(activePage.context());
      activePage = undefined;
    }
  });

  it.each(["self-only", "another-owner", "multiple-people"] as const)(
    "renders People from the serialized owner-excluded descriptor: %s",
    async (scenario) => {
      const self = sessionPerson("profile-ada", "Ada Owner");
      const other = sessionPerson("profile-bob", "Bob Collaborator");
      const actor = scenario === "another-owner" ? other : self;
      // The producer excludes the owner and serializes empty participant facts away.
      const row = {
        key: "agent:main:ada",
        sessionId: "synthetic-personal-planning",
        kind: "direct",
        label: "Personal planning",
        updatedAt: 1,
        workspaceReadDisabledReason: null,
        owner: { actor },
        createdActor: actor,
        ...(scenario === "multiple-people"
          ? { participants: [other], expandedParticipants: [other], participantCount: 1 }
          : {}),
      };
      const descriptor = { session: row };
      if (scenario !== "multiple-people") {
        expect(descriptor.session).not.toHaveProperty("participants");
        expect(descriptor.session).not.toHaveProperty("expandedParticipants");
        expect(descriptor.session).not.toHaveProperty("participantCount");
      }
      const context = await suite.newBrowserContext({
        reducedMotion: "reduce",
        viewport: { width: 1200, height: 800 },
      });
      const page = await context.newPage();
      activePage = page;
      const gateway = await installMockGateway(page, {
        sessionKey: row.key,
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
        presenceUsers: [{ self: true, id: self.id, identity: self.identity, name: self.label }],
        methodResponses: {
          "sessions.list": {
            count: 1,
            owners: [actor],
            sessions: [{ ...row, label: "Loading personal planning" }],
            defaults: {},
            path: "",
            ts: 1,
          },
          "sessions.describe": descriptor,
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, row.key));
      // Only the describe response has this title: do not assert absence before hydration.
      await expectBrowser(
        page.getByText("Personal planning", { exact: true }).filter({ visible: true }).first(),
      ).toBeVisible();
      const details = await openChatDetails(page);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.describe")).length)
        .toBeGreaterThan(0);
      const frame = await takeControlUiScreenshotFrame(page, details, [], {
        animations: "disabled",
      });
      await writeFile(path.join(suite.artifactDir, `owner-only-people-${scenario}.png`), frame.png);
      await expectBrowser(details.locator('[data-details-group="people"]')).toHaveCount(
        scenario === "self-only" ? 0 : 1,
      );
    },
  );
});
