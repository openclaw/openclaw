import { expect, it } from "vitest";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Guest session rename publication" });

suite.define(() => {
  it("reconciles an owned label during a run and preserves scoped UI rename identity", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      colorScheme: "dark",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const now = Date.now();
    const actor = { type: "human", id: "guest-writer", label: "Guest writer" } as const;
    const own = createControlUiSessionRow("agent:main:guest-report", "Project draft", now, {
      sessionId: "guest-report-session",
      createdActor: actor,
      owner: { actor, assignedBy: actor, assignedAt: now },
      sharingRole: "owner",
      visibility: "shared",
      permissionMode: "workspace",
      spawnedWorkspaceDir: "/workspace/project",
      activeRunIds: ["guest-report-run"],
      hasActiveRun: true,
      status: "running",
    });
    const foreign = createControlUiSessionRow(
      "agent:main:shared-reference",
      "Shared reference",
      now - 1_000,
      { sharingRole: "viewer", visibility: "read-only" },
    );
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.sessions.write"],
      sessionKey: own.key,
      sessions: [own, foreign],
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
      presenceUsers: [
        {
          self: true,
          id: actor.id,
          identity: { type: "profile", id: actor.id },
          name: actor.label,
        },
      ],
      historyMessages: [
        { role: "user", content: "Prepare a project summary." },
        { role: "assistant", content: "The project outline is ready." },
      ],
      inFlightRun: { runId: "guest-report-run", text: "Reviewing the project notes." },
    });
    const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
    const title = pane.locator(".chat-pane__session-title-button");
    const ownRow = page.locator(`.sidebar-recent-session[data-session-key="${own.key}"]`);
    const foreignRow = page.locator(`.sidebar-recent-session[data-session-key="${foreign.key}"]`);
    const history = pane.getByText("The project outline is ready.", { exact: true });
    const stream = pane
      .getByRole("paragraph")
      .filter({ hasText: /^Reviewing the project notes\.$/ });
    const observe = () =>
      pane.evaluate((element) => {
        const state = (element as HTMLElement & { state: ChatPageHost }).state;
        const row = state.sessionsResult?.sessions.find(
          (candidate) => candidate.key === state.sessionKey,
        );
        return {
          url: location.href,
          key: state.sessionKey,
          sessionId: row?.sessionId,
          runId: state.chatRunId,
          activeRunIds: row?.activeRunIds,
          hasActiveRun: row?.hasActiveRun,
          model: row?.model,
          permissionMode: row?.permissionMode,
          workspace: row?.spawnedWorkspaceDir,
          createdActor: row?.createdActor,
          owner: row?.owner,
          sharingRole: row?.sharingRole,
          visibility: row?.visibility,
          messages: state.chatMessages,
        };
      });
    const expectName = async (name: string) => {
      await expect.poll(() => title.textContent()).toContain(name);
      await expect.poll(() => ownRow.textContent()).toContain(name);
      await history.waitFor();
      await stream.waitFor();
      await ownRow.getByRole("img", { name: "Active run", exact: true }).waitFor();
    };
    const expectPatch = async (label: string, after = 0) => {
      const patch = await gateway.waitForRequest("sessions.patch", { after });
      expect(patch.params).toEqual({
        key: own.key,
        agentId: "main",
        label,
        expectedSessionId: own.sessionId,
      });
    };
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, own.key));
      await expectName(own.label);
      const original = await observe();
      expect(original).toMatchObject({
        key: own.key,
        sessionId: "guest-report-session",
        runId: "guest-report-run",
        activeRunIds: ["guest-report-run"],
        hasActiveRun: true,
        model: "gpt-5.5",
        permissionMode: "workspace",
        workspace: "/workspace/project",
        sharingRole: "owner",
      });

      // Replay the committed Gateway row, not model/tool execution or a second rename backend.
      const renamed = {
        ...own,
        label: "Project summary",
        displayName: "Project summary",
        updatedAt: now + 1,
      };
      await gateway.setSessionsListResponse({ sessions: [renamed, foreign] });
      await gateway.emitGatewayEvent("sessions.changed", {
        key: own.key,
        sessionKey: own.key,
        agentId: "main",
        reason: "patch",
        session: renamed,
        ancestorSessions: [],
      });
      await expectName(renamed.label);
      expect(await observe()).toEqual(original);
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);

      await page.reload();
      await expectName(renamed.label);
      expect(await observe()).toEqual(original);

      await title.click();
      const headerInput = pane.locator(".chat-pane__session-title-input");
      await headerInput.fill("Header title");
      await headerInput.press("Enter");
      await expectName("Header title");
      await expectPatch("Header title");

      await ownRow.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
      const dialog = page.locator('openclaw-modal-dialog[label="Rename session"]');
      await dialog.locator("input").fill("Sidebar title");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expectName("Sidebar title");
      await expectPatch("Sidebar title", 1);
      expect(await observe()).toEqual(original);

      await foreignRow.click({ button: "right" });
      const foreignRename = page
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Rename…", exact: true });
      await foreignRename.waitFor();
      expect(await foreignRename.isDisabled()).toBe(true);
      await page.keyboard.press("Escape");
      expect(await foreignRow.textContent()).toContain("Shared reference");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
      expect(await gateway.getRequests("chat.abort")).toEqual([]);
      expect(await gateway.getRequests("sessions.abort")).toEqual([]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
