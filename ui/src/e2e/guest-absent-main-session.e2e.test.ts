import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { createNewSessionPageE2eSuite } from "./new-session-page.test-support.ts";
import { requireRecord } from "./session-management.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const mainKey = "agent:main:main";
// A successful read without a sessionId proves the conversation has no row yet.
const absentHistory = { sessionKey: mainKey, messages: [] };

suite.define(() => {
  it("a session writer starts the main conversation before anyone has used it", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const otherContext = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.sessions.write"],
      sessions: [],
      sessionKey: mainKey,
      presenceUsers: [{ self: true, id: "member", name: "Member" }],
      historyMessages: [],
      methodResponses: { "chat.startup": absentHistory, "chat.history": absentHistory },
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainKey));
    const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
    const composer = pane.locator(".agent-chat__composer-combobox > textarea");
    await expect.poll(() => composer.isEditable()).toBe(true);
    await composer.fill("Hello from a member.");
    await composer.press("Enter");
    expect(requireRecord((await gateway.waitForRequest("chat.send")).params)).toMatchObject({
      sessionKey: mainKey,
      message: "Hello from a member.",
    });

    // Another creator's existing main conversation stays read-only for the same caller.
    const foreign = createControlUiSessionRow(mainKey, "Main", Date.now(), {
      sharingRole: "viewer",
      visibility: "read-only",
    });
    const other = await otherContext.newPage();
    await installMockGateway(other, {
      subscriptionInitialHistory: false,
      operatorScopes: ["operator.sessions.write"],
      sessions: [foreign],
      sessionKey: mainKey,
      presenceUsers: [{ self: true, id: "member", name: "Member" }],
      historyMessages: [],
    });
    await other.goto(controlUiSessionUrl(suite.server.baseUrl, mainKey));
    const otherComposer = other
      .locator("openclaw-chat-pane.chat-pane-cache__pane--active")
      .locator(".agent-chat__composer-combobox > textarea");
    await otherComposer.waitFor({ state: "attached" });
    await expect.poll(() => otherComposer.isDisabled()).toBe(true);
  });
});
