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
      await warning.getByRole("button", { name: "Restore", exact: true }).click();
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

  it.each(["snapshot", "fresh"] as const)(
    "requires explicit %s restoration before sending",
    (restore) =>
      suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const removed = { ...session, worktreeState: `removed-${restore}` };
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
          methodResponses: { "sessions.list": chatSessionListResponse([removed]) },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Continue the garden layout.");
        const warning = page.locator(".agent-chat__workspace-removed");
        await expect
          .poll(() => warning.textContent())
          .toContain("This conversation’s workspace was removed.");
        const send = page.locator(".chat-send-btn--send");
        await expect.poll(() => send.isDisabled()).toBe(true);
        expect(await send.getAttribute("aria-label")).toContain("workspace was removed");
        await composer.press("Enter");
        const draft = await composer.inputValue();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("worktrees.restore")).toHaveLength(0);
        const button = warning.getByRole("button", {
          name: restore === "fresh" ? "Restore fresh checkout" : "Restore",
          exact: true,
        });
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".chat-footer"),
          [composer, warning, button],
          { elements: [warning], animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, `${restore}-removed.png`), frame.png);
        await button.click();
        const request = await gateway.waitForRequest("worktrees.restore");
        expect(request.params).toEqual({ id: session.worktree.id });
        await expect.poll(() => warning.textContent()).toContain("Restoring workspace…");
        expect(await send.isDisabled()).toBe(true);
        if (restore === "snapshot") {
          await gateway.rejectDeferred("worktrees.restore", {
            code: "UNAVAILABLE",
            message:
              "Workspace restore failed (conflict). Close the conflicting checkout, then retry Restore.",
            details: { restoreReason: "conflict" },
          });
          await expect.poll(() => warning.getByRole("alert").textContent()).toContain("conflict");
          expect(await send.isDisabled()).toBe(true);
          await button.click();
          await expect
            .poll(async () => (await gateway.getRequests("worktrees.restore")).length)
            .toBe(2);
        }
        const ready = { ...session, updatedAt: 2, worktreeState: "ready" };
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
        await expect.poll(() => send.isEnabled()).toBe(true);
        expect(await composer.inputValue()).toBe(draft);
        await send.click();
        await gateway.waitForRequest("chat.send");
        expect(await gateway.getRequests("worktrees.list")).toHaveLength(0);
      }),
  );
});
