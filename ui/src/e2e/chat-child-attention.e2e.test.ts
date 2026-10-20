import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { exactButton, layoutBox } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat child attention" });
function session(key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, sessionId: key, kind: "direct", status: "done", updatedAt: Date.now(), ...fields };
}

suite.define(() => {
  it.each([
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ])("aligns a blocked child notice with its parent's composer at $width px", async (viewport) => {
    await suite.withPage({ viewport, locale: "en-US" }, async ({ page }) => {
      const now = Date.now();
      const parent = session("agent:main:dashboard:parent", {
        label: "Messaging channel setup",
        hasActiveRun: false,
        updatedAt: now,
        childSessions: ["agent:main:subagent:debugger"],
      });
      const child = session(parent.childSessions![0]!, {
        classification: "subagent",
        label: "Debugger diagnostic",
        spawnedBy: parent.key,
        parentSessionKey: parent.key,
        hasActiveRun: false,
        updatedAt: now,
        endedAt: now,
        unread: true,
        agentStatus: {
          note: "Blocked: debugger attempt expired; no attach or visible prompt verified. Inspect the target device before another debugger attempt.",
          attention: "key",
          expiresAt: now + 60_000,
        },
      });
      await installMockGateway(page, {
        sessionKey: parent.key,
        sessions: [parent, child],
        historyMessages: [
          { role: "assistant", content: "The diagnostic has resumed. Waiting for its result." },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
      await pane
        .getByText("The diagnostic has resumed. Waiting for its result.", { exact: true })
        .waitFor();
      const notice = pane.locator(".chat-child-attention");
      const composer = pane.locator(".agent-chat__input");
      await notice.waitFor();
      expect(await notice.textContent()).toContain(child.agentStatus!.note);
      expect(
        await notice.evaluate((node) => ({
          key: node.getAttribute("data-child-session-key"),
          whitespace: getComputedStyle(
            node.querySelector(".chat-composer-neighbor-card__copy span")!,
          ).whiteSpace,
        })),
      ).toEqual({ key: child.key, whitespace: "normal" });
      await exactButton(notice, "Open session").click({ trial: true });
      const noticeBox = await layoutBox(notice);
      const composerBox = await layoutBox(composer);
      expect(noticeBox.x).toBeCloseTo(composerBox.x, 0);
      expect(noticeBox.width).toBeCloseTo(composerBox.width, 0);
      expect(await notice.evaluate((node) => getComputedStyle(node).borderRadius)).toBe(
        await composer.evaluate((node) => getComputedStyle(node).borderRadius),
      );
    });
  });

  it("never flashes a child the parent's child query no longer links", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const parent = session("agent:main:dashboard:expired-parent");
      // The broad roster keeps spawnedBy after the Gateway retires the child link.
      const expired = session("agent:main:subagent:expired", {
        classification: "subagent",
        label: "Expired diagnostic",
        spawnedBy: parent.key,
        status: "timeout",
        updatedAt: 1,
        endedAt: 1,
      });
      await page.addInitScript(() => {
        const seen = { flashed: false };
        Object.assign(window, { childAttentionSeen: seen });
        new MutationObserver(() => {
          seen.flashed ||= document.querySelector(".chat-child-attention") !== null;
        }).observe(document, { childList: true, subtree: true });
      });
      const gateway = await installMockGateway(page, {
        sessionKey: parent.key,
        sessions: [parent, expired],
        historyMessages: [{ role: "assistant", content: "Parent history loaded." }],
        methodResponses: {
          "sessions.list": {
            cases: [
              { match: { spawnedBy: parent.key }, response: sessionsListResponse([]) },
              { response: sessionsListResponse([parent, expired]) },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
      await pane.getByText("Parent history loaded.", { exact: true }).waitFor();
      await gateway.waitForRequest("sessions.list", { match: { spawnedBy: parent.key } });
      await expect.poll(() => pane.locator("openclaw-chat-child-attention").count()).toBe(1);
      expect(
        await page.evaluate(
          () => (window as { childAttentionSeen?: { flashed: boolean } }).childAttentionSeen,
        ),
      ).toEqual({ flashed: false });
    });
  });
});
