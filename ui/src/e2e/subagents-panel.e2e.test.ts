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
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Subagents panel" });
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
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
      if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
        const frame = await takeControlUiScreenshotFrame(page, panel, [waitingRow], {
          animations: "disabled",
        });
        await writeFile(
          path.join(suite.artifactDir, "subagent-waiting-on-descendants.png"),
          frame.png,
        );
      }
      expect(await panel.locator(".chat-subagents__running").getByText(waiting.label).count()).toBe(
        1,
      );
      expect(await waitingRow.getByRole("button", { name: `Stop ${waiting.label}` }).count()).toBe(
        0,
      );
      await panel.locator(".chat-subagents__finished").getByText(finished.label).waitFor();
      const settled = { ...waiting, hasActiveSubagentRun: false, updatedAt: Date.now() + 1 };
      await gateway.setSessionsListResponse({ sessions: [parent, child, settled, finished] });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: settled.key,
        reason: "run-end",
        ts: settled.updatedAt,
        session: settled,
        ancestorSessions: [parent],
      });
      await panel.locator(".chat-subagents__finished").getByText(waiting.label).waitFor();
      expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
    });
  });

  it("opens ordinary subagents beside the parent and keeps activity, drafts and Stop scoped", async () => {
    const viewport = { width: 1440, height: 900 };
    await suite.withPage(
      {
        viewport,
        colorScheme: "dark",
        ...(capture ? { recordVideo: { dir: suite.artifactDir, size: viewport } } : {}),
      },
      async ({ page }) => {
        const { parent, child, other, finished, swarm, persistent, queued, messages } = scenario();
        const gateway = await installMockGateway(page, {
          ...previewModel,
          sessionKey: parent.key,
          communityInvite: false,
          sessions: [parent, child, other, finished, swarm, persistent, queued],
          methodResponses: {
            "chat.history": {
              cases: [
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
        if (capture) {
          await page.screenshot({ path: path.join(suite.artifactDir, "parent-before-panel.png") });
        }
        expect(
          await parentPane
            .locator(".chat-pane__header")
            .getByRole("button", { name: "Subagents", exact: true })
            .count(),
        ).toBe(0);
        await openChatSidePanelType(page, "Subagents");
        const panel = parentPane.locator("openclaw-chat-subagents-panel");
        const row = panel.locator(`[data-session-key="${child.key}"]`);
        await row.getByRole("button", { name: child.label, exact: true }).waitFor();
        await expect.poll(() => panel.locator(".chat-subagents__item").count()).toBe(4);
        await panel
          .locator(`.chat-subagents__running [data-session-key="${queued.key}"]`)
          .getByText("Queued", { exact: true })
          .waitFor();
        expect(await panel.getByText(swarm.label, { exact: true }).count()).toBe(0);
        expect(await panel.getByText(persistent.label, { exact: true }).count()).toBe(0);
        await expect
          .poll(() => row.locator(".chat-subagents__calls").textContent())
          .toBe("2 calls");

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
          .poll(() => row.locator(".chat-subagents__activity").textContent())
          .toBe("Reading notice component");
        await gateway.emitGatewayEvent("agent", activity);
        expect(await row.locator(".chat-subagents__calls").textContent()).toBe("2 calls");
        await gateway.emitGatewayEvent("agent", {
          sessionKey: other.key,
          agentId: "main",
          runId: "keyboard-run",
          seq: 1,
          ts: Date.now(),
          stream: "tool",
          data: { toolCallId: "keyboard-command", name: "bash", phase: "start" },
        });
        const otherRow = panel.locator(`[data-session-key="${other.key}"]`);
        await otherRow.locator(".chat-subagents__activity").waitFor();
        expect(await otherRow.locator(".chat-subagents__activity").textContent()).not.toBe("");
        expect(await row.locator("svg").count()).toBe(1);
        if (capture) {
          await page.screenshot({ path: path.join(suite.artifactDir, "subagent-list.png") });
        }

        await row.getByRole("button", { name: child.label, exact: true }).click();
        const detail = panel.locator(".chat-subagent-detail");
        await detail.getByText("Inspecting the notice component.", { exact: true }).waitFor();
        expect(await detail.locator("textarea").count()).toBe(0);
        expect(await detail.locator(".agent-chat__disabled-banner").count()).toBe(0);
        expect(
          await detail.locator(".chat-subagent-detail__header openclaw-elapsed-time").count(),
        ).toBe(0);
        expect(await detail.getByRole("button", { name: "Open parent session" }).count()).toBe(0);
        expect(await draft.inputValue()).toBe("Keep this parent draft");
        expect(await page.locator("html").getAttribute("data-subagent-claimed-input")).toBeNull();
        if (capture) {
          await page.screenshot({
            path: path.join(suite.artifactDir, "subagent-panel-detail.png"),
          });
        }
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
        await otherRow.getByRole("button", { name: `Stop ${other.label}`, exact: true }).click();
        await expect.poll(async () => (await gateway.getRequests("sessions.abort")).length).toBe(1);
        expect((await gateway.getRequests("sessions.abort"))[0]?.params).toMatchObject({
          key: other.key,
          agentId: "main",
          runId: "keyboard-run",
        });
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
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
          .getByRole("button", { name: child.label, exact: true })
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
          await page.evaluate(() => history.pushState(null, "", "/agents"));
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
          expect(new URL(page.url()).pathname).toBe("/agents");
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
          if (capture) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `subagent-standalone-${width}.png`),
            });
          }
          expect(await pane.locator(".agent-chat__composer-combobox textarea").count()).toBe(0);
          expect(await pane.locator("openclaw-chat-outbox-recovery").count()).toBe(0);
          await pane.getByRole("button", { name: "Stop generating", exact: true }).waitFor();
          expect(
            await notice.getByRole("button", { name: "Stop generating", exact: true }).count(),
          ).toBe(0);
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
