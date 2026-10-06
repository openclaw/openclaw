import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat child attention" });

suite.define(() => {
  it("explains a blocked child beside its idle parent's composer", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const now = Date.now();
        const parent = {
          key: "agent:main:dashboard:diagnostic-parent",
          sessionId: "diagnostic-parent",
          kind: "direct",
          label: "Messaging channel setup",
          status: "done",
          hasActiveRun: false,
          updatedAt: now,
          childSessions: ["agent:main:subagent:debugger"],
        } satisfies GatewaySessionRow;
        const child = {
          key: parent.childSessions![0]!,
          sessionId: "debugger-child",
          kind: "direct",
          classification: "subagent",
          label: "Debugger diagnostic",
          spawnedBy: parent.key,
          parentSessionKey: parent.key,
          status: "done",
          hasActiveRun: false,
          updatedAt: now,
          endedAt: now,
          unread: true,
          agentStatus: {
            note: "Blocked: debugger attempt expired; no attach or visible prompt verified. Inspect the target device before another debugger attempt.",
            attention: "key",
            expiresAt: now + 60_000,
          },
        } satisfies GatewaySessionRow;
        await installMockGateway(page, {
          sessionKey: parent.key,
          sessions: [parent, child],
          communityInvite: false,
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
        try {
          await notice.waitFor();
          expect(await notice.textContent()).toContain(child.agentStatus!.note);
          expect(await notice.getAttribute("data-child-session-key")).toBe(child.key);
          expect(
            await notice
              .locator(".chat-composer-neighbor-card__copy span")
              .evaluate((node) => getComputedStyle(node).whiteSpace),
          ).toBe("normal");
          await notice
            .getByRole("button", { name: "Open session", exact: true })
            .click({ trial: true });
        } finally {
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            const frame = await takeControlUiScreenshotFrame(
              page,
              pane,
              [
                pane.getByText("The diagnostic has resumed. Waiting for its result.", {
                  exact: true,
                }),
                ...((await notice.isVisible()) ? [notice] : []),
              ],
              { animations: "disabled" },
            );
            await writeFile(path.join(suite.artifactDir, "child-attention.png"), frame.png);
          }
        }
      },
    );
  });
});
