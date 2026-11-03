import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Private 1Password inline approval" });
const sessionKey = "agent:main:approval-proof";
const appLink = "onepassword://grant-brokered-access?synthetic-private-proof";
const summary =
  "1Password approval requested for https://example.com. Approval requires the OpenClaw Control UI; approve with the button shown there.";

suite.define(() => {
  it("hydrates the built approval button privately without adding the native URL to history", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "light", serviceWorkers: "block" },
      async ({ page }) => {
        const historyMessages = [
          {
            role: "user",
            content: "Sign in to example.com with my approved login.",
            timestamp: Date.now(),
          },
          {
            role: "toolResult",
            toolName: "onepassword_autofill",
            toolCallId: "approval-call",
            timestamp: Date.now() + 1,
            content: [{ type: "text", text: summary }],
            details: {
              pluginView: {
                type: "plugin_view",
                pluginId: "onepassword",
                viewId: "approval",
                version: 1,
                toolName: "onepassword_autofill",
                toolCallId: "approval-call",
                payload: { requestId: "request" },
                summary,
              },
            },
          },
        ];
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages,
          agentModel: "openai/gpt-4.1",
          nativePlugins: [
            {
              pluginId: "onepassword",
              rootDir: path.resolve("extensions/onepassword"),
              source: "./browser/index.tsx",
              inlineViews: [{ id: "approval", label: "1Password approval", version: 1 }],
            },
          ],
          deferredMethods: ["onepassword.autofill.approval"],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
        const view = page.locator('[data-plugin-inline-view="approval-call"]');
        await view.getByRole("heading", { name: "1Password approval" }).waitFor();
        const before = await takeControlUiScreenshotFrame(
          page,
          view,
          [view.getByRole("heading", { name: "1Password approval" })],
          { animations: "disabled" },
        );
        writeFileSync(path.join(suite.artifactDir, "before-hydration.png"), before.png);
        await expect
          .poll(async () => (await gateway.getRequests("onepassword.autofill.approval")).length)
          .toBe(1);
        await gateway.resolveDeferred("onepassword.autofill.approval", {
          state: "pending",
          appLink,
        });
        const button = view.getByRole("link", { name: "Approve in 1Password" });
        await button.waitFor();
        expect(await button.getAttribute("href")).toBe(appLink);
        expect((await page.locator(".chat-bubble").allTextContents()).join("\n")).not.toContain(
          appLink,
        );
        expect(JSON.stringify(historyMessages)).not.toContain(appLink);
        expect(JSON.stringify(await gateway.getRequests("chat.send"))).not.toContain(appLink);
        const after = await takeControlUiScreenshotFrame(page, view, [button], {
          animations: "disabled",
        });
        writeFileSync(path.join(suite.artifactDir, "approval-view.png"), after.png);
        writeFileSync("/tmp/op-approval-view.png", after.png);
        // Suppress the OS protocol handler in this synthetic proof, but exercise the real click RPC.
        await button.evaluate((anchor) =>
          anchor.addEventListener("click", (event) => event.preventDefault()),
        );
        await gateway.deferNext("onepassword.autofill.approval", { action: "opened" });
        await button.click();
        await expect
          .poll(async () => (await gateway.getRequests("onepassword.autofill.approval")).length)
          .toBe(2);
        const requests = await gateway.getRequests("onepassword.autofill.approval");
        expect(requests[1]?.params).toMatchObject({
          action: "opened",
          requestId: "request",
          sessionKey,
        });
        await gateway.resolveDeferred("onepassword.autofill.approval", { state: "resolved" });
        await view.getByRole("status").filter({ hasText: "resolved" }).waitFor();
        expect(await button.count()).toBe(0);
        expect(JSON.stringify(await gateway.getRequests("chat.send"))).not.toContain(appLink);
        expect((await gateway.getRequests("chat.send")).length).toBe(0);
        expect((await gateway.getRequests("sessions.messages.subscribe")).length).toBeGreaterThan(
          0,
        );
      },
    );
  });
});
