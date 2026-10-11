import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  activateSelfRemovingControl,
  waitForPatch,
} from "../../e2e/session-management.test-support.ts";
import { controlUiSessionUrl, installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../../test-helpers/control-ui-session-fixtures.ts";

const suite = createControlUiE2eSuite({ name: "Control UI observer notification policy" });
const selectedSessionKey = "agent:main:main";
const backgroundSessionKey = "agent:main:verification";
const runId = "verification-run";
const baseTime = Date.parse("2026-09-18T05:00:00.000Z");

suite.define(() => {
  it("keeps background observer assessments in the sidebar without interrupting chat or replacing Undo", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        const main = sessionRow(selectedSessionKey, "Main", baseTime);
        const background = sessionRow(
          backgroundSessionKey,
          "Background verification",
          baseTime - 1,
          {
            hasActiveRun: true,
            activeRunIds: [runId],
            status: "running",
          },
        );
        const archived = sessionRow("agent:main:completed", "Completed work", baseTime - 2);
        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Your current conversation stays uninterrupted." }],
            },
          ],
          sessions: [main, background, archived],
          sessionArchiveFiltering: true,
          sessionKey: selectedSessionKey,
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        await page.getByText("Your current conversation stays uninterrupted.").waitFor();
        const currentUrl = page.url();
        const row = page.locator(
          `.sidebar-recent-session[data-session-key="${backgroundSessionKey}"]`,
        );
        await row.waitFor({ state: "visible" });
        await gateway.waitForRequest("sessions.messages.subscribe", {
          match: { key: backgroundSessionKey },
        });

        // Record transient notices too, so an auto-dismiss cannot turn an unwanted alert into a pass.
        const observerNotices = await page.evaluateHandle(() => {
          const messages: string[] = [];
          const host = document.querySelector("openclaw-toast-host");
          if (!host) {
            throw new Error("Shared toast host is unavailable");
          }
          const observer = new MutationObserver(() => {
            const message = host.querySelector(".app-toast__message")?.textContent;
            if (message) {
              messages.push(message);
            }
          });
          observer.observe(host, { childList: true, subtree: true, characterData: true });
          return messages;
        });

        const emit = async (
          health: "stuck" | "waiting-on-user" | "on-track",
          revision: number,
          headline: string,
        ) => {
          await gateway.emitGatewayEvent("session.observer", {
            sessionKey: backgroundSessionKey,
            agentId: "main",
            sessionId: background.sessionId,
            runId,
            health,
            revision,
            headline,
            updatedAt: baseTime + revision,
          });
          await expect.poll(() => row.textContent()).toContain(headline);
          // Include the old lazy notification chunk in the baseline observation.
          await page.waitForLoadState("networkidle");
        };

        await emit("stuck", 1, "Verification is waiting for a repair");
        await page.screenshot({ path: path.join(suite.artifactDir, "observer-assessment.png") });
        expect(await page.locator(".app-toast").count()).toBe(0);
        await emit("waiting-on-user", 2, "A decision is needed in the background session");
        expect(await page.locator(".app-toast").count()).toBe(0);
        expect(await observerNotices.jsonValue()).toEqual([]);
        expect(page.url()).toBe(currentUrl);

        const archiveRow = page.locator(
          `.sidebar-recent-session[data-session-key="${archived.key}"]`,
        );
        await archiveRow.hover();
        await archiveRow.click({ button: "right" });
        await activateSelfRemovingControl(
          page.getByRole("menuitem", { name: "Archive session", exact: true }),
        );
        await waitForPatch(
          gateway,
          (params) => params.key === archived.key && params.archived === true,
        );
        const toast = page.locator(".app-toast");
        const undo = toast.getByRole("button", { name: "Undo", exact: true });
        await undo.waitFor({ state: "visible" });
        await undo.focus();
        await emit("stuck", 3, "Background verification still needs a repair");
        expect(await toast.textContent()).toContain("Session archived");
        await page.screenshot({ path: path.join(suite.artifactDir, "undo-preserved.png") });
        await undo.click();
        await waitForPatch(
          gateway,
          (params) => params.key === archived.key && params.archived === false,
        );
        await archiveRow.waitFor({ state: "visible" });
        expect(page.url()).toBe(currentUrl);
      },
    );
  });
});
