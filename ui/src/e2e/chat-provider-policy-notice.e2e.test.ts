import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI cyber policy notices" });

suite.define(() => {
  it("shows provider policy above the composer without sending another request", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { historyMessages: [] });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Explain secure password storage.");
      await composer.press("Enter");
      const send = await gateway.waitForRequest("chat.send");
      const sendParams = requireRecord(send.params);
      const runId = requireString(sendParams.idempotencyKey, "chat.send idempotencyKey");
      const sessionKey = requireString(sendParams.sessionKey, "chat.send sessionKey");
      const notice = page.locator(".chat-provider-policy-notice");
      expect(await notice.count()).toBe(0);
      const artifactDir =
        process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? createControlUiE2eArtifactDir("chat-provider-policy-notice")
          : undefined;
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "before.png") });
      }
      const emitNotice = (seq: number, state: string, eventRunId = runId) =>
        gateway.emitGatewayEvent("agent", {
          runId: eventRunId,
          sessionKey,
          seq,
          ts: Date.now(),
          stream: "notice",
          data: { phase: "provider_policy", provider: "openai", category: "cyber", state },
        });
      await emitNotice(1, "buffering");
      await expect.poll(() => notice.textContent()).toContain("Cyber safety review");
      expect(await notice.getAttribute("role")).toBe("status");
      const noticeBox = await notice.boundingBox();
      const composerBox = await composer.boundingBox();
      expect(noticeBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(composerBox!.y);
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "after-buffering.png") });
      }
      await emitNotice(2, "blocked", "unrelated-run");
      expect(await notice.textContent()).toContain("Cyber safety review");
      await emitNotice(2, "blocked");
      await expect.poll(() => notice.textContent()).toContain("Cyber policy block");
      expect(await notice.getAttribute("role")).toBe("alert");
      await emitNotice(3, "cleared");
      expect(await notice.textContent()).toContain("Cyber policy block");
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, "after-blocked.png") });
      }
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await gateway.emitChatFinal({
        runId,
        sessionKey,
        text: "The provider blocked this response.",
      });
      await composer.fill("Explain password managers.");
      await composer.press("Enter");
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(2);
      await expect.poll(() => notice.count()).toBe(0);
    });
  });
});
