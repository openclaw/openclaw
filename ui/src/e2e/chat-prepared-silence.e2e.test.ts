import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("renders prepared literal markers while an absent final creates no reply", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 960 } },
      async ({ page }) => {
        const proofDir = captureUiProofEnabled
          ? createControlUiE2eArtifactDir("prepared-silence")
          : undefined;
        const gateway = await installMockGateway(page, {
          historyMessages: [
            { role: "user", content: "Show the prepared reply examples.", timestamp: 1 },
            { role: "assistant", content: "NO_REPLY", timestamp: 2 },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Show the prepared reply examples.", { exact: true }).waitFor();
        const thread = page.locator(".chat-thread-inner");
        const literal = thread.getByText("NO_REPLY", { exact: true });
        if (proofDir) {
          await page.screenshot({
            path: path.join(proofDir, "01-prepared-history.png"),
            animations: "disabled",
          });
        }
        const historyLiteralCount = await literal.count();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Show a prepared live literal marker.");
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = requireString(requireRecord(send.params).idempotencyKey, "run id");
        await gateway.emitChatFinal({ runId, text: "NO_REPLY" });
        await composer.waitFor({ state: "visible" });
        if (proofDir) {
          await page.screenshot({
            path: path.join(proofDir, "02-prepared-live.png"),
            animations: "disabled",
          });
        }
        const liveLiteralCount = await literal.count();
        const assistantCount = await thread.locator(".chat-group.assistant").count();
        await composer.fill("Finish silently with no outbound payload.");
        await page.getByRole("button", { name: "Send message" }).click();
        const silentSend = await gateway.waitForRequest("chat.send", {
          match: { message: "Finish silently with no outbound payload." },
        });
        await gateway.emitGatewayEvent("chat", {
          sessionKey: "agent:main:main",
          runId: requireString(requireRecord(silentSend.params).idempotencyKey, "silent run id"),
          state: "final",
        });
        if (proofDir) {
          await page.screenshot({
            path: path.join(proofDir, "03-absent-final.png"),
            animations: "disabled",
          });
        }
        expect(historyLiteralCount).toBe(1);
        expect(liveLiteralCount).toBe(2);
        expect(await thread.locator(".chat-group.assistant").count()).toBe(assistantCount);
      },
    );
  });
});
