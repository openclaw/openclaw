import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "1Password connect card" });
const sessionKey = "agent:main:connect-proof";
const sessionId = "XJnbsrHDk8TXKSpyi0YeTQ";
const connectUrl = `https://connect.openclaw.ai/1password/start/${sessionId}`;
const summary = `1Password connect started (sessionId=${sessionId}). Finish it from the Connect 1Password card; the agent is told when it's done.`;
const pending = { state: "pending", connectUrl, confirmationCode: "M8AQ-KEGP" };

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "shows the code and link in a private card and follows consent to its outcome in %s",
    async (theme) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, colorScheme: theme, serviceWorkers: "block" },
        async ({ page }) => {
          const historyMessages = [
            { role: "user", content: "Sign in to Amazon for me.", timestamp: Date.now() },
            {
              role: "toolResult",
              toolName: "onepassword_autofill",
              toolCallId: "connect-call",
              timestamp: Date.now() + 1,
              content: [{ type: "text", text: summary }],
              details: {
                pluginView: {
                  type: "plugin_view",
                  pluginId: "onepassword",
                  viewId: "connect",
                  version: 1,
                  toolName: "onepassword_autofill",
                  toolCallId: "connect-call",
                  payload: { sessionId },
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
                inlineViews: [{ id: "connect", label: "Connect 1Password", version: 1 }],
              },
            ],
            deferredMethods: ["onepassword.autofill.connectView"],
          });
          const method = "onepassword.autofill.connectView";
          const requests = async () => (await gateway.getRequests(method)).length;
          const view = page.locator('[data-plugin-inline-view="connect-call"]');
          const capture = async (state: string) => {
            const card = view.locator(".onepassword-approval");
            const shot = await takeControlUiScreenshotFrame(page, view, [card], {
              animations: "disabled",
            });
            writeFileSync(path.join(suite.artifactDir, `connect-${state}-${theme}.png`), shot.png);
          };
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
          await evaluateControlUiContext(
            page,
            (context, mode) => context.theme.setMode(mode),
            theme,
          );
          await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(theme);
          await view.getByRole("heading", { name: "Connect 1Password" }).waitFor();
          await expect.poll(requests).toBe(1);
          await gateway.resolveDeferred(method, { ...pending, expiresAt: Date.now() + 840_000 });
          const link = view.getByRole("link", { name: "Continue to 1Password", exact: true });
          await link.waitFor();
          expect(await link.getAttribute("href")).toBe(connectUrl);
          await view.getByText("M8AQ-KEGP", { exact: true }).waitFor();
          await capture("ready");
          // Keep the test page in place; exercise the real click and private RPC.
          await link.evaluate((anchor) =>
            anchor.addEventListener("click", (event) => event.preventDefault()),
          );
          await gateway.deferNext(method, { action: "opened" });
          await link.click();
          await expect.poll(requests).toBe(2);
          expect((await gateway.getRequests(method))[1]?.params).toMatchObject({
            action: "opened",
            sessionId,
            sessionKey,
          });
          await gateway.deferNext(method, { action: "get" });
          await gateway.resolveDeferred(method, {
            ...pending,
            expiresAt: Date.now() + 760_000,
            openedAt: Date.now(),
          });
          await view
            .getByRole("status")
            .filter({ hasText: "Waiting for you to approve" })
            .waitFor();
          await capture("waiting");
          await expect.poll(requests).toBeGreaterThanOrEqual(3);
          await gateway.resolveDeferred(method, { state: "connected" });
          await view.getByText("1Password connected", { exact: true }).waitFor();
          await capture("connected");
          for (const [state, title, extra] of [
            ["failed", "Not connected", { code: "disconnectExistingConnectionFirst" }],
            ["expired", "Connect link expired", {}],
          ] as const) {
            await page.reload();
            await view.getByRole("heading", { name: "Connect 1Password" }).waitFor();
            await expect.poll(requests).toBe(1);
            await gateway.resolveDeferred(method, { state, ...extra });
            await view.getByText(title, { exact: true }).waitFor();
            await capture(state);
            expect(await view.locator("a").count()).toBe(0);
          }
          expect((await gateway.getRequests("chat.send")).length).toBe(0);
        },
      );
    },
  );
});
