import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { openChatPublication } from "./chat-details.test-support.ts";
import { installPublicationGateway } from "./chat-github-publication-accounts.test-support.ts";
import {
  personalAccount,
  publicationOptions,
  sharedPublisher,
  showPublicationBranch,
} from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile publication account identity" });

suite.define(() => {
  it.each(["shared", "personal"] as const)(
    "shows the recorded %s publisher once on mobile",
    async (source) => {
      await suite.withPage(
        {
          viewport: { width: 390, height: 844 },
          colorScheme: "light",
          locale: "en-US",
          serviceWorkers: "block",
        },
        async ({ page }) => {
          const publisher =
            source === "personal" ? { source: "personal", ...personalAccount } : sharedPublisher;
          const receipt = {
            result: {
              requestId: "8c698e8a-bdc7-4927-a0f2-73a842c2d7b5",
              status: "publishing",
              publisher,
              message: "The Gateway is publishing the reconciled workspace.",
            },
            confirmation: null,
          };
          const gateway = await installPublicationGateway(page, {
            assistantName: "Lobster",
            agentModel: "gpt-4.1",
            workspace: "/synthetic/progress-audit",
            communityInvite: false,
            methodResponses: {
              "sessions.github.options": {
                ...publicationOptions,
                pendingPersonal: source === "personal" ? receipt : null,
                latestShared: source === "shared" ? receipt : null,
              },
              "sessions.github.status": receipt,
            },
          });
          await page.goto(suite.server.baseUrl + "chat");
          await showPublicationBranch(gateway, "openclaw/publication-progress");
          await openChatPublication(page);
          const surface = page.locator(".github-publication-mobile");
          const action = surface.getByRole("button", { name: "Check publication", exact: true });
          await action.waitFor();
          expect(await surface.getByText(new RegExp("@" + publisher.login)).count()).toBe(1);
          expect(await surface.locator("[data-publication-account]").textContent()).toBe(
            source === "personal" ? "My GitHub" : "Shared agent account",
          );
          expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
          expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            const frame = await takeControlUiScreenshotFrame(page, surface, [action], {
              animations: "disabled",
              elements: [surface],
            });
            await writeFile(path.join(suite.artifactDir, source + ".png"), frame.png);
            await writeFile(
              path.join(suite.artifactDir, source + "-detail.png"),
              frame.elements[0]!.png,
            );
          }
        },
      );
    },
  );
});
