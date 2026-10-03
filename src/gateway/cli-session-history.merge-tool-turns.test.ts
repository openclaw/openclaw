// Joined CLI reply tests protect tool-split Claude CLI turns from rendering
// twice when local chat history merges with the imported native session.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveChatHistoryWithCliSessionImports } from "./cli-session-history.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";
import { requireGatewayRecord } from "./test-helpers.assertions.js";

function readRecord(value: unknown): Record<string, unknown> {
  return requireGatewayRecord(value, "record");
}

async function withClaudeProjectsDir<T>(
  run: (params: { homeDir: string; sessionId: string; filePath: string }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-tool-turns-"));
  const homeDir = path.join(root, "home");
  const sessionId = "7c1f3f0e-2a44-4c55-9e0b-0d6c4b1f9a21";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  await fs.mkdir(projectsDir, { recursive: true });
  try {
    return await withEnvAsync({ HOME: homeDir }, () =>
      run({ homeDir, sessionId, filePath: path.join(projectsDir, `${sessionId}.jsonl`) }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function writeClaudeEntries(filePath: string, entries: readonly Record<string, unknown>[]) {
  return fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf-8");
}

function augmentBoundClaudeHistory(params: {
  homeDir: string;
  sessionId: string;
  localMessages: unknown[];
}) {
  return resolveChatHistoryWithCliSessionImports({
    entry: {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionBindings: { "claude-cli": { sessionId: params.sessionId } },
    },
    provider: "claude-cli",
    localMessages: params.localMessages,
    homeDir: params.homeDir,
  }).messages;
}

describe("cli session history joined tool-turn replies", () => {
  it("drops a local tool-split reply that joins the imported turn segments (#159707)", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const at = (offsetMs: number) => new Date(Date.parse("2026-09-27T14:00:00.000Z") + offsetMs);
      const prompt = (uuid: string, text: string, offsetMs: number) => ({
        type: "user",
        uuid,
        timestamp: at(offsetMs).toISOString(),
        message: { role: "user", content: text },
      });
      const reply = (uuid: string, text: string, offsetMs: number, toolUseId?: string) => ({
        type: "assistant",
        uuid,
        timestamp: at(offsetMs).toISOString(),
        message: {
          id: `msg-${uuid}`,
          role: "assistant",
          model: "claude-opus-5-5",
          content: [
            { type: "text", text },
            ...(toolUseId
              ? [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "true" } }]
              : []),
          ],
        },
      });
      const toolResult = (uuid: string, toolUseId: string, offsetMs: number) => ({
        type: "user",
        uuid,
        timestamp: at(offsetMs).toISOString(),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
        },
      });
      const first = ["Starting X.", "The batch was refused.", "Done: first."];
      const second = ["Checking Y.", "Done: second."];
      await writeClaudeEntries(filePath, [
        prompt("prompt-a", "do a", 1_000),
        reply("a-0", first[0]!, 1_100, "toolu_a0"),
        toolResult("a-0-result", "toolu_a0", 1_200),
        reply("a-1", first[1]!, 1_300, "toolu_a1"),
        toolResult("a-1-result", "toolu_a1", 1_400),
        reply("a-2", first[2]!, 1_500),
        prompt("prompt-b", "do b", 3_000),
        reply("b-0", second[0]!, 3_100, "toolu_b0"),
        toolResult("b-0-result", "toolu_b0", 3_200),
        reply("b-1", second[1]!, 3_300),
      ]);
      const localReply = (text: string, offsetMs: number) => ({
        role: "assistant",
        timestamp: at(offsetMs).getTime(),
        content: [{ type: "text", text }],
      });
      const localMessages = [
        { role: "user", content: "do a", timestamp: at(990).getTime() },
        localReply(first.join("\n\n"), 1_600),
        { role: "user", content: "do b", timestamp: at(2_990).getTime() },
        localReply(second.join("\n\n"), 3_400),
      ];

      const messages = augmentBoundClaudeHistory({
        homeDir,
        sessionId,
        localMessages,
      });

      const assistantTexts = messages
        .map(readRecord)
        .filter((message) => message.role === "assistant")
        .map((message) =>
          (message.content as Array<{ type: string; text?: string }>)
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
        );
      expect(assistantTexts).toEqual([...first, ...second]);
    });
  });

  it.each([
    { name: "a later imported prompt", laterImportedPrompt: true },
    { name: "a later local prompt", laterImportedPrompt: false },
  ])(
    "keeps a same-text local reply outside the imported turn ($name)",
    ({ laterImportedPrompt }) => {
      const meta = (externalId: string) => ({
        __openclaw: { importedFrom: "claude-cli", cliSessionId: "session-1", externalId },
      });
      const importedMessages = [
        { role: "user", content: "first", timestamp: 1_000, ...meta("u1") },
        {
          role: "assistant",
          timestamp: 1_100,
          content: [{ type: "text", text: "One." }],
          ...meta("a1"),
        },
        {
          // The importer coalesces a tool-only row with its result.
          role: "assistant",
          timestamp: 1_200,
          content: [
            { type: "toolcall", id: "t1", name: "exec", arguments: {} },
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
          ],
          ...meta("t1"),
        },
        {
          role: "assistant",
          timestamp: 1_300,
          content: [{ type: "text", text: "Two." }],
          ...meta("a2"),
        },
        ...(laterImportedPrompt
          ? [{ role: "user", content: "second", timestamp: 4_000, ...meta("u2") }]
          : []),
      ];
      const unrelatedReply = {
        role: "assistant",
        timestamp: 5_000,
        content: [{ type: "text", text: "One.\n\nTwo." }],
      };
      const localMessages = [
        ...(laterImportedPrompt ? [] : [{ role: "user", content: "other", timestamp: 4_000 }]),
        unrelatedReply,
      ];

      const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });

      expect(merged).toContain(unrelatedReply);
    },
  );

  it("drops a joined reply when a local notice arrived before the next imported prompt", () => {
    const meta = (externalId: string) => ({
      __openclaw: { importedFrom: "claude-cli", cliSessionId: "session-1", externalId },
    });
    const importedMessages = [
      { role: "user", content: "first", timestamp: 1_000, ...meta("u1") },
      {
        role: "assistant",
        timestamp: 1_100,
        content: [{ type: "text", text: "One." }],
        ...meta("a1"),
      },
      {
        role: "assistant",
        timestamp: 1_300,
        content: [{ type: "text", text: "Two." }],
        ...meta("a2"),
      },
      { role: "user", content: "notice\n\nsecond", timestamp: 4_000, ...meta("u2") },
    ];
    // Inbound notices are recorded locally mid-turn; the CLI sees them with its next prompt.
    const joinedReply = {
      role: "assistant",
      timestamp: 3_000,
      content: [{ type: "text", text: "One.\n\nTwo." }],
    };
    const localMessages = [
      { role: "user", content: "first", timestamp: 990 },
      { role: "user", content: "notice", timestamp: 2_000 },
      joinedReply,
    ];

    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });

    expect(merged).not.toContain(joinedReply);
  });
});
