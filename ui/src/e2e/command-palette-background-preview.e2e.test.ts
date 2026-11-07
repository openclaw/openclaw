import { expect, it } from "vitest";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { foregroundKey, openFromForeground, scenario } from "./command-palette.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { controlUiSessionPath, installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette background start preview" });

suite.define(() => {
  it("shows a starting session's prompt before the Gateway answers and retries it in place", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, scenario());
      const { palette, input } = await openFromForeground(page, suite.server.baseUrl);
      const prompt = "Fix the weird timing for automations.\nThen land the PR.";
      await input.fill(prompt);
      const start = palette.getByRole("button", {
        name: "Start new session in background",
        exact: true,
      });
      await expect.poll(() => start.isEnabled()).toBe(true);
      await gateway.deferNext("sessions.create");
      await input.press("ControlOrMeta+Enter");
      const create = await gateway.waitForRequest("sessions.create");
      const { key: requestedKey } = create.params as { key?: unknown };
      const key = typeof requestedKey === "string" ? requestedKey : "";
      expect(key).toMatch(/^agent:main:dashboard:[\da-f-]{36}$/u);
      await input.waitFor({ state: "hidden" });

      // The Gateway commits the untitled row before it answers; open it from the sidebar.
      const row = {
        ...createControlUiSessionRow(key, "", Date.now()),
        displayName: undefined,
        label: undefined,
      };
      await gateway.setSessionsListResponse({
        sessions: [
          createControlUiSessionRow(foregroundKey, "Foreground planning", Date.now() - 60_000),
          row,
        ],
      });
      await page.evaluate((session) => {
        type MockGatewayWindow = Window & {
          openclawControlUiE2eGateway?: { emit: (event: string, payload: unknown) => void };
        };
        (window as MockGatewayWindow).openclawControlUiE2eGateway?.emit("sessions.changed", {
          sessionKey: session.key,
          reason: "create",
          ts: session.updatedAt,
          session,
        });
      }, row);
      const sidebarRow = page.locator(`.sidebar-recent-session[data-session-key="${key}"] a`);
      await sidebarRow.waitFor({ state: "visible" });
      await sidebarRow.click();
      const preview = page.locator("openclaw-pending-session-create");
      await preview.waitFor({ state: "visible" });
      const bubble = preview.locator(".chat-group.user .chat-bubble");
      await expect
        .poll(() => bubble.textContent())
        .toContain("Fix the weird timing for automations.");
      const indicator = preview.locator(".chat-thread-inner .chat-working-indicator");
      await expect.poll(() => indicator.textContent()).toContain("Starting…");
      await expect.poll(() => indicator.textContent()).toMatch(/\d+s/u);
      expect(await preview.locator(".chat-pane__session-title").first().textContent()).toBe(
        "New session",
      );

      await gateway.rejectDeferred("sessions.create", {
        code: "UNAVAILABLE",
        message: "Fixture refused this start",
      });
      await expect.poll(() => preview.textContent()).toContain("Fixture refused this start");
      expect(await bubble.textContent()).toContain("Fix the weird timing for automations.");
      const tryAgain = preview.getByRole("button", { name: "Try again", exact: true });
      await tryAgain.waitFor({ state: "visible" });
      await gateway.deferNext("sessions.create");
      await tryAgain.click();
      const retry = await gateway.waitForRequest("sessions.create", { after: 1 });
      expect(retry.params).toMatchObject({ key, message: prompt });
      await expect.poll(() => preview.textContent()).not.toContain("Fixture refused this start");
      await expect.poll(() => indicator.textContent()).toContain("Starting…");

      await gateway.resolveDeferred("sessions.create", {
        key,
        entry: { sessionId: "session:" + key },
        runStarted: true,
        runId: "preview-run",
      });
      // The same route mounts the real conversation with the accepted prompt.
      await expect.poll(() => preview.count()).toBe(0);
      const conversation = page.locator(".chat-thread .chat-group.user");
      await expect
        .poll(() => conversation.first().textContent())
        .toContain("Fix the weird timing for automations.");
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(key));
      expect(await gateway.getRequests("sessions.create")).toHaveLength(2);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
    });
  });
});
