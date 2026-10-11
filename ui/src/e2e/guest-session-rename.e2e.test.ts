import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Guest session rename publication" });
const viewport = { width: 1280, height: 900 };
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("reconciles an owned label during a run and preserves scoped UI rename identity", async () => {
    const artifactDir = capture
      ? createControlUiE2eArtifactDir(
          "guest-session-rename",
          path.resolve(".artifacts/ui-visual-proof/guest-session-rename"),
        )
      : undefined;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      colorScheme: "dark",
      serviceWorkers: "block",
      viewport,
      ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
    });
    const page = await context.newPage();
    const video = page.video();
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
      mainSessionKey: "agent:main:main",
      sessions: [own, foreign],
      agentModel: "openai/gpt-5.5",
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
    const stream = pane.getByText("Reviewing the project notes.", { exact: true });
    const observe = () =>
      pane.evaluate((element) => {
        const state = (element as HTMLElement & { state: ChatPageHost }).state;
        const row = state.sessionsResult?.sessions.find(
          (candidate) => candidate.key === state.sessionKey,
        );
        return {
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
    const screenshot = async (name: string) => {
      if (artifactDir) {
        await writeFile(
          path.join(artifactDir, name),
          await takeControlUiViewportScreenshot(page, pane, [title, ownRow, history, stream]),
        );
      }
    };
    const cue = async (text: string) => {
      if (artifactDir) {
        await page.evaluate((message) => {
          let caption = document.getElementById("guest-rename-proof-cue");
          if (!caption) {
            caption = document.createElement("aside");
            caption.id = "guest-rename-proof-cue";
            caption.style.cssText =
              "position:fixed;right:16px;top:76px;z-index:10000;padding:8px 12px;" +
              "background:#162230;color:#fff;border:1px solid #a8c8e8;font:14px sans-serif;" +
              "pointer-events:none;max-width:320px";
            document.body.append(caption);
          }
          caption.textContent = message;
        }, text);
      }
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
      const originalUrl = page.url();
      await screenshot("before-label-publication.png");

      // Replay the committed Gateway row, not model/tool execution or a second rename backend.
      const renamed = {
        ...own,
        label: "Project summary",
        displayName: "Project summary",
        updatedAt: now + 1,
      };
      await cue("UI fixture: Gateway publishes ‘Project summary’");
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
      expect(page.url()).toBe(originalUrl);
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      await page.locator("#guest-rename-proof-cue").evaluateAll((elements) => {
        elements.forEach((element) => element.remove());
      });
      await screenshot("after-label-publication.png");

      await page.reload();
      await expectName(renamed.label);
      expect(await observe()).toEqual(original);
      expect(page.url()).toBe(originalUrl);
      await screenshot("after-reload.png");

      await cue("Header rename: Enter saves the edited title");
      await title.click();
      const headerInput = pane.locator(".chat-pane__session-title-input");
      await headerInput.fill("Header title");
      await headerInput.press("Enter");
      await expectName("Header title");
      const headerPatch = await gateway.waitForRequest("sessions.patch");
      expect(headerPatch.params).toEqual({
        key: own.key,
        agentId: "main",
        label: "Header title",
        expectedSessionId: own.sessionId,
      });

      await cue("Sidebar rename: Save applies the edited title");
      await ownRow.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
      const dialog = page.locator('openclaw-modal-dialog[label="Rename session"]');
      await dialog.locator("input").fill("Sidebar title");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expectName("Sidebar title");
      const sidebarPatch = await gateway.waitForRequest("sessions.patch", { after: 1 });
      expect(sidebarPatch.params).toEqual({
        key: own.key,
        agentId: "main",
        label: "Sidebar title",
        expectedSessionId: own.sessionId,
      });
      expect(await observe()).toEqual(original);

      await cue("Read-only shared session: Rename stays unavailable");
      // All exposes the authorized shared row, not permission to rename it.
      await page
        .locator(".sidebar-navigation-scope")
        .getByRole("button", { name: "All", exact: true })
        .click();
      await foreignRow.click({ button: "right" });
      const foreignRename = page.locator('openclaw-session-menu wa-dropdown-item[value="rename"]');
      await foreignRename.waitFor();
      expect(await foreignRename.getAttribute("disabled")).not.toBeNull();
      await page.keyboard.press("Escape");
      expect(await foreignRow.textContent()).toContain("Shared reference");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
      expect(await gateway.getRequests("chat.abort")).toEqual([]);
      expect(await gateway.getRequests("sessions.abort")).toEqual([]);
    } finally {
      await suite.closeBrowserContext(context);
      if (artifactDir && video) {
        await video.saveAs(path.join(artifactDir, "guest-session-rename.webm"));
      }
    }
  });
});
