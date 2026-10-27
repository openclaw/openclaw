import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Parent composer isolation" });

suite.define(() => {
  it.each([
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ])(
    "keeps failed children in Subagents, not the parent composer at $width px",
    async (viewport) => {
      await suite.withPage({ viewport, locale: "en-US" }, async ({ page }) => {
        const now = Date.now();
        const parentKey = "agent:main:dashboard:diagnostic-parent";
        const children = Array.from(
          { length: 6 },
          (_, index): GatewaySessionRow & { updatedAt: number } => ({
            key: "agent:main:subagent:diagnostic-" + index,
            sessionId: "diagnostic-" + index,
            kind: "direct",
            classification: "subagent",
            label: "Review diagnostic " + (index + 1),
            spawnedBy: parentKey,
            parentSessionKey: parentKey,
            status: index === 1 ? "timeout" : "failed",
            hasActiveRun: false,
            updatedAt: now,
            endedAt: now,
            unread: true,
            ...(index === 0
              ? {
                  agentStatus: {
                    note: "Blocked: the review needs a service credential.",
                    attention: "key" as const,
                    expiresAt: now + 60_000,
                  },
                }
              : {}),
          }),
        );
        const parent = {
          key: parentKey,
          sessionId: "diagnostic-parent",
          kind: "direct",
          label: "Review the release",
          status: "done",
          hasActiveRun: false,
          updatedAt: now,
          childSessions: children.map((child) => child.key),
        } satisfies GatewaySessionRow;
        const gateway = await installMockGateway(page, {
          sessionKey: parent.key,
          sessions: [parent, ...children],
          communityInvite: false,
          historyMessages: [
            {
              role: "assistant",
              content: "The delegated reviews need attention. You can continue here.",
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const message = pane.getByText(
          "The delegated reviews need attention. You can continue here.",
          { exact: true },
        );
        await message.waitFor();
        await gateway.waitForRequest("sessions.list", { match: { spawnedBy: parent.key } });
        await openChatSidePanelType(pane, "Subagents");
        const panel = pane.locator("openclaw-chat-subagents-panel");
        await panel.getByText(children[0]!.label!, { exact: true }).waitFor();
        const composer = pane.locator(".agent-chat__input");
        // Capture the same real parent surface before asserting, including on the broken base.
        if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
          const frame = await takeControlUiScreenshotFrame(page, pane, [message, composer], {
            animations: "disabled",
          });
          await writeFile(
            path.join(suite.artifactDir, "parent-composer-" + viewport.width + ".png"),
            frame.png,
          );
        }
        expect(await pane.locator(".agent-chat__composer-notices").textContent()).not.toContain(
          children[0]!.label,
        );
        expect(await pane.locator(".chat-child-attention").count()).toBe(0);
        await composer.locator("textarea").fill("Continue the parent review.");
        await composer.locator("textarea").press("Enter");
        await gateway.waitForRequest("chat.send");
        expect(await pane.locator(".chat-child-attention").count()).toBe(0);
        const patches = await gateway.getRequests("sessions.patch");
        expect(
          patches.some(
            ({ params }) =>
              isRecord(params) &&
              children.some((child) => child.key === params.key) &&
              params.unread === false,
          ),
        ).toBe(false);
        await openChatSidePanelType(pane, "Subagents");
        await expect.poll(() => panel.locator("[data-session-key]").count()).toBe(children.length);
        await panel.getByText(children[1]!.label!, { exact: true }).waitFor();
      });
    },
  );
});
