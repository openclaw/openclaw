import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Addressed subagent headline" });
const now = 1_800_000_000_000;

suite.define(() => {
  it("names the subagent a running message addresses instead of its key suffix", async () => {
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        await page.clock.setFixedTime(now);
        await page.addInitScript(
          (key) =>
            localStorage.setItem(key, JSON.stringify({ themeMode: "dark", navCollapsed: true })),
          controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        );
        const parentKey = "agent:main:addressed-headline";
        const childLabel = "Compare flight prices";
        const child: GatewaySessionRow & { updatedAt: number } = {
          key: "agent:main:subagent:00000000-0000-4000-8000-000000007ef3",
          sessionId: "addressed-child",
          kind: "direct",
          classification: "subagent",
          label: childLabel,
          parentSessionKey: parentKey,
          spawnedBy: parentKey,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["child-run"],
          createdAt: now - 30_000,
          startedAt: now - 30_000,
          updatedAt: now - 1_000,
        };
        const parent: GatewaySessionRow & { updatedAt: number } = {
          key: parentKey,
          sessionId: "addressed-parent",
          kind: "direct",
          label: "Plan the trip",
          hasActiveRun: true,
          activeRunIds: ["parent-run"],
          hasActiveSubagentRun: true,
          childSessions: [child.key],
          status: "running",
          startedAt: now - 45_000,
          updatedAt: now - 1_000,
        };
        const calls = [
          {
            type: "toolCall",
            id: "read-notes",
            name: "read",
            arguments: { path: "/repo/notes.md" },
          },
          {
            type: "toolCall",
            id: "send-child",
            name: "sessions_send",
            arguments: { sessionKey: child.key, message: "Also check Friday departures." },
          },
        ];
        await installMockGateway(page, {
          sessionKey: parentKey,
          sessions: [parent, child],
          inFlightRun: { runId: "parent-run", startedAt: parent.startedAt },
          historyMessages: [
            {
              role: "user",
              content: "Find the cheapest flight next week.",
              timestamp: now - 45_000,
              __openclaw: { id: "request", seq: 1, idempotencyKey: "parent-run:user" },
            },
            {
              role: "assistant",
              runId: "parent-run",
              timestamp: now - 5_000,
              __openclaw: { id: "steer", seq: 2, runId: "parent-run" },
              content: calls,
              activity: [
                {
                  itemId: "tool:read-notes",
                  toolCallId: "read-notes",
                  kind: "tool",
                  name: "read",
                  title: "Read notes.md",
                  phase: "end",
                  status: "completed",
                },
                {
                  itemId: "tool:send-child",
                  toolCallId: "send-child",
                  kind: "tool",
                  name: "sessions_send",
                  // The Gateway's shared progress text carries the key's short suffix.
                  title: "Send to session",
                  meta: "…7ef3",
                  phase: "start",
                  status: "running",
                },
              ],
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
        const pane = page.locator(".chat-pane-cache__pane--active");
        const headline = pane.locator(".chat-activity-group__label--live");
        await headline.waitFor();
        const group = pane.locator(".chat-activity-group", {
          has: page.locator(".chat-activity-group__label--live"),
        });
        const artifactDir = createControlUiE2eArtifactDir("subagent-addressed-headline");
        await expect.poll(() => headline.textContent()).not.toBe("");
        const frame = await takeControlUiScreenshotFrame(page, pane, [group], {
          animations: "disabled",
        });
        await writeFile(path.join(artifactDir, "headline.png"), frame.png);
        await writeFile(
          path.join(artifactDir, "headline.txt"),
          (await headline.textContent()) ?? "",
        );
        await expect.poll(() => headline.textContent()).toContain(childLabel);
        expect(await headline.textContent()).not.toContain("7ef3");
      },
    );
  });
});
