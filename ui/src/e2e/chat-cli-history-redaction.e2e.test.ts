import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentMessage } from "../../../src/agents/runtime/index.js";
import {
  mergeImportedChatHistoryMessages,
  readClaudeCliSessionMessagesAsync,
} from "../../../src/gateway/cli-session-history.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
  visibleChatBubbleTexts,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

suite.define(() => {
  it("renders a real imported Claude transcript once with its original text", async () => {
    const homeDir = tempDirs.make("openclaw-cli-history-redaction-");
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const cliSessionId = "control-ui-claude-history-redaction";
      const secret = "sk-abcdef1234567890xyz";
      const userText = `CLI user copy ${secret}`;
      const assistantText = `CLI imported-only reply ${secret}`;
      const projectsDir = path.join(homeDir, ".claude", "projects", "control-ui-e2e");
      const filePath = path.join(projectsDir, `${cliSessionId}.jsonl`);
      await fs.mkdir(projectsDir, { recursive: true });
      await fs.writeFile(
        filePath,
        [
          ["user", "user-copy", "54", userText],
          ["assistant", "imported-assistant", "55", assistantText],
        ]
          .map(([role, suffix, second, content]) => ({
            type: role,
            uuid: `control-ui-claude-${suffix}`,
            timestamp: `2026-03-26T16:29:${second}.800Z`,
            message: { role, content },
          }))
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
        "utf-8",
      );

      const localUserMessage = {
        role: "user",
        content: userText,
        timestamp: Date.parse("2026-03-26T16:29:54.800Z"),
      } as AgentMessage;
      const mergedMessages = mergeImportedChatHistoryMessages({
        localMessages: [localUserMessage],
        importedMessages: await readClaudeCliSessionMessagesAsync({ cliSessionId, homeDir }),
      });

      expect(mergedMessages).toHaveLength(2);
      expect(mergedMessages[0]).toEqual({
        ...localUserMessage,
        __openclaw: {
          cliSessionId,
          externalId: "control-ui-claude-user-copy",
          importedFrom: "claude-cli",
        },
      });
      expect(requireRecord(requireRecord(mergedMessages[1])["__openclaw"])).toMatchObject({
        cliSessionId,
        externalId: "control-ui-claude-imported-assistant",
        importedFrom: "claude-cli",
      });
      expect(JSON.stringify(mergedMessages)).toContain(secret);
      expect(await fs.readFile(filePath, "utf-8")).toContain(secret);

      const gateway = await installMockGateway(page, {
        historyMessages: mergedMessages,
        methodResponses: { "sessions.list": chatSessionListResponse() },
        sessionKey: "agent:main:session-a",
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
      await waitForRequests(gateway, "sessions.messages.subscribe", 1);
      const thread = page.locator(".chat-thread");
      const prefixes = ["CLI user copy", "CLI imported-only reply"];
      for (const prefix of prefixes) {
        await thread.getByText(prefix, { exact: false }).waitFor({ timeout: 10_000 });
      }
      const visibleMessages = await visibleChatBubbleTexts(page);
      for (const prefix of prefixes) {
        expect(visibleMessages.filter((message) => message.includes(prefix))).toHaveLength(1);
      }
      expect(await thread.textContent()).toContain(secret);
    });
  });

  it("preserves tool source in Activity while bounding the visible preview", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        const command = "app.api.key=synthetic-source-value-1234567890";
        const source = [
          "API_TOKEN = computeToken()",
          command,
          "spring.datasource.password=synthetic-db-value-1234567890",
          "Read output continues here.\n".repeat(100),
        ].join("\n");
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [{ key: sessionKey, kind: "direct", hasActiveRun: true, status: "running" }],
        });
        await page.goto(`${suite.server.baseUrl}activity?view=live`);
        await page.locator(".activity-empty").waitFor();
        await gateway.waitForRequest("sessions.messages.subscribe", { match: { key: sessionKey } });
        await gateway.emitGatewayEvent("agent", {
          runId: "synthetic-source-run",
          seq: 1,
          stream: "tool",
          ts: 1_700_000_000_000,
          sessionKey,
          data: {
            phase: "result",
            name: "read",
            toolCallId: "synthetic-read",
            result: { content: [{ type: "text", text: source }] },
          },
        });
        const entry = page.locator(".activity-entry").filter({ hasText: "read" });
        await entry.locator("summary").click();
        const preview = entry.locator(".activity-entry__preview");
        const note = entry.locator(".activity-entry__note");
        await preview.waitFor();
        await note.waitFor();
        const visible = await preview.textContent();
        expect(visible).toContain("API_TOKEN = computeToken()");
        expect(visible).toContain(command);
        expect(visible).toContain("spring.datasource.password=synthetic-db-value-1234567890");
        expect(visible!.length).toBeLessThan(source.length);
        expect(await note.textContent()).toBe("Preview truncated.");
      },
    );
  });
});
