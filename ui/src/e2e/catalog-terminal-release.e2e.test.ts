import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { resumableClaudeCatalog } from "./claude-sessions.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "native catalog terminal release",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

async function expandCodingSection(page: Page) {
  const toggle = page.locator('[data-session-section="work"] .sidebar-session-group-toggle');
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('[data-session-section="work"]') ??
        document.querySelector('[data-session-section^="catalog:"]'),
      ),
    undefined,
    { timeout: 30_000 },
  );
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
}

suite.define(() => {
  it("reconciles a retained catalog pane after its terminal writer exits", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1440, height: 900 } });
    const staleCatalog = resumableClaudeCatalog();
    const staleSession = staleCatalog.catalogs.at(0)?.hosts.at(0)?.sessions.at(0);
    if (!staleSession) {
      throw new Error("expected the Claude catalog fixture to include one native session");
    }
    staleSession.canContinue = false;
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.catalog.list",
        "sessions.catalog.read",
        "terminal.open",
      ],
      methodResponses: {
        "sessions.catalog.list": staleCatalog,
        "sessions.catalog.read": {
          hostId: "gateway:local",
          threadId: "claude-terminal-session",
          items: [
            { id: "answer-1", type: "agentMessage", text: "Answer before terminal exit" },
            { id: "question-1", type: "userMessage", text: "Original native question" },
          ],
        },
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "claude-terminal-release",
          shell: "/bin/zsh",
          title: "claude --resume claude-terminal-session",
        },
      },
      terminalEnabled: true,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.evaluate(() => {
        const releases: unknown[] = [];
        Object.assign(window, { catalogTerminalReleaseProof: releases });
        document.addEventListener("openclaw-session-catalog-released", (event) => {
          releases.push((event as CustomEvent).detail);
        });
      });
      await expandCodingSection(page);
      const row = page.locator('[data-catalog-session-key^="catalog:"]').filter({
        hasText: "Native Claude terminal",
      });
      await row.click();
      const pane = page
        .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
        .filter({ hasText: "Answer before terminal exit" });
      await pane.getByText("Answer before terminal exit", { exact: true }).waitFor();
      const composer = pane.locator(".agent-chat__composer-combobox > textarea");
      await expect.poll(() => composer.isDisabled()).toBe(true);

      await pane.evaluate((element) => {
        const host = element as HTMLElement & {
          catalogMessages: unknown[];
          requestUpdate(): void;
        };
        host.catalogMessages = [
          {
            role: "assistant",
            content: [{ type: "text", text: "Retained older native answer" }],
            messageId: "answer-older",
          },
          ...host.catalogMessages,
        ];
        host.requestUpdate();
      });
      await pane.getByText("Retained older native answer", { exact: true }).waitFor();

      await row.click({ button: "right", force: true });
      await page.locator('wa-dropdown-item[value="terminal"]').click({ force: true });
      await gateway.waitForRequest("terminal.open");
      await page.locator(".tabstrip-tab.is-connecting").waitFor();
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "claude-terminal-release",
        seq: 1,
        data: "Claude Code ready\r\n",
      });
      await expect.poll(() => page.locator(".tabstrip-tab.is-live").count()).toBe(1);

      expect(
        await pane.evaluate((element) => {
          const host = element as HTMLElement & {
            selected: boolean;
            presented: boolean;
            sessionKey: string;
            catalogSession: { sourceHomeId?: string } | null;
            state?: {
              assistantAgentId?: string;
              connected?: boolean;
              client?: unknown;
            };
          };
          return {
            assistantAgentId: host.state?.assistantAgentId,
            catalogSourceHomeId: host.catalogSession?.sourceHomeId,
            connected: host.state?.connected,
            hasClient: Boolean(host.state?.client),
            presented: host.presented,
            selected: host.selected,
            sessionKey: host.sessionKey,
          };
        }),
      ).toEqual({
        assistantAgentId: "main",
        catalogSourceHomeId: undefined,
        connected: true,
        hasClient: true,
        presented: false,
        selected: false,
        sessionKey: "agent:main:catalog:claude:gateway%3Alocal:claude-terminal-session",
      });

      const listedBeforeExit = (await gateway.getRequests("sessions.catalog.list")).length;
      await gateway.setMethodResponse("sessions.catalog.list", resumableClaudeCatalog());
      await gateway.setMethodResponse("sessions.catalog.read", {
        hostId: "gateway:local",
        threadId: "claude-terminal-session",
        items: [
          { id: "answer-2", type: "agentMessage", text: "Final answer from terminal" },
          { id: "answer-1", type: "agentMessage", text: "Answer before terminal exit" },
          { id: "question-1", type: "userMessage", text: "Original native question" },
          { id: "answer-older", type: "agentMessage", text: "Retained older native answer" },
        ],
      });
      await gateway.emitGatewayEvent("terminal.exit", {
        sessionId: "claude-terminal-release",
        reason: "process_exit",
        exitCode: 0,
      });

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { catalogTerminalReleaseProof?: unknown[] })
                .catalogTerminalReleaseProof,
          ),
        )
        .toEqual([
          {
            agentId: "main",
            catalogId: "claude",
            hostId: "gateway:local",
            threadId: "claude-terminal-session",
          },
        ]);
      await expect
        .poll(() => gateway.getRequests("sessions.catalog.list").then((rows) => rows.length))
        .toBe(listedBeforeExit + 1);
      expect(await pane.getByText("Final answer from terminal", { exact: true }).count()).toBe(1);
      expect(await page.locator(".tabstrip-tab.is-exited").count()).toBe(1);
      await row.click();
      await pane.getByText("Final answer from terminal", { exact: true }).waitFor();
      expect(await pane.getByText("Retained older native answer", { exact: true }).count()).toBe(1);
      expect(await pane.getByText("Answer before terminal exit", { exact: true }).count()).toBe(1);
      await expect.poll(() => composer.isEnabled()).toBe(true);
    } finally {
      await page.close();
    }
  });
});
