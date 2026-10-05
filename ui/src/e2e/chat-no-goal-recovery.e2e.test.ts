import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI NoGoal recovery" });

suite.define(() => {
  it("requires an explicit no-replay decision and leaves the original conversation idle", async () => {
    const artifacts = createControlUiE2eArtifactDir("no-goal-reviewed-recovery");
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "light" },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:11111111-2222-4333-8444-555555555555";
        const sessionId = "synthetic-original-session";
        const decision = {
          sessionId,
          lifecycleRevision: "synthetic-lifecycle",
          cycleId: "synthetic-cycle",
          revision: 2,
          pausedAtMs: 100,
          toolCallId: "synthetic-call",
          runId: "synthetic-run",
        };
        const row = {
          label: "Original conversation",
          key: sessionKey,
          sessionId,
          lifecycleRevision: decision.lifecycleRevision,
          kind: "direct",
          updatedAt: 100,
          status: "interrupted",
          hasActiveRun: false,
          interruptedAction: {
            reason: "unverifiable-external-effect",
            toolName: "exec",
            toolCallId: decision.toolCallId,
            decision,
          },
        };
        const list = {
          ts: 100,
          path: "",
          count: 1,
          defaults: { model: "test-model", modelProvider: "test", contextTokens: 128000 },
          sessions: [row],
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [{ ...row, interruptedAction: undefined }],
          featureMethods: [...defaultControlUiFeatureMethods, "sessions.recover"],
          heldMethods: ["sessions.recover"],
          historyMessages: [
            { role: "user", content: "Synthetic build" },
            {
              role: "assistant",
              content: "The build action was interrupted. Its outcome is unknown.",
            },
          ],
          methodResponses: {
            "sessions.list": { ...list, sessions: [{ ...row, interruptedAction: undefined }] },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat/main/111111112222433384445555555555`);
        // The pre-fix public projection omitted the private hold, leaving an ordinary composer.
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        await page.screenshot({
          path: path.join(artifacts, "before-hold-projection.png"),
          animations: "disabled",
        });
        await gateway.setSessionsListResponse(list);
        await page.reload();
        const review = page.getByRole("button", { name: "Review interrupted action", exact: true });
        await review.waitFor();
        expect(await page.locator(".agent-chat__composer-combobox textarea").count()).toBe(0);
        expect(await gateway.getRequests("sessions.recover")).toHaveLength(0);
        await page.screenshot({
          path: path.join(artifacts, "held-action.png"),
          animations: "disabled",
        });
        await review.click();
        const checkbox = page.getByRole("checkbox", {
          name: "I acknowledge the unknown outcome and choose not to replay this interrupted turn.",
          exact: true,
        });
        await checkbox.waitFor();
        const acknowledge = page.getByRole("button", {
          name: "Acknowledge and return to idle",
          exact: true,
        });
        expect(await acknowledge.isEnabled()).toBe(false);
        expect(await gateway.getRequests("sessions.recover")).toHaveLength(0);
        await page.screenshot({
          path: path.join(artifacts, "review-before-decision.png"),
          animations: "disabled",
        });
        await checkbox.check();
        await acknowledge.click();
        const request = await gateway.waitForRequest("sessions.recover");
        expect(request.params).toMatchObject({
          key: sessionKey,
          acknowledgeUnknownOutcome: decision,
        });
        const idle = { ...row, updatedAt: 101, status: "killed", interruptedAction: undefined };
        await gateway.setSessionsListResponse({ ...list, ts: 101, sessions: [idle] });
        await gateway.resolveDeferred("sessions.recover", {
          ok: true,
          key: sessionKey,
          sessionId,
          continuation: { status: "idle" },
        });
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(page.url()).toContain("11111111");
        await page.screenshot({
          path: path.join(artifacts, "acknowledged-idle.png"),
          animations: "disabled",
        });
      },
    );
  });
});
