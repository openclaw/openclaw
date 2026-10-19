import { assert, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails } from "./chat-details.test-support.ts";
import { newChatPage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat header and delegated work",
  trackBrowserContexts: true,
});

suite.define(() => {
  it("keeps new batches collapsed and retains the manually opened panel across layouts", async () => {
    const page = await newChatPage(suite, {
      locale: "en-US",
      colorScheme: "dark",
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    });
    const now = 1_800_000_000_000;
    await page.clock.setFixedTime(now);
    await page.addInitScript(
      (key) => localStorage.setItem(key, JSON.stringify({ themeMode: "dark" })),
      controlUiBundledSettingsStorageKey(suite.server.baseUrl),
    );
    const parent = {
      key: "agent:main:delegation-parent",
      sessionId: "delegation-parent",
      kind: "direct",
      sharingRole: "owner",
      label: "Review the backend",
      status: "done",
      hasActiveRun: false,
      hasActiveSubagentRun: false,
      activeRunIds: [],
      updatedAt: now - 5_000,
    } satisfies GatewaySessionRow;
    const next = {
      ...parent,
      key: "agent:main:next-conversation",
      sessionId: "next-conversation",
      label: "Another conversation",
    } satisfies GatewaySessionRow;
    const history = [
      {
        role: "assistant",
        content: "Ready for delegated work.",
        timestamp: now - 5_000,
        __openclaw: { id: "ready", seq: 1 },
      },
    ];
    const gateway = await installMockGateway(page, {
      sessionKey: parent.key,
      sessions: [parent, next],
      historyMessages: history,
      featureMethods: [
        ...defaultControlUiFeatureMethods,
        "session.visibility.set",
        "session.members.listEvidence",
      ],
    });
    const at = (row: GatewaySessionRow, offset: number, changes: Partial<GatewaySessionRow>) => ({
      ...row,
      ...changes,
      updatedAt: now + offset,
      snapshotAt: now + offset,
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
    const activePane = page.locator(".chat-pane-cache__pane--active");
    const panel = activePane.locator("openclaw-chat-subagents-panel");
    const waitLine = activePane.locator(".agent-chat__composer-run-status--waiting");
    await activePane.getByText("Ready for delegated work.", { exact: true }).waitFor();
    expect(await panel.isVisible()).toBe(false);
    expect(await activePane.locator(".chat-pane__actions").getByRole("button").count()).toBe(3);

    const details = activePane.locator(".chat-pane__header-trailing > openclaw-chat-details");
    const detailsDialog = activePane.getByRole("dialog", { name: "Details", exact: true });
    await details.getByRole("button", { name: "Details", exact: true }).click();
    await detailsDialog.waitFor();
    expect(
      await activePane.locator(".chat-main__conversation-frame > openclaw-chat-details").count(),
    ).toBe(0);
    await closeChatDetails(activePane);
    await detailsDialog.waitFor({ state: "hidden" });

    const prompt = "Review the backend in a subagent.";
    await activePane.locator(".agent-chat__composer-combobox textarea").fill(prompt);
    await activePane.getByRole("button", { name: "Send message", exact: true }).click();
    const send = await gateway.waitForRequest("chat.send");
    assert(send.params && typeof send.params === "object" && "idempotencyKey" in send.params);
    const runId = send.params.idempotencyKey;
    assert(typeof runId === "string");
    const runningParent = at(parent, 1, {
      status: "running",
      hasActiveRun: true,
      hasActiveSubagentRun: true,
      activeRunIds: [runId],
      startedAt: now,
      childSessions: ["agent:main:subagent:backend-review"],
    });
    const child = at(
      {
        key: "agent:main:subagent:backend-review",
        sessionId: "backend-review",
        kind: "direct",
        classification: "subagent",
        label: "Backend review",
        spawnedBy: parent.key,
        parentSessionKey: parent.key,
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["backend-run"],
        startedAt: now,
      },
      1,
      {},
    );
    await gateway.setSessionsListResponse(sessionsListResponse([runningParent, child, next]));
    await gateway.emitGatewayEvent("sessions.changed", {
      sessionKey: child.key,
      reason: "run-start",
      ts: child.updatedAt,
      session: child,
      ancestorSessions: [runningParent],
    });
    const runningCount = activePane.locator(".chat-pane__subagents-running");
    await runningCount.waitFor();
    expect(await panel.isVisible()).toBe(false);
    await selectChatLayoutAction(activePane, "Subagents");
    const panelRow = panel.locator(`[data-session-key="${child.key}"]`);
    await panelRow.getByText("Backend review", { exact: true }).waitFor();
    expect(await activePane.locator(".chat-pane__subagents-running").textContent()).toContain(
      "1 running",
    );
    expect(await waitLine.isVisible()).toBe(false);
    const mountedPanel = await panel.elementHandle();
    await selectChatLayoutAction(activePane, "Expand Subagents");
    await activePane.locator(".sidebar-region--expanded-side").waitFor();
    await selectChatLayoutAction(activePane, "Restore split");
    await activePane.locator(".sidebar-region--expanded-side").waitFor({ state: "hidden" });
    expect(await mountedPanel?.evaluate((element) => element.isConnected)).toBe(true);
    await selectChatLayoutAction(activePane, "Expand Subagents");
    const activeSubagentsTab = activePane.locator(
      '[data-region-header="side"] .tabstrip-tab[aria-selected="true"]',
    );
    await activeSubagentsTab.focus();
    await page.keyboard.press("Enter");
    await activePane.locator(".sidebar-region--expanded-side").waitFor({ state: "hidden" });
    expect(await mountedPanel?.evaluate((element) => element.isConnected)).toBe(true);
    await mountedPanel?.dispose();
    await activePane.getByRole("button", { name: "Close Subagents", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    await selectChatLayoutAction(activePane, "Subagents");
    await panelRow.waitFor();

    expect(await panel.isVisible()).toBe(true);
    await activePane.getByRole("button", { name: "Close Subagents", exact: true }).click();
    await panel.waitFor({ state: "hidden" });

    await gateway.setMethodResponse("chat.history", {
      messages: [{ role: "assistant", content: "A separate conversation.", timestamp: now }],
      sessionId: next.sessionId,
      sessionInfo: next,
      inFlightRun: null,
    });
    await navigateToControlUiSession(page, next.key);
    await activePane.getByText("A separate conversation.", { exact: true }).waitFor();
    expect(await panel.isVisible()).toBe(false);
    expect(await activePane.locator(".agent-chat__composer-run-status").isVisible()).toBe(false);
  });
});
