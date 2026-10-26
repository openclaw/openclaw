import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat subscription recovery" });

suite.define(() => {
  it("shows completed history after a transient subscription target change without Retry", async () => {
    const key = "agent:main:task-estimates";
    const answer = "The estimates total 7 hours: Docs 2, UI 3, and Tests 2.";
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
        recordVideo:
          process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? { dir: suite.artifactDir, size: { width: 1280, height: 900 } }
            : undefined,
      },
      async ({ page }) => {
        await page.clock.install();
        const gateway = await installMockGateway(page, {
          awaitInitialRoster: false,
          sessionKey: key,
          operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
          historyMessages: [
            { role: "user", content: "Add up these task estimates." },
            { role: "assistant", content: answer },
          ],
          sessions: [{ key, label: "Task estimates", status: "done", hasActiveRun: false }],
          methodResponses: {
            "sessions.messages.subscribe": {
              __mockError: {
                code: "INVALID_REQUEST",
                message: "session changed before sessions.messages.subscribe; retry the request",
                details: {
                  code: "SESSION_MUTATION_AUTHORIZATION_CHANGED",
                  method: "sessions.messages.subscribe",
                  sessionKey: key,
                },
              },
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        await gateway.waitForRequest("sessions.messages.subscribe", { match: { key } });
        await pauseVirtualClock(page);
        await gateway.setMethodResponse("sessions.messages.subscribe", {
          key,
          agentId: "main",
          subscribed: true,
        });
        await page.clock.runFor(1_500);
        await page.screenshot({ path: path.join(suite.artifactDir, "subscription-recovery.png") });
        expect(await page.getByText(answer, { exact: true }).count()).toBe(1);
        expect(await page.locator(".chat-history-error").count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect((await gateway.getRequests("sessions.messages.subscribe")).length).toBeGreaterThan(
          1,
        );
      },
    );
  });
});
