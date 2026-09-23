import { it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { expectHistoryBoundaryState } from "./chat-history-boundary.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat history loading",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("keeps the cached history action disabled while reconnect hydration is pending", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1280, height: 900 } });
    const messages = Array.from({ length: 40 }, (_, index) => ({
      __openclaw: { seq: index + 41 },
      role: index % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `Cached conversation message ${index + 41}` }],
      timestamp: 1_800_000_000_000 + index,
    }));
    const history = {
      messages,
      hasMore: true,
      nextOffset: 40,
      totalMessages: 80,
      sessionId: "cached-history-hydration",
      thinkingLevel: null,
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: { "chat.startup": history, "chat.history": history },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Cached conversation message 80", { exact: true }).waitFor();
    await expectHistoryBoundaryState(page, false);

    const startupCount = (await gateway.getRequests("chat.startup")).length;
    await gateway.deferNext("chat.startup");
    await gateway.setGatewayBootId("cached-history-reconnect");
    await gateway.closeLatest(1012, "restart");
    await gateway.waitForRequest("chat.startup", { after: startupCount });
    await expectHistoryBoundaryState(page, true);
    await page.getByText("Cached conversation message 80", { exact: true }).waitFor();

    await gateway.resolveDeferred("chat.startup");
    await expectHistoryBoundaryState(page, false);
    await page.close();
  });
});
