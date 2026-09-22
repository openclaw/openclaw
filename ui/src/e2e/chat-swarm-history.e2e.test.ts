import path from "node:path";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Swarm history freshness" });

suite.define(() => {
  it("keeps a completed Swarm outcome when compaction finishes in an unfocused pane", async () => {
    const proofDir = createControlUiE2eArtifactDir("swarm-history-freshness");
    await suite.withPage({ viewport: { width: 1800, height: 1000 } }, async ({ page }) => {
      const parentKey = "agent:main:research";
      const otherKey = "agent:main:notes";
      const groupId = `swarm:${parentKey}:research-run`;
      const child = {
        key: "agent:main:subagent:research-worker",
        sessionId: "research-worker-session",
        kind: "direct",
        label: "Research worker",
        spawnedBy: parentKey,
        parentSessionKey: parentKey,
        swarmGroupId: groupId,
        status: "done",
        updatedAt: 3,
      };
      const parent = {
        key: parentKey,
        sessionId: "research-session",
        kind: "direct",
        label: "Research",
        status: "done",
        hasActiveRun: false,
        updatedAt: 3,
        swarm: {
          groups: [
            {
              groupId,
              createdAt: 1,
              queued: 0,
              running: 0,
              done: 1,
              failed: 0,
              children: [{ sessionKey: child.key, status: "done" }],
            },
          ],
          otherActiveGroups: 0,
        },
      };
      const other = { key: otherKey, kind: "direct", label: "Notes", updatedAt: 3 };
      await page.addInitScript(
        ({ storageKey, keys }) => {
          localStorage.setItem(
            storageKey,
            JSON.stringify({
              chatSplitLayout: {
                activePaneId: "p1",
                columnWeights: [0.5, 0.5],
                columns: keys.map((sessionKey, index) => ({
                  id: `c${index + 1}`,
                  paneWeights: [1],
                  panes: [{ id: `p${index + 1}`, sessionKey }],
                })),
              },
            }),
          );
        },
        {
          storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          keys: [parentKey, otherKey],
        },
      );
      const gateway = await installMockGateway(page, {
        sessionKey: parentKey,
        sessions: [parent, other, child],
        sessionTranscripts: {
          [parentKey]: { messages: [{ role: "assistant", content: "Research conversation." }] },
          [otherKey]: { messages: [{ role: "assistant", content: "Notes conversation." }] },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const cells = page.locator("openclaw-chat-page .chat-split-view__cell");
      await expect.poll(() => cells.count()).toBe(2);
      const research = cells.first().locator('openclaw-chat-pane[aria-hidden="false"]');
      const widget = research.locator('[data-test-id="chat-swarm"]');
      const outcome = widget.getByText(
        "Child runs finished. Check the conversation for the final response.",
      );
      await widget.locator("summary").click();
      await expect.poll(() => outcome.isVisible()).toBe(true);
      // Finish compaction after the other pane replaces the primary session page.
      await gateway.deferNext("sessions.compact");
      const composer = research.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/compact ");
      await composer.press("Enter");
      await gateway.waitForRequest("sessions.compact");
      await cells.last().locator(".agent-chat__composer-combobox textarea").focus();
      await expect.poll(() => page.url()).toBe(controlUiSessionUrl(suite.server.baseUrl, otherKey));

      await gateway.setMethodResponse("sessions.list", {
        cases: [
          { match: { spawnedBy: parentKey }, response: chatSessionListResponse([child]) },
          { match: {}, response: chatSessionListResponse([other]) },
        ],
      });
      await page.evaluate(async (key) => {
        const app = document.querySelector<
          HTMLElement & { runtime?: { context?: ApplicationContext } }
        >("openclaw-app");
        const sessions = app?.runtime?.context?.sessions;
        if (!sessions) {
          throw new Error("Session capability is missing");
        }
        await sessions.refresh({ agentId: "main", force: true });
        if (sessions.state.result?.sessions.some((row) => row.key === key)) {
          throw new Error("Research parent must be outside the primary roster");
        }
      }, parentKey);
      await gateway.setMethodResponse("chat.history", {
        cases: [
          {
            match: { sessionKey: parentKey },
            response: {
              sessionId: parent.sessionId,
              messages: [{ role: "assistant", content: "Refreshed research results." }],
              sessionInfo: { ...parent, updatedAt: 2, status: "running", hasActiveRun: true },
            },
          },
        ],
      });
      await gateway.resolveDeferred("sessions.compact", { ok: true, compacted: true });
      await research.getByText("Refreshed research results.", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(proofDir, "refreshed.png"), animations: "disabled" });
      await expect.poll(() => outcome.isVisible()).toBe(true);
    });
  });
});
