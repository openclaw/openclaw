import path from "node:path";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Background processes panel" });
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("discovers background work and stops only the inspected process without consuming its output", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        const key = "agent:main:process-review";
        const process = {
          processId: "build-process",
          instanceId: "build-incarnation",
          name: "npm run build",
          status: "running",
          startedAt: Date.now() - 20_000,
          tail: "Building the application…\nCompiled 42 modules.",
          truncated: false,
          canStop: true,
        };
        const result = {
          sessionId: "process-review-session",
          processes: [process],
          truncated: false,
        };
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          agentModel: "openai/gpt-4.1",
          models: [{ id: "gpt-4.1", name: "Preview model", provider: "openai" }],
          communityInvite: false,
          featureMethods: ["sessions.processes.list", "sessions.processes.stop"],
          sessions: [
            {
              key,
              sessionId: result.sessionId,
              kind: "direct",
              label: "Review background work",
              updatedAt: Date.now(),
            },
          ],
          methodResponses: { "sessions.processes.list": result },
          historyMessages: [
            { role: "assistant", content: "The application build is running in the background." },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const draft = pane.locator(".agent-chat__composer-combobox textarea");
        await draft.fill("Keep my next instruction");
        await pane.getByRole("button", { name: "Side panel", exact: true }).click();
        const choices = pane.locator(".side-panel-empty__type");
        await choices.first().waitFor();
        if (capture) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, "processes-before.png"),
          });
        }
        expect(await choices.allTextContents()).toEqual(
          expect.arrayContaining([expect.stringContaining("Processes")]),
        );
        await choices.filter({ hasText: "Processes" }).click();
        const panel = pane.locator("openclaw-chat-processes-panel");
        await panel.getByText(process.name, { exact: true }).waitFor();
        const request = await gateway.waitForRequest("sessions.processes.list");
        expect(request.params).toMatchObject({ key });
        await panel.getByText(process.name, { exact: true }).click();
        await panel.getByText(process.tail, { exact: true }).waitFor();
        await openChatSidePanelType(page, "Subagents");
        const selectTab = (label: string) =>
          pane.locator(".side-panel__header .tabstrip-tab").filter({ hasText: label }).click();
        await selectTab("Processes");
        await panel.getByText(process.tail, { exact: true }).waitFor();
        if (capture) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, "processes-after.png"),
          });
        }
        await gateway.deferNext("sessions.processes.stop");
        await panel.getByRole("button", { name: "Stop " + process.name, exact: true }).click();
        const stop = await gateway.waitForRequest("sessions.processes.stop");
        expect(stop.params).toMatchObject({
          key,
          sessionId: result.sessionId,
          processId: process.processId,
          instanceId: process.instanceId,
        });
        await gateway.setMethodResponse("sessions.processes.list", {
          ...result,
          processes: [{ ...process, status: "killed", endedAt: Date.now(), canStop: false }],
        });
        await gateway.resolveDeferred("sessions.processes.stop", { requested: true });
        await panel.getByText("Stopped", { exact: true }).waitFor();
        expect(await draft.inputValue()).toBe("Keep my next instruction");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("process")).toHaveLength(0);
        await selectTab("Subagents");
        await page.reload();
        await draft.waitFor();
        expect(await draft.inputValue()).toBe("Keep my next instruction");
        await selectTab("Processes");
        await panel.getByText(process.name, { exact: true }).waitFor();
      },
    );
  });
});
