import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Subagent presentation" });
const now = 1_800_000_000_000;

suite.define(() => {
  it("keeps owned background commands visible without making detached services busy", async () => {
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        await page.clock.setFixedTime(now);
        const key = "agent:main:background-command-footer";
        const parent = {
          key,
          sessionId: "command-footer-parent",
          kind: "direct",
          label: "Verify the change",
          hasActiveRun: false,
          status: "done",
          startedAt: now - 60_000,
          endedAt: now - 45_000,
        } satisfies GatewaySessionRow;
        const service = {
          processId: "preview",
          instanceId: "preview-1",
          name: "Preview server",
          status: "running",
          startedAt: now - 60_000,
          taskOwned: false,
          tail: "Preview available",
          truncated: false,
          canStop: true,
        } as const;
        const command = {
          ...service,
          processId: "tests",
          instanceId: "tests-1",
          name: "Targeted tests",
          startedAt: now - 30_000,
          taskOwned: true,
          tail: "Running targeted tests",
        };
        const result = (processes: readonly (typeof service | typeof command)[]) => ({
          sessionId: parent.sessionId,
          processes,
          truncated: false,
        });
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "sessions.processes.list",
            "sessions.processes.stop",
          ],
          sessions: [parent],
          historyMessages: [
            {
              role: "user",
              content: "Verify the change and leave the preview available.",
              timestamp: now - 60_000,
            },
            {
              role: "assistant",
              content: "The preview is available. I started the targeted checks.",
              stopReason: "stop",
              timestamp: now - 45_000,
            },
          ],
          methodResponses: { "sessions.processes.list": result([service]) },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const pane = page.locator(".chat-pane-cache__pane--active");
        await gateway.waitForRequest("sessions.processes.list", {
          match: { key, agentId: "main" },
        });
        await pane
          .getByText("The preview is available. I started the targeted checks.", { exact: true })
          .waitFor();
        expect(await pane.locator(".chat-working-indicator").count()).toBe(0);
        await gateway.setMethodResponse("sessions.processes.list", result([service, command]));
        await gateway.emitGatewayEvent("sessions.processes.changed", {
          sessionKey: key,
          agentId: "main",
        });
        const footer = pane.locator(".chat-working-indicator");
        const count = footer.getByRole("button", { name: "1 command running", exact: true });
        await count.waitFor();
        await gateway.setOnline(false);
        await footer.getByRole("button", { name: "Commands unavailable", exact: true }).waitFor();
        expect(await footer.locator(".chat-reading-indicator, openclaw-elapsed-time").count()).toBe(
          0,
        );
        await gateway.setOnline(true);
        await count.waitFor();
        expect(await footer.locator(".chat-reading-indicator svg").count()).toBe(1);
        expect(await footer.locator("openclaw-working-phrase").count()).toBe(0);
        const artifactDir = createControlUiE2eArtifactDir("command-footer");
        const frame = await takeControlUiScreenshotFrame(page, pane, [footer], {
          animations: "disabled",
        });
        await writeFile(path.join(artifactDir, "owned-command.png"), frame.png);
        await count.click();
        const panel = pane.locator("openclaw-chat-processes-panel");
        await panel.waitFor();
        await panel.getByText("Targeted tests", { exact: true }).waitFor();
        await panel.getByText("Preview server", { exact: true }).waitFor();
        await pane.getByRole("button", { name: "Close Processes", exact: true }).click();
        await gateway.setMethodResponse("sessions.processes.list", {
          __mockError: { code: "UNAVAILABLE", message: "The execution worker is reconnecting." },
        });
        await gateway.emitGatewayEvent("sessions.processes.changed", {
          sessionKey: key,
          agentId: "main",
        });
        await footer.getByRole("button", { name: "Commands unavailable", exact: true }).waitFor();
        expect(await footer.locator(".chat-reading-indicator, openclaw-elapsed-time").count()).toBe(
          0,
        );
        await gateway.setMethodResponse("sessions.processes.list", result([service]));
        await gateway.emitGatewayEvent("sessions.processes.changed", {
          sessionKey: key,
          agentId: "main",
        });
        await footer.waitFor({ state: "detached" });
        expect(await pane.locator(".chat-reading-indicator").count()).toBe(0);
      },
    );
  });

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
