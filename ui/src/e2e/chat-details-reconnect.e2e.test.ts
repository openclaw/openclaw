import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { waitForControlUiGatewayReconnecting } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway, reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails, closeChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Details reconnect",
});
const sessionKey = "agent:main:main";
const pullRequest = {
  number: 123,
  owner: "example",
  repo: "project",
  branch: "fix/reconnect",
  title: "Keep conversation details available",
  url: "https://github.com/example/project/pull/123",
  state: "open",
};
suite.define(() => {
  it("keeps loaded Details through a socket interruption and applies authoritative reconnect data", async () => {
    await suite.withPage(
      {
        viewport: { width: 1360, height: 980 },
        locale: "en-US",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.startup", "chat.metadata", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
          models: [{ id: "demo-model", name: "Demo model", provider: "demo" }],
          agentModel: "demo/demo-model",
          historyMessages: [
            { role: "assistant", content: "The review document and pull request are ready." },
          ],
          methodResponses: {
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "artifacts.list": {
              artifacts: [
                {
                  id: "review-notes",
                  title: "Review notes.md",
                  type: "document",
                  download: { mode: "bytes" },
                },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const details = await openChatDetails(page);
        await gateway.waitForRequest(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
          match: { sessionKeys: [sessionKey] },
        });
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [sessionKey]: { pullRequests: [pullRequest], rateLimited: false, status: "ready" },
          },
        });
        const pr = details.getByText(pullRequest.title, { exact: true });
        const artifact = details.getByText("Review notes.md", { exact: true });
        await pr.waitFor();
        const outputGroup = details.locator('[data-details-group="outputs"]');
        if ((await outputGroup.getAttribute("open")) === null) {
          await outputGroup.locator(":scope > summary").click();
        }
        await artifact.waitFor();
        const prNode = await pr.elementHandle();
        const artifactNode = await artifact.elementHandle();
        const artifactReads = await gateway.deferNext("artifacts.list");
        await gateway.setOnline(false);
        await gateway.closeLatest(1001, "mock Gateway restart");
        await waitForControlUiGatewayReconnecting(page);
        expect(await pr.isVisible()).toBe(true);
        expect(await artifact.isVisible()).toBe(true);
        expect(await prNode?.evaluate((element) => element.isConnected)).toBe(true);
        expect(await artifactNode?.evaluate((element) => element.isConnected)).toBe(true);
        const artifactAction = details.getByRole("button", {
          name: "Review notes.md",
          exact: true,
        });
        expect(await artifactAction.isDisabled()).toBe(true);
        await artifactAction.dispatchEvent("click");
        expect(await gateway.getRequests("artifacts.get")).toHaveLength(0);
        expect(await gateway.getRequests("artifacts.download")).toHaveLength(0);
        await gateway.setOnline(true);
        await page.waitForFunction(
          () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
        );
        await gateway.waitForRequest("artifacts.list", { after: artifactReads });
        expect(await outputGroup.getByRole("status").count()).toBe(0);
        expect(await artifact.isVisible()).toBe(true);
        expect(await artifactNode?.evaluate((element) => element.isConnected)).toBe(true);
        await gateway.resolveDeferred("artifacts.list", { artifacts: [] });
        await expect.poll(() => artifact.count()).toBe(0);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: { [sessionKey]: { pullRequests: [], rateLimited: false, status: "ready" } },
        });
        await expect.poll(() => pr.count()).toBe(0);
        await closeChatDetails(page);
        const hiddenArtifactReads = (await gateway.getRequests("artifacts.list")).length;
        await reconnectMockGateway(page, gateway);
        expect(await gateway.getRequests("artifacts.list")).toHaveLength(hiddenArtifactReads);
      },
    );
  });
});
