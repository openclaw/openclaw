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
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Subagent presentation" });
const now = 1_800_000_000_000;

suite.define(() => {
  it.each([
    { name: "ordinary", count: 1, grouped: false },
    { name: "swarm", count: 12, grouped: true },
  ])(
    "keeps $name workers in Details and the footer without duplicate transcript views",
    async ({ name, count, grouped }) => {
      await suite.withPage(
        { locale: "en-US", viewport: { width: 1440, height: 900 } },
        async ({ page }) => {
          await page.clock.setFixedTime(now);
          await page.addInitScript(
            (key) =>
              localStorage.setItem(key, JSON.stringify({ themeMode: "dark", navCollapsed: true })),
            controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          );
          const parentKey = "agent:main:subagent-presentation";
          const groupId = grouped ? "swarm:layout-review" : undefined;
          const firstChildLabel = "Audit mobile header CSS reuse";
          const children = Array.from(
            { length: count },
            (_, index): GatewaySessionRow & { updatedAt: number } => ({
              key: "agent:main:subagent:layout-" + index,
              sessionId: "layout-" + index,
              kind: "direct",
              classification: "subagent",
              label: index === 0 ? firstChildLabel : "Review layout " + (index + 1),
              parentSessionKey: parentKey,
              spawnedBy: parentKey,
              swarmGroupId: groupId,
              status: "running",
              hasActiveRun: true,
              activeRunIds: ["child-run-" + index],
              createdAt: now - 30_000 + index,
              startedAt: now - 30_000 + index,
              updatedAt: now - 1_000,
            }),
          );
          const parent: GatewaySessionRow & { updatedAt: number } = {
            key: parentKey,
            sessionId: "presentation-parent",
            kind: "direct",
            label: "Review mobile header",
            hasActiveRun: true,
            activeRunIds: ["parent-run"],
            hasActiveSubagentRun: true,
            childSessions: children.map((child) => child.key),
            status: "running",
            startedAt: now - 45_000,
            updatedAt: now - 1_000,
            ...(groupId
              ? {
                  swarm: {
                    otherActiveGroups: 0,
                    groups: [
                      {
                        groupId,
                        createdAt: now - 30_000,
                        queued: 0,
                        running: count,
                        done: 0,
                        failed: 0,
                        children: children.map((child) => ({
                          sessionKey: child.key,
                          status: "running" as const,
                        })),
                      },
                    ],
                  },
                }
              : {}),
          };
          await installMockGateway(page, {
            sessionKey: parentKey,
            sessions: [parent, ...children],
            inFlightRun: { runId: "parent-run", startedAt: parent.startedAt },
            historyMessages: [
              {
                role: "user",
                content: "Review the mobile header CSS without changing the approved design.",
                timestamp: now - 45_000,
              },
              {
                role: "assistant",
                content: "I’ll trace the existing styles and keep the approved design unchanged.",
                timestamp: now - 35_000,
                __openclaw: { id: "delegation", seq: 2, runId: "parent-run" },
                activity: children.map((child, index) => ({
                  itemId: "spawn-" + index,
                  name: "sessions_spawn",
                  kind: "tool",
                  title: child.label,
                  phase: "end",
                  status: "completed",
                  delegation: [
                    {
                      runId: "child-run-" + index,
                      childSessionKey: child.key,
                      label: child.label,
                      groupId,
                      status: "accepted",
                    },
                  ],
                })),
              },
            ],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
          const pane = page.locator(".chat-pane-cache__pane--active");
          const footer = pane.locator(".chat-working-indicator");
          const label = count === 1 ? "1 subagent running" : count + " subagents running";
          await footer.getByRole("button", { name: label, exact: true }).waitFor();
          const details = await openChatDetails(pane);
          const block = details.locator('[data-details-group="subagents"]');
          await block.waitFor();
          await expect
            .poll(() => block.textContent())
            .toContain(count === 1 ? firstChildLabel : String(count));
          const artifactDir = createControlUiE2eArtifactDir("subagent-surfaces-" + name);
          const frame = await takeControlUiScreenshotFrame(page, pane, [footer, block], {
            animations: "disabled",
          });
          await writeFile(path.join(artifactDir, "active.png"), frame.png);
          expect(await pane.locator('[data-test-id="chat-delegation"]').count()).toBe(0);
          expect(await pane.locator(".chat-thread openclaw-chat-subagent-activity").count()).toBe(
            0,
          );
          await footer.getByRole("button", { name: label, exact: true }).click();
          const panel = pane.locator("openclaw-chat-subagents-panel");
          await panel.waitFor();
          await expect.poll(() => panel.locator("[data-session-key]").count()).toBe(count);
          await panel.getByText(firstChildLabel, { exact: true }).waitFor();
        },
      );
    },
  );
});
