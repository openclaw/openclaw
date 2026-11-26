import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage, chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Conversation workspace restore" });
const session = {
  key: "agent:main:main",
  sessionId: "synthetic-garden",
  kind: "direct",
  label: "Garden layout",
  updatedAt: 1,
  worktree: { id: "garden-workspace", branch: "openclaw/garden", repoRoot: "/synthetic/garden" },
};
suite.define(() => {
  it("offers explicit restore before unarchiving a removed workspace", () =>
    suite.withPage({}, async ({ page }) => {
      const archived = {
        ...session,
        archived: true,
        archivedAt: 1,
        worktreeState: "removed-snapshot",
      };
      const gateway = await installMockGateway(page, {
        sessionKey: session.key,
        sessions: [archived],
        deferredMethods: ["worktrees.restore"],
        methodResponses: {
          "chat.startup": { sessionId: session.sessionId, sessionInfo: archived, messages: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const warning = page.locator(".agent-chat__workspace-removed");
      await warning.waitFor();
      expect(await gateway.getRequests("worktrees.restore")).toHaveLength(0);
      expect(await page.locator(".chat-send-btn--send").count()).toBe(0);
      await warning.getByRole("button", { name: "Restore workspace", exact: true }).click();
      await gateway.waitForRequest("worktrees.restore");
      const ready = { ...archived, updatedAt: 2, worktreeState: "ready" };
      await gateway.setSessionsListResponse(chatSessionListResponse([ready]));
      await gateway.resolveDeferred("worktrees.restore", { id: session.worktree.id });
      await gateway.emitGatewayEvent("sessions.changed", {
        reason: "workspace",
        sessionKey: session.key,
        sessionId: session.sessionId,
        session: ready,
        updatedAt: 2,
      });
      await warning.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Unarchive", exact: true }).waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    }));

  it.each(["owner", "member"] as const)(
    "shows Restore to a non-admin %s only when they started the conversation",
    (sharingRole) =>
      suite.withPage({}, async ({ page }) => {
        const removed = { ...session, sharingRole, worktreeState: "removed-snapshot" };
        const gateway = await installMockGateway(page, {
          sessionKey: session.key,
          sessions: [removed],
          operatorScopes: ["operator.read", "operator.sessions.write"],
          methodResponses: {
            "chat.startup": { sessionId: session.sessionId, sessionInfo: removed, messages: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const warning = page.locator(".agent-chat__workspace-removed");
        await warning.waitFor();
        await writeFile(
          path.join(suite.artifactDir, `restore-${sharingRole}.png`),
          await warning.screenshot(),
        );
        const button = warning.getByRole("button", { name: "Restore workspace", exact: true });
        if (sharingRole === "member") {
          expect(await button.count()).toBe(0);
          expect(await warning.textContent()).toContain(
            "Ask an administrator to restore this workspace, or start a new conversation.",
          );
          return;
        }
        await button.click();
        expect((await gateway.waitForRequest("worktrees.restore")).params).toEqual({
          id: session.worktree.id,
        });
      }),
  );

  it.each(["snapshot", "fresh"] as const)(
    "requires explicit %s restoration before sending",
    (restore) =>
      suite.withPage(
        { viewport: { width: restore === "snapshot" ? 1280 : 390, height: 900 } },
        async ({ page }) => {
          const removed = { ...session, updatedAt: 2, worktreeState: `removed-${restore}` };
          const gateway = await installMockGateway(page, {
            sessionKey: session.key,
            historyMessages: [
              chatMessage("user", "Save the garden layout for later."),
              chatMessage("assistant", "The layout is saved in this workspace."),
            ],
            deferredMethods:
              restore === "snapshot"
                ? ["worktrees.restore", "worktrees.restore"]
                : ["worktrees.restore"],
            methodResponses: { "sessions.list": chatSessionListResponse([session]) },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          const draft = "Continue the garden layout.";
          await composer.fill(draft);
          await gateway.setSessionsListResponse(chatSessionListResponse([removed]));
          await gateway.emitGatewayEvent("sessions.changed", {
            reason: "workspace",
            sessionKey: session.key,
            sessionId: session.sessionId,
            session: removed,
            updatedAt: 2,
          });
          const warning = page.locator(".agent-chat__workspace-removed");
          await warning.waitFor();
          expect(await composer.count()).toBe(0);
          const send = page.locator(".chat-send-btn--send");
          expect(await send.count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          expect(await gateway.getRequests("worktrees.restore")).toHaveLength(0);
          const button = warning.getByRole("button", {
            name: restore === "fresh" ? "Restore fresh checkout" : "Restore workspace",
            exact: true,
          });
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".chat-footer"),
            [warning, button],
            { elements: [warning], animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, `${restore}-removed.png`), frame.png);
          await button.click();
          const request = await gateway.waitForRequest("worktrees.restore");
          expect(request.params).toEqual({ id: session.worktree.id });
          await expect.poll(() => warning.textContent()).toContain("Restoring workspace…");
          expect(await send.count()).toBe(0);
          if (restore === "snapshot") {
            await gateway.rejectDeferred("worktrees.restore", {
              code: "UNAVAILABLE",
              message:
                "Workspace restore failed (conflict). Close the conflicting checkout, then retry Restore.",
              details: { restoreReason: "conflict" },
            });
            await expect.poll(() => warning.getByRole("alert").textContent()).toContain("conflict");
            expect(await send.count()).toBe(0);
            await button.click();
            await expect
              .poll(async () => (await gateway.getRequests("worktrees.restore")).length)
              .toBe(2);
          }
          const ready = { ...session, updatedAt: 3, worktreeState: "ready" };
          await gateway.setSessionsListResponse(chatSessionListResponse([ready]));
          await gateway.resolveDeferred("worktrees.restore", { id: session.worktree.id });
          await gateway.emitGatewayEvent("sessions.changed", {
            reason: "workspace",
            sessionKey: session.key,
            sessionId: session.sessionId,
            session: ready,
            updatedAt: 3,
          });
          await warning.waitFor({ state: "detached" });
          await expect.poll(() => send.isEnabled()).toBe(true);
          expect(await composer.inputValue()).toBe(draft);
          await expect
            .poll(() => composer.evaluate((el) => el === document.activeElement))
            .toBe(true);
          await composer.press("Enter");
          await gateway.waitForRequest("chat.send");
          expect(await gateway.getRequests("worktrees.list")).toHaveLength(0);
        },
      ),
  );
});
