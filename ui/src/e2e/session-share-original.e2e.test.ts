import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const originalUrl =
  "https://team.example.com/chat/research/dashboard/01234567-89ab-cdef-0123-456789abcdef";

suite.define(() => {
  it.each([false, true])(
    "keeps shared sessions read-only with original navigation configured=%s",
    async (configured) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const artifacts = createControlUiE2eArtifactDir(
          `session-share-original-${configured ? "after" : "before"}`,
        );
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "sessions.catalog.list",
            "sessions.catalog.read",
          ],
          methodResponses: {
            "sessions.catalog.list": {
              catalogs: [
                {
                  id: "openclaw",
                  label: "OpenClaw sessions",
                  capabilities: { continueSession: false, archive: false },
                  hosts: [
                    {
                      hostId: "node:team",
                      label: "Team",
                      kind: "node",
                      connected: true,
                      sessions: [
                        {
                          threadId: "agent:research:dashboard:01234567-89ab-cdef-0123-456789abcdef",
                          name: "Shared planning",
                          status: "idle",
                          archived: false,
                          canContinue: false,
                          canArchive: false,
                          canOpenTerminal: false,
                          ...(configured ? { originalUrl } : {}),
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            "sessions.catalog.read": {
              hostId: "node:team",
              threadId: "agent:research:dashboard:01234567-89ab-cdef-0123-456789abcdef",
              items: [
                { id: "question", type: "userMessage", text: "Plan the release." },
                {
                  id: "answer",
                  type: "agentMessage",
                  text: "The source session keeps its own queue and permissions.",
                },
              ],
            },
          },
        });
        await page
          .context()
          .route("https://team.example.com/**", (route) =>
            route.fulfill({ contentType: "text/html", body: "<h1>Source sign-in</h1>" }),
          );
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Shared planning", { exact: true }).click();
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        await pane
          .getByText("The source session keeps its own queue and permissions.", { exact: true })
          .waitFor();
        const action = pane.getByRole("button", { name: "Open original", exact: true });
        await expect.poll(() => action.count()).toBe(configured ? 1 : 0);
        await writeFile(
          path.join(artifacts, "transcript.png"),
          await takeControlUiViewportScreenshot(page, pane, [
            pane.getByText("Plan the release.", { exact: true }),
          ]),
        );
        if (configured) {
          const opened = page.context().waitForEvent("page");
          await action.click();
          const source = await opened;
          await source.waitForURL(originalUrl);
          expect(await source.evaluate(() => window.opener)).toBeNull();
          expect(await source.evaluate(() => document.referrer)).toBe("");
          await source.close();
          await page.bringToFront();
        }
        const row = page
          .locator("[data-catalog-session-key]")
          .filter({ hasText: "Shared planning" });
        await row.hover();
        await row.getByRole("button", { name: "Open session menu" }).click();
        const menu = page.locator("openclaw-catalog-session-menu");
        await expect
          .poll(() => menu.getByText("Open original", { exact: true }).count())
          .toBe(configured ? 1 : 0);
        await writeFile(
          path.join(artifacts, "menu.png"),
          await takeControlUiViewportScreenshot(page, menu, [
            menu.getByText("Open in OpenClaw", { exact: true }),
          ]),
        );
        expect(
          (await gateway.getRequests()).some(({ method }) =>
            [
              "sessions.catalog.continue",
              "chat.send",
              "sessions.catalog.archive",
              "terminal.open",
            ].includes(method),
          ),
        ).toBe(false);
      });
    },
  );
});
