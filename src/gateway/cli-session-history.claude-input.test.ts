import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { buildCliSessionDriftNote } from "../agents/cli-session-drift.js";
import {
  projectChatDisplayMessages,
  projectChatDisplayMessagesWithState,
} from "./chat-display-projection.js";
import { classifyClaudeCliHistoryLine } from "./cli-session-history.claude-activity.js";
import {
  parseClaudeCliHistoryEntry,
  readClaudeCliFallbackSeed,
} from "./cli-session-history.claude.js";
import {
  buildLegacyReseedPrompt,
  claudeUser,
  mergeImportedChatHistoryMessages,
  user,
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";

const blocks = (text: string) => [{ type: "text", text }];
const assistantTurn = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: blocks(text) },
});
const boundary = (content = "Conversation compacted") => ({
  type: "system",
  subtype: "compact_boundary",
  content,
});
const summary = (text: string) => ({ type: "summary", summary: text });
const writeRows = (filePath: string, rows: readonly unknown[]) =>
  fs.writeFile(filePath, rows.map((row) => JSON.stringify(row)).join("\n"));

function merge(localMessages: unknown[], importedMessages: unknown[]) {
  return mergeImportedChatHistoryMessages({ localMessages, importedMessages });
}

function classify(line: string) {
  return classifyClaudeCliHistoryLine({
    line,
    cliSessionId: "native-session",
    sourceLineNumber: 1,
  });
}

const internalInputs = [
  ["resume", buildCliSessionDriftNote(["system-prompt"])],
  [
    "compact-command",
    "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>",
  ],
  ["compact-output", "<local-command-stdout>Compacted </local-command-stdout>"],
] as const;
function parseImportedUser(content: string | unknown[]) {
  return parseClaudeCliHistoryEntry(claudeUser(content), "native-session", 1, new Map(), {
    reseedMode: "recover",
  });
}

it.each(internalInputs)("hides %s copies without hiding real user messages", (_kind, text) => {
  for (const content of [text, blocks(text)]) {
    const imported = parseImportedUser(content);
    expect(projectChatDisplayMessages([imported])).toEqual([]);
    expect(classify(JSON.stringify(claudeUser(content))).humanTurn).toBe(false);
    const quoted = parseImportedUser(`Please explain this:\n${text}`);
    expect(projectChatDisplayMessages([quoted])).toHaveLength(1);
    const human = user(content, 1);
    const merged = merge([human], imported ? [{ ...imported, timestamp: 2 }] : []);
    expect(projectChatDisplayMessages(merged)).toMatchObject([{ role: "user", content }]);
  }
});

it.each(["[Request interrupted by user]", "[Request interrupted by user for tool use]"])(
  "hides the native %s row without hiding human text or look-alikes",
  async (text) => {
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
      const interrupt = claudeUser(blocks(text), { uuid: "interrupt" });
      const visible = [
        claudeUser(text, { uuid: "string" }),
        ...["promptSource", "turnOrigin", "turnPosition", "permissionMode"].map((field) =>
          claudeUser(blocks(text), { uuid: field, [field]: "user" }),
        ),
        claudeUser(`${text} Please explain.`, { uuid: "suffix" }),
        claudeUser(blocks(` ${text}`), { uuid: "whitespace" }),
        claudeUser([...blocks(text), ...blocks("Please explain.")], { uuid: "sibling" }),
      ];
      await writeRows(filePath, [interrupt, ...visible]);
      const projected = projectChatDisplayMessagesWithState(merge([], await readMessages()));
      expect(projected.messages.map((message) => message.content)).toEqual(
        visible.map((entry) => entry.message.content),
      );
      expect(projected.activity).toEqual([]);
      expect(classify(JSON.stringify(interrupt)).humanTurn).toBe(false);
      for (const entry of visible) {
        expect(classify(JSON.stringify(entry)).humanTurn).toBe(true);
      }
    });
  },
);

it.each(["null", "not json"])("ignores non-record or malformed activity row %s", (line) => {
  expect(classify(line)).toEqual({ humanTurn: false });
});

function readSeed(
  lines: readonly unknown[] | undefined,
  options: { fromHome?: boolean; cliSessionId?: string } = {},
) {
  return withClaudeProjectsDir(async ({ filePath, sessionId, homeDir }) => {
    if (lines) {
      await fs.writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    } else {
      await fs.rm(filePath);
    }
    return readClaudeCliFallbackSeed({
      cliSessionId: options.cliSessionId ?? sessionId,
      ...(options.fromHome ? {} : { homeDir }),
    });
  });
}

it.each([
  ["missing", undefined, undefined],
  ["empty", [claudeUser("sidechain user turn", { isSidechain: true })], undefined],
  ["path escape", undefined, "../escape"],
] as const)("returns no seed for %s", async (_kind, lines, cliSessionId) => {
  expect(await readSeed(lines, { cliSessionId })).toBeUndefined();
});

it("collects valid turns through the HOME-resolved session store despite null rows", async () => {
  const reseedPrompt = buildLegacyReseedPrompt();
  const seed = await readSeed(
    [
      claudeUser(reseedPrompt),
      claudeUser("first user prompt"),
      null,
      assistantTurn("first assistant reply"),
      claudeUser("second user prompt"),
    ],
    { fromHome: true },
  );
  expect(seed?.recentTurns).toMatchObject([
    user(reseedPrompt),
    user("first user prompt"),
    assistantTurn("first assistant reply").message,
    user("second user prompt"),
  ]);
  expect(seed?.summaryText).toBeUndefined();
});

it("seeds from the latest explicit summary", async () => {
  expect(
    await readSeed([
      claudeUser("PRE-COMPACT user turn"),
      assistantTurn("PRE-COMPACT assistant turn"),
      summary("EARLY"),
      boundary(),
      claudeUser("mid-window turn"),
      summary("LATER"),
      boundary(),
      claudeUser("tail turn"),
      assistantTurn("tail reply"),
    ]),
  ).toMatchObject({
    summaryText: "LATER",
    recentTurns: [user("tail turn"), assistantTurn("tail reply").message],
  });
});

it("seeds from the boundary after a compaction without a summary", async () => {
  expect(
    await readSeed([
      summary("FIRST"),
      boundary("Conversation compacted (1)"),
      claudeUser("post-first-compact turn"),
      boundary("Conversation compacted (2)"),
      claudeUser("post-second-compact turn"),
    ]),
  ).toMatchObject({
    summaryText: "Conversation compacted (2)",
    recentTurns: [user("post-second-compact turn")],
  });
});

it("seeds from a trailing summary without a boundary", async () => {
  expect(
    await readSeed([
      claudeUser("earlier turn"),
      summary("trailing summary without boundary"),
      claudeUser("later turn"),
    ]),
  ).toMatchObject({ summaryText: "trailing summary without boundary" });
});
