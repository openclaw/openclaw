import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import type { CommandPaletteTargetDetail } from "../components/command-palette-contract.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  expectAbsent,
  expectNoRequests,
  expectRequestCount,
} from "./workspace-terminal.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Subagents panel" });

const previewModel = {
  agentModel: "openai/gpt-4.1",
  models: [{ id: "gpt-4.1", name: "Preview model", provider: "openai" }],
};

const recoveryDraft = "Summarize the notice review results.";

async function seedRecoverableDraft(page: Page) {
  await page.addInitScript(
    ({ gatewayUrl, draft }) => {
      if (sessionStorage.getItem("subagent-recovery-seeded")) {
        return;
      }
      sessionStorage.setItem("subagent-recovery-seeded", "yes");
      sessionStorage.setItem(
        "openclaw.control.chatComposer.v4:" + encodeURIComponent(gatewayUrl),
        JSON.stringify({
          version: 4,
          gatewayOwner: gatewayUrl,
          sessions: {
            "global\u0000agent:main": {
              updatedAt: 1790955600000,
              draftRevision: 43,
              draft,
            },
          },
          recovery: {},
        }),
      );
    },
    { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl), draft: recoveryDraft },
  );
}

function scenario() {
  const now = Date.now();
  const parent = {
    key: "agent:main:panel-parent",
    agentId: "main",
    sessionId: "parent-session",
    kind: "direct",
    label: "Workspace review",
    updatedAt: now,
    hasActiveSubagentRun: true,
  } satisfies GatewaySessionRow;
  const child = {
    key: "agent:main:subagent:notice-review",
    agentId: "main",
    sessionId: "notice-session",
    kind: "direct",
    classification: "subagent",
    label: "Check notice dismissal",
    spawnedBy: parent.key,
    parentSessionKey: parent.key,
    updatedAt: now,
    status: "running",
    hasActiveRun: true,
    activeRunIds: ["notice-run"],
    startedAt: now - 18_000,
  } satisfies GatewaySessionRow;
  const other = {
    ...child,
    key: "agent:main:subagent:keyboard-review",
    sessionId: "keyboard-session",
    label: "Review keyboard navigation",
    activeRunIds: ["keyboard-run"],
    startedAt: now - 35_000,
  } satisfies GatewaySessionRow;
  const finished = {
    ...child,
    key: "agent:main:subagent:trace-review",
    sessionId: "trace-session",
    label: "Trace the regression",
    hasActiveRun: false,
    status: "done",
    activeRunIds: [],
    startedAt: now - 110_000,
    endedAt: now - 40_000,
  } satisfies GatewaySessionRow;
  const swarm = {
    ...child,
    key: "agent:main:subagent:swarm-worker",
    sessionId: "swarm-session",
    label: "Parallel audit worker",
    swarmGroupId: "parallel-audit",
  } satisfies GatewaySessionRow;
  const persistent = {
    key: "agent:main:dashboard:persistent-child",
    agentId: "main",
    sessionId: "persistent-session",
    kind: "direct",
    label: "Persistent conversation",
    spawnedBy: parent.key,
  } satisfies GatewaySessionRow;
  const queued = {
    ...child,
    key: "agent:main:subagent:queued-review",
    sessionId: "queued-session",
    label: "Wait for a worker slot",
    status: "queued",
    hasActiveRun: false,
    activeRunIds: [],
    startedAt: undefined,
  } satisfies GatewaySessionRow;
  const tool = (id: string) => ({
    role: "assistant",
    runId: "notice-run",
    content: [{ type: "toolCall", id, name: "read", arguments: { path: "notice.ts" } }],
  });
  const messages = [
    { role: "user", content: "Check the notice dismissal behavior." },
    tool("read-one"),
    {
      role: "toolResult",
      runId: "notice-run",
      toolCallId: "read-one",
      toolName: "read",
      content: "Notice source",
    },
    tool("read-two"),
    { role: "assistant", runId: "notice-run", content: "Inspecting the notice component." },
  ];
  return { parent, child, other, finished, swarm, persistent, queued, messages };
}

suite.define(() => {
  it("shows live native children separately and refreshes their read-only status", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, colorScheme: "dark", locale: "en-US" },
      async ({ page }) => {
        await page.clock.install();
        const { parent, child } = scenario();
        const nativeLabel = "/root/synthetic-audit";
        const nativeResponse = (status: "running" | "completed") => ({
          session: parent,
          nativeSubagents: {
            coverage: "live",
            children: [{ id: "synthetic-native-child", label: nativeLabel, status }],
            truncated: false,
          },
        });
        const describeResponse = (response: unknown) => ({
          cases: [
            { match: { key: parent.key, includeNativeSubagents: true }, response },
            { match: { key: parent.key }, response: { session: parent } },
          ],
        });
        const gateway = await installMockGateway(page, {
          ...previewModel,
          sessionKey: parent.key,
          communityInvite: false,
          // Native observations deliberately have no Gateway session row or transcript.
          sessions: [parent, child],
          historyMessages: [{ role: "assistant", content: "Synthetic child visibility audit." }],
          sessionTranscripts: { [child.key]: { messages: [] } },
          methodResponses: {
            "sessions.describe": describeResponse(nativeResponse("running")),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        await openChatSidePanelType(page, "Subagents");
        const panel = page.locator("openclaw-chat-subagents-panel");
        const managed = panel.locator(`[data-session-key="${child.key}"]`);
        const openManaged = managed.locator(
          ".subagents-desktop__open, .chat-subagents-mobile__open",
        );
        const stopManaged = managed.getByRole("button", { name: `Stop ${child.label}` });
        await openManaged.waitFor();
        await stopManaged.waitFor();
        const native = panel.getByRole("region", { name: "Live native agents", exact: true });
        const nativeRow = native.getByRole("listitem").filter({ hasText: nativeLabel });
        // The suite allocates one retained artifact directory per test attempt.
        const directory = suite.artifactDir;
        const capture = async (stage: string) => {
          await managed.hover();
          const content = [openManaged, stopManaged];
          if (await nativeRow.isVisible()) {
            content.push(nativeRow);
          }
          const surface = panel.locator(".subagents-desktop, .chat-subagents-mobile");
          const frame = await takeControlUiScreenshotFrame(page, surface, content, {
            animations: "disabled",
            elements: [surface],
          });
          await writeFile(path.join(directory, `${stage}.png`), frame.png);
          await writeFile(path.join(directory, `${stage}-panel.png`), frame.elements[0]!.png);
          await writeFile(
            path.join(directory, `${stage}-describe-requests.json`),
            JSON.stringify(await gateway.getRequests("sessions.describe"), null, 2),
          );
        };
        // Capture the unchanged base's missing row even when this visible assertion fails.
        // Both builds receive valid responses; the failure must be missing rendered content.
        try {
          await nativeRow.getByText(nativeLabel, { exact: true }).waitFor({ timeout: 10_000 });
          await nativeRow.getByText("Running", { exact: true }).waitFor();
        } finally {
          await capture("native-running");
        }
        expect(await nativeRow.count()).toBe(1);
        expect(await nativeRow.getByRole("button").count()).toBe(0);
        expect(await nativeRow.getByRole("link").count()).toBe(0);
        expect(await nativeRow.getAttribute("data-session-key")).toBeNull();
        expect(await panel.locator(".chat-subagents__running").getByText(nativeLabel).count()).toBe(
          0,
        );
        expect(await openManaged.isVisible()).toBe(true);
        expect(await stopManaged.isVisible()).toBe(true);
        expect(await openManaged.isEnabled()).toBe(true);
        expect(await stopManaged.isEnabled()).toBe(true);
        const reads = await gateway.getRequests("sessions.describe", {
          key: parent.key,
          includeNativeSubagents: true,
        });
        expect(reads.length).toBeGreaterThan(0);
        expect(reads[0]?.params).toEqual({
          key: parent.key,
          includeNativeSubagents: true,
        });
        await expectNoRequests(gateway, ["sessions.abort", "chat.send", "chat.abort"]);

        await pauseVirtualClock(page);
        await gateway.setMethodResponse(
          "sessions.describe",
          describeResponse(nativeResponse("completed")),
        );
        // Advance the production owner's five-second poll; keep the same visible panel.
        await page.clock.runFor(5_100);
        await nativeRow.getByText("Completed", { exact: true }).waitFor({ timeout: 10_000 });
        expect(await nativeRow.getByText("Running", { exact: true }).count()).toBe(0);
        expect(await nativeRow.getByRole("button").count()).toBe(0);
        expect(await openManaged.isVisible()).toBe(true);
        expect(await stopManaged.isVisible()).toBe(true);
        await capture("native-completed");

        await page.setViewportSize({ width: 390, height: 900 });
        await page.locator(".shell--mobile-nav").waitFor();
        await openChatSidePanelType(page, "Subagents");
        await nativeRow.getByText("Completed", { exact: true }).waitFor();
        expect(await nativeRow.getByRole("button").count()).toBe(0);
        expect(await openManaged.isVisible()).toBe(true);
        expect(await stopManaged.isVisible()).toBe(true);
        await capture("native-mobile-completed");

        await gateway.setMethodResponse(
          "sessions.describe",
          describeResponse({
            __mockError: { code: "FORBIDDEN", message: "Synthetic parent access revoked" },
          }),
        );
        await page.clock.runFor(5_100);
        await native
          .getByRole("alert")
          .getByText(/Synthetic parent access revoked/)
          .waitFor({ timeout: 10_000 });
        expect(await native.getByRole("listitem").count()).toBe(0);
        expect(await panel.getByText(nativeLabel, { exact: true }).count()).toBe(0);
        await expectNoRequests(gateway, ["sessions.abort", "chat.send", "chat.abort"]);
        await native
          .getByText("Updates retry automatically while this panel is visible.")
          .waitFor();
        await capture("native-parent-denied");
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator(".shell:not(.shell--mobile-nav)").waitFor();
        await openChatSidePanelType(page, "Subagents");
        await native
          .getByRole("alert")
          .getByText(/Synthetic parent access revoked/)
          .waitFor();
        expect(await native.getByRole("listitem").count()).toBe(0);
        await capture("native-desktop-parent-denied");
      },
    );
  });

  it("keeps narrow subagent reports inside the panel and scrollable", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, colorScheme: "dark" },
      async ({ page }) => {
        const { parent, child } = scenario();
        const report = [
          "Ready: the navigation preference repair is implemented and verified.",
          "### Worktree",
          "`/workspace/openclaw/personal-navigation-preferences`",
          "### Changed",
          "- Preserve the latest navigation choice while a save is pending.\n- Keep preferences scoped to the signed-in profile.\n- Reconcile delayed updates without restoring an older selection.",
          "### Repair",
          "The existing preference owner applies each accepted change in order. A delayed response cannot overwrite a newer choice, and unrelated settings remain unchanged.",
          "### Proof",
          "- Reproduced the original failure through the real settings flow.\n- Verified keyboard navigation and reload behavior.\n- Confirmed that narrow panels keep long paths and reports readable.",
        ].join("\n\n");
        await installMockGateway(page, {
          ...previewModel,
          sessionKey: parent.key,
          presenceUsers: [{ id: "layout-reviewer", name: "Layout reviewer", self: true }],
          sessions: [parent, child],
          historyMessages: [{ role: "assistant", content: "Reviewing navigation preferences." }],
          sessionTranscripts: {
            [child.key]: {
              messages: [
                {
                  role: "user",
                  content: "Review the navigation preference changes.",
                  senderSession: { sessionKey: parent.key, agentId: "main", label: parent.label },
                  provenance: {
                    kind: "inter_session",
                    sourceSessionKey: parent.key,
                    sourceTool: "sessions_send",
                  },
                },
                { role: "assistant", content: report },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        await openChatSidePanelType(page, "Subagents");
        const panel = page.locator("openclaw-chat-subagents-panel");
        await panel
          .locator(".subagents-desktop__open")
          .filter({ has: page.getByText(child.label, { exact: true }) })
          .click();
        const detail = panel.locator(".chat-subagent-detail");
        const copy = detail.getByText(
          "Ready: the navigation preference repair is implemented and verified.",
          { exact: true },
        );
        await copy.waitFor();
        await page.mouse.move(10, 10);
        const stop = detail.locator(".subagents-desktop__stop");
        await stop.waitFor();
        const stopInk = await stop.evaluate((button) => {
          const glyph = button.querySelector("svg")!;
          return {
            label: getComputedStyle(button).color,
            glyph: getComputedStyle(glyph).color,
            fill: getComputedStyle(glyph).fill,
          };
        });
        expect(stopInk.glyph, "Stop keeps its destructive label foreground at rest").toBe(
          stopInk.label,
        );
        expect(stopInk.fill, "Stop paints its destructive glyph foreground").toBe(stopInk.label);

        const thread = detail.locator(".chat-thread");
        const initialWidth = (await thread.boundingBox())!.width;
        expect(initialWidth).toBeLessThanOrEqual(560);
        await page.setViewportSize({ width: 1440, height: 600 });
        await page.getByRole("separator", { name: "Resize side panel", exact: true }).press("End");
        await expect
          .poll(async () => (await panel.boundingBox())!.width)
          .toBeLessThan(initialWidth);
        const geometry = await thread.evaluate((element) => {
          const outer = element.closest("openclaw-chat-subagents-panel")!.getBoundingClientRect();
          const inner = element.getBoundingClientRect();
          return {
            left: inner.left - outer.left,
            right: inner.right - outer.right,
            overflow: element.scrollWidth - element.clientWidth,
          };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(-1);
        expect(geometry.right).toBeLessThanOrEqual(1);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        const bounds = (await panel.boundingBox())!;
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.wheel(0, -2000);
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
        await page.mouse.wheel(0, 2000);
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        const last = detail.getByText(
          "Confirmed that narrow panels keep long paths and reports readable.",
          { exact: true },
        );
        await expect
          .poll(() =>
            last.evaluate((element) => {
              const text = element.getBoundingClientRect();
              const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
              return text.top >= viewport.top && text.bottom <= viewport.bottom;
            }),
          )
          .toBe(true);
        await panel.getByRole("button", { name: "Back to Subagents", exact: true }).click();
        await panel
          .locator(".subagents-desktop__open")
          .filter({ has: page.getByText(child.label, { exact: true }) })
          .waitFor();
      },
    );
  });

  it("keeps a child waiting on descendants in Running until its work settles", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const { parent, child, finished } = scenario();
      const waiting = {
        ...finished,
        key: "agent:main:subagent:coordinator-review",
        sessionId: "coordinator-session",
        label: "Coordinate the remaining review",
        hasActiveSubagentRun: true,
      } satisfies GatewaySessionRow;
      const gateway = await installMockGateway(page, {
        ...previewModel,
        sessionKey: parent.key,
        communityInvite: false,
        sessions: [parent, child, waiting, finished],
        historyMessages: [
          { role: "assistant", content: "The delegated review is still underway." },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
      await openChatSidePanelType(page, "Subagents");
      const panel = page.locator("openclaw-chat-subagents-panel");
      const waitingRow = panel.locator(`[data-session-key="${waiting.key}"]`);
      await waitingRow.waitFor();

      expect(await panel.locator('[data-group="waiting"]').getByText(waiting.label).count()).toBe(
        1,
      );
      expect(await waitingRow.getByRole("button", { name: `Stop ${waiting.label}` }).count()).toBe(
        0,
      );
      await panel.locator('[data-group="done"]').getByText(finished.label).waitFor();
      const settled = { ...waiting, hasActiveSubagentRun: false, updatedAt: Date.now() + 1 };
      await gateway.setSessionsListResponse({ sessions: [parent, child, settled, finished] });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: settled.key,
        reason: "run-end",
        ts: settled.updatedAt,
        session: settled,
        ancestorSessions: [parent],
      });
      await panel.locator('[data-group="done"]').getByText(waiting.label).waitFor();
      expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
    });
  });

  it("opens subagents including swarm workers beside the parent and keeps activity, drafts and Stop scoped", async () => {
    const viewport = { width: 1440, height: 900 };
    await suite.withPage(
      {
        viewport,
        colorScheme: "dark",
      },
      async ({ page }) => {
        const { parent, child, other, finished, swarm, persistent, queued, messages } = scenario();
        const keyboardActivity = {
          itemId: "tool:keyboard-command",
          toolCallId: "keyboard-command",
          kind: "tool",
          name: "exec",
          title: "Exec Retry failed benchmark targets",
          meta: "Retry failed benchmark targets",
          phase: "start",
          status: "running",
        };
        const gateway = await installMockGateway(page, {
          ...previewModel,
          sessionKey: parent.key,
          communityInvite: false,
          sessions: [parent, child, other, finished, swarm, persistent, queued],
          methodResponses: {
            "chat.history": {
              cases: [
                {
                  match: { sessionKey: other.key },
                  response: {
                    sessionId: other.sessionId,
                    messages: [
                      {
                        role: "assistant",
                        runId: "keyboard-run",
                        content: [
                          {
                            type: "toolCall",
                            id: "keyboard-command",
                            name: "exec",
                            arguments: {
                              title: "Retry failed benchmark targets",
                              code: "return true;",
                            },
                          },
                        ],
                        activity: [keyboardActivity],
                      },
                    ],
                    hasMore: true,
                    totalMessages: 160,
                    inFlightRun: { runId: "keyboard-run", startedAt: other.startedAt },
                  },
                },
                {
                  match: { sessionKey: child.key },
                  response: {
                    sessionId: child.sessionId,
                    messages,
                    hasMore: false,
                    totalMessages: messages.length,
                    inFlightRun: { runId: "notice-run", startedAt: child.startedAt },
                  },
                },
              ],
            },
          },
          sessionTranscripts: {
            [parent.key]: {
              messages: [
                {
                  role: "assistant",
                  content: "I’ll review the notice behavior and keyboard navigation.",
                },
              ],
            },
            [child.key]: {
              messages,
              inFlightRun: { runId: "notice-run", startedAt: child.startedAt },
            },
            [other.key]: {
              messages: [],
              inFlightRun: { runId: "keyboard-run", startedAt: other.startedAt },
            },
            [finished.key]: {
              messages: [{ role: "assistant", content: "The regression is traced." }],
            },
            [swarm.key]: {
              messages: [{ role: "assistant", content: "Comparing concurrent task results." }],
            },
          },
        });
        await seedRecoverableDraft(page);
        await page.addInitScript(() => {
          window.addEventListener("openclaw-command-palette-target", (event) => {
            const { owner, onSlashCommand } = (event as CustomEvent<CommandPaletteTargetDetail>)
              .detail;
            if (onSlashCommand && owner.closest("openclaw-chat-subagents-panel")) {
              document.documentElement.dataset.subagentClaimedInput = "true";
            }
          });
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        const parentPane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const draft = parentPane.locator(".agent-chat__composer-combobox textarea");
        await draft.fill("Keep this parent draft");
        const recovery = parentPane.locator(".chat-outbox-recovery-row");
        await recovery.getByText(recoveryDraft, { exact: true }).waitFor();

        expect(
          await parentPane
            .locator(".chat-pane__header")
            .getByRole("button", { name: "Subagents", exact: true })
            .count(),
        ).toBe(0);
        await openChatSidePanelType(page, "Subagents");
        const panel = parentPane.locator("openclaw-chat-subagents-panel");
        const row = panel.locator(`[data-session-key="${child.key}"]`);
        await row
          .locator(".subagents-desktop__open")
          .filter({ has: page.getByText(child.label, { exact: true }) })
          .waitFor();
        await expect.poll(() => panel.locator(".subagents-desktop__row").count()).toBe(5);
        await panel
          .locator(`[data-group="waiting"][data-session-key="${queued.key}"]`)
          .getByText("Queued", { exact: true })
          .waitFor();
        await panel
          .locator('[data-group="active"]')
          .getByText(swarm.label, { exact: true })
          .waitFor();
        expect(await panel.getByText(persistent.label, { exact: true }).count()).toBe(0);
        await expect
          .poll(() => row.locator(".subagents-desktop__open").getAttribute("title"))
          .toContain("2 calls");

        const activity = {
          sessionKey: child.key,
          agentId: "main",
          runId: "notice-run",
          seq: 9,
          ts: Date.now(),
          stream: "item",
          data: {
            itemId: "tool:read-two",
            toolCallId: "read-two",
            kind: "tool",
            name: "read",
            title: "Read notice.ts",
            phase: "update",
            status: "running",
            progressText: "Reading notice component",
          },
        };
        await gateway.emitGatewayEvent("agent", activity);
        await expect
          .poll(() => row.locator(".subagents-desktop__open").getAttribute("title"))
          .toContain("Reading notice component");
        await gateway.emitGatewayEvent("agent", activity);
        expect(await row.locator(".subagents-desktop__open").getAttribute("title")).toContain(
          "2 calls",
        );
        await gateway.emitGatewayEvent("agent", {
          sessionKey: other.key,
          agentId: "main",
          runId: "keyboard-run",
          seq: 1,
          ts: Date.now(),
          stream: "item",
          data: { ...keyboardActivity, phase: "update" },
        });
        const otherRow = panel.locator(`[data-session-key="${other.key}"]`);
        await otherRow.locator(".subagents-desktop__open").waitFor();
        await expect
          .poll(() => otherRow.locator(".subagents-desktop__open").getAttribute("title"))
          .toContain("Retry failed benchmark targets");
        await expect
          .poll(() => otherRow.locator(".subagents-desktop__open").getAttribute("title"))
          .toContain("1+ calls");
        expect(await row.locator(".subagents-desktop__avatar").count()).toBe(1);

        await panel
          .locator(".subagents-desktop__open")
          .filter({ has: page.getByText(swarm.label, { exact: true }) })
          .click();
        await panel.getByText("Comparing concurrent task results.", { exact: true }).waitFor();
        expect(page.url()).toBe(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        expect(await draft.inputValue()).toBe("Keep this parent draft");
        await panel.getByRole("button", { name: "Back to Subagents", exact: true }).click();
        await row
          .locator(".subagents-desktop__open")
          .filter({ has: page.getByText(child.label, { exact: true }) })
          .click();
        const detail = panel.locator(".chat-subagent-detail");
        await detail.getByText("Inspecting the notice component.", { exact: true }).waitFor();
        await expectAbsent(detail, [
          "textarea",
          ".agent-chat__disabled-banner",
          ".chat-subagent-detail__header openclaw-elapsed-time",
        ]);
        expect(await detail.getByRole("button", { name: "Open parent session" }).count()).toBe(0);
        expect(await draft.inputValue()).toBe("Keep this parent draft");
        expect(await page.locator("html").getAttribute("data-subagent-claimed-input")).toBeNull();

        expect(await detail.locator("openclaw-chat-outbox-recovery").count()).toBe(0);
        expect(await recovery.count()).toBe(1);
        await recovery.getByRole("button", { name: "Restore", exact: true }).waitFor();
        await recovery.getByRole("button", { name: "Delete", exact: true }).waitFor();
        for (const summary of await detail.locator(".chat-activity-group__summary").all()) {
          if ((await summary.getAttribute("aria-expanded")) === "false") {
            await summary.click();
          }
        }
        const toolRow = detail.locator(".chat-tool-row__toggle").first();
        if ((await toolRow.getAttribute("aria-expanded")) === "false") {
          await toolRow.click({ position: { x: 4, y: 4 } });
        }
        await detail
          .getByRole("button", { name: "Open tool details in side panel", exact: true })
          .first()
          .click();
        await detail
          .locator("openclaw-chat-tool-output")
          .getByText("Notice source", { exact: true })
          .waitFor();
        await detail.getByRole("button", { name: "Close Review", exact: true }).click();
        await detail.getByRole("button", { name: "Back to Subagents", exact: true }).click();
        await row.waitFor();
        await gateway.deferNext("sessions.abort");
        const stop = otherRow.locator(".subagents-desktop__stop");
        await stop.click();
        try {
          await expectRequestCount(gateway, "sessions.abort", 1);
          expect((await gateway.getRequests("sessions.abort"))[0]?.params).toMatchObject({
            key: other.key,
            agentId: "main",
            runId: "keyboard-run",
          });
          await expect.poll(() => stop.isDisabled()).toBe(true);
          await otherRow.locator(".subagents-desktop__open").click();
          const childPane = panel.locator("openclaw-chat-pane");
          await childPane.getByRole("button", { name: "Back to Subagents", exact: true }).waitFor();
          expect(await draft.inputValue()).toBe("Keep this parent draft");
        } finally {
          await gateway.resolveDeferred("sessions.abort", { aborted: true });
        }
        await panel.getByRole("button", { name: "Back to Subagents", exact: true }).click();
        await row.waitFor();
        await expectNoRequests(gateway, ["chat.send", "chat.abort"]);
        expect(await draft.inputValue()).toBe("Keep this parent draft");
        await page.reload();
        await parentPane.locator("openclaw-chat-subagents-panel").waitFor();
        expect(await draft.inputValue()).toBe("Keep this parent draft");
      },
    );
  });

  it.each([false, true])(
    "preserves child fork handoff and navigation refusal (%s)",
    async (refuse) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const { parent, child } = scenario();
        const completedChild = {
          ...child,
          status: "done",
          hasActiveRun: false,
          activeRunIds: [],
        } satisfies GatewaySessionRow;
        const fork = {
          key: "agent:main:fork-result",
          agentId: "main",
          sessionId: "fork-result-session",
          kind: "direct",
          label: "Forked review",
          updatedAt: Date.now(),
        } satisfies GatewaySessionRow;
        const editorText = "Continue reviewing this image.";
        const imageData =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        const gateway = await installMockGateway(page, {
          ...previewModel,
          sessionKey: parent.key,
          communityInvite: false,
          sessions: [parent, completedChild],
          sessionTranscripts: {
            [parent.key]: { messages: [] },
            [child.key]: {
              messages: [
                {
                  role: "user",
                  content: "Review the image.",
                  timestamp: Date.now(),
                  __openclaw: { id: "fork-request", seq: 1 },
                },
              ],
            },
            [fork.key]: { messages: [] },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        const originalUrl = page.url();
        const parentPane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const composer = parentPane.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep the original parent draft");
        expect(
          await parentPane
            .locator(".chat-pane__header")
            .getByRole("button", { name: "Subagents", exact: true })
            .count(),
        ).toBe(0);
        await openChatSidePanelType(page, "Subagents");
        await parentPane
          .locator("openclaw-chat-subagents-panel")
          .locator(".subagents-desktop__open")
          .filter({ has: page.getByText(child.label, { exact: true }) })
          .click();
        const detail = parentPane.locator(".chat-subagent-detail");
        await detail.locator('.chat-bubble[data-entry-id="fork-request"]').waitFor();
        await gateway.deferNext("sessions.fork");
        await detail
          .locator('.chat-bubble[data-entry-id="fork-request"]')
          .click({ button: "right" });
        await page.getByRole("menuitem", { name: "Fork from here", exact: true }).click();
        const request = await gateway.waitForRequest("sessions.fork");
        expect(request.params).toMatchObject({ sessionKey: child.key, entryId: "fork-request" });
        await gateway.setSessionsListResponse({ sessions: [parent, completedChild, fork] });
        if (refuse) {
          // A route can advance before the chat page retires its presentation.
          await page.evaluate(() => history.pushState(null, "", "/sessions"));
        }
        await gateway.resolveDeferred("sessions.fork", {
          sessionKey: fork.key,
          editorText,
          editorAttachments: [{ mimeType: "image/png", data: imageData }],
        });
        const forkLink = page.locator(
          `openclaw-app-sidebar [data-session-key="${fork.key}"] a.sidebar-recent-session__link`,
        );
        await forkLink.waitFor();
        if (refuse) {
          expect(new URL(page.url()).pathname).toBe("/sessions");
          expect(await composer.inputValue()).toBe("Keep the original parent draft");
          await page.evaluate((url) => history.replaceState(null, "", url), originalUrl);
          await forkLink.click();
          await page.waitForURL(controlUiSessionUrl(suite.server.baseUrl, fork.key));
          await expect.poll(() => composer.inputValue()).toBe("");
          expect(
            await parentPane.locator(".agent-chat__input .chat-attachment-thumb").count(),
          ).toBe(0);
        } else {
          await page.waitForURL(controlUiSessionUrl(suite.server.baseUrl, fork.key));
          await expect.poll(() => composer.inputValue()).toBe(editorText);
          const image = parentPane.locator(".agent-chat__input .chat-attachment-thumb img");
          await image.waitFor();
          await expect
            .poll(() =>
              image.evaluate(
                (element: HTMLImageElement) => element.complete && element.naturalWidth === 1,
              ),
            )
            .toBe(true);
        }
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );

  it.each([1440, 390])(
    "keeps the compact parent notice on a direct subagent page at %ipx",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, colorScheme: "dark" },
        async ({ page }) => {
          const { parent, child, messages } = scenario();
          const gateway = await installMockGateway(page, {
            ...previewModel,
            sessionKey: child.key,
            communityInvite: false,
            sessions: [parent, child],
            sessionTranscripts: {
              [parent.key]: { messages: [{ role: "assistant", content: "Parent conversation." }] },
              [child.key]: {
                messages,
                inFlightRun: { runId: "notice-run", startedAt: child.startedAt },
              },
            },
          });
          await seedRecoverableDraft(page);
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, child.key));
          const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
          const notice = pane.locator(".agent-chat__disabled-banner--replacement");
          await notice.getByText("View-only subagent", { exact: true }).waitFor();
          await notice.getByText(`Continue in ${parent.label}.`, { exact: true }).waitFor();

          await expectAbsent(pane, [
            ".agent-chat__composer-combobox textarea",
            "openclaw-chat-outbox-recovery",
          ]);
          if (width < 900) {
            await pane.getByRole("button", { name: "Actions for " + child.label }).click();
            await pane.getByRole("menuitem", { name: "Stop generating", exact: true }).waitFor();
            await page.keyboard.press("Escape");
            expect(
              await notice.getByRole("button", { name: "Stop generating", exact: true }).count(),
            ).toBe(0);
          } else {
            await notice.getByRole("button", { name: "Stop generating", exact: true }).waitFor();
            expect(
              await pane.getByRole("button", { name: "Stop generating", exact: true }).count(),
            ).toBe(1);
          }
          expect(
            await notice.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
            }),
          ).toBe(true);
          await notice.getByRole("button", { name: "Open parent session", exact: true }).click();
          await pane.getByText("Parent conversation.", { exact: true }).waitFor();
          await pane.locator(".agent-chat__composer-combobox textarea").waitFor();
          await pane
            .locator(".chat-outbox-recovery-row")
            .getByText(recoveryDraft, { exact: true })
            .waitFor();
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    },
  );
});
