import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { buildCliSessionDriftNote } from "../agents/cli-session-drift.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { applySessionHints } from "../auto-reply/reply/body.js";
import { formatSystemTurnPrompt } from "../sessions/system-turn-prompt.js";
import {
  projectChatDisplayMessages,
  projectChatDisplayMessagesWithState,
} from "./chat-display-projection.js";
import { classifyClaudeCliHistoryLine } from "./cli-session-history.claude-activity.js";
import {
  cleanClaudeCliImportedUserDisplay,
  parseClaudeCliHistoryEntry,
  readClaudeCliFallbackSeed,
} from "./cli-session-history.claude.js";
import {
  buildLegacyReseedPrompt,
  claudeUser,
  LEGACY_EXEC_COMPLETION_PROMPT,
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
const REQUESTER_HINT =
  'requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.';
const frame = (json: string) =>
  `Conversation info: ⟦openclaw:ctx⟧\n\`\`\`json\n${json}\n\`\`\`\n\n`;
const execPrompt = LEGACY_EXEC_COMPLETION_PROMPT;
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

function expectVisible(message: ReturnType<typeof importUnmatched>, content: unknown) {
  expect(message?.content).toEqual(content);
  expect(message?.display).not.toBe(false);
  expect(message?.provenance).toBeUndefined();
}

const internalInputs = [
  ["resume", buildCliSessionDriftNote(["system-prompt"])],
  [
    "compact-command",
    "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>",
  ],
  ["compact-output", "<local-command-stdout>Compacted </local-command-stdout>"],
  ["exec", execPrompt],
  [
    "exec-with-queued-system-event",
    `System: [2026-10-06 14:35:17 GMT+8] Control UI reaction added: 👍 by Alice on msg m1 from assistant\n\n${execPrompt}`,
  ],
  [
    "exec-after-interrupted-run",
    applySessionHints({
      baseBody: execPrompt,
      abortedLastRun: true,
    }),
  ],
] as const;
const RESTART_RECOVERY_OPENING = formatSystemTurnPrompt(
  "Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work.",
);
const internalWakeInputs = [
  ["heartbeat", `${HEARTBEAT_PROMPT}\nCurrent time: Saturday`],
  [
    "heartbeat",
    `Run the following periodic tasks (only those due based on their intervals):\n\n- inbox: Check mail\n\nAfter completing all due tasks, reply with exactly NO_REPLY as the entire final answer. NO_REPLY discards anything written this turn that was not sent, so send confirmations before ending silently.`,
  ],
  ["restart_recovery", RESTART_RECOVERY_OPENING],
  ["restart_recovery", `[Tue 2026-09-22 16:00 GMT+8] ${RESTART_RECOVERY_OPENING} Continue.`],
] as const;

function parseImportedUser(content: string | unknown[]) {
  return parseClaudeCliHistoryEntry(claudeUser(content), "native-session", 1, new Map(), {
    reseedMode: "recover",
  });
}

function importUnmatched(content: string | unknown[]) {
  const imported = parseImportedUser(content);
  expect(imported?.content).toEqual(content);
  const [merged] = merge([], [imported]);
  expect(merged).toMatchObject({ content });
  return cleanClaudeCliImportedUserDisplay(merged) as
    | { content?: unknown; display?: unknown; provenance?: unknown }
    | undefined;
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

it.each(["resume", "legacy requester"])(
  "removes the %s decorator, not its image-bearing user turn",
  (decoration) => {
    const body = decoration === "resume" ? "real question" : `${REQUESTER_HINT}\n\nreal question`;
    const prefix =
      decoration === "resume"
        ? buildCliSessionDriftNote(["system-prompt", "prompt-tools"])
        : frame('{"requester_profile":{"id":"owner"}}') + REQUESTER_HINT;
    const text = `${prefix}\n\n${body}`;
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aa" },
    };
    expectVisible(importUnmatched([...blocks(text), image]), [...blocks(body), image]);
  },
);

it.each(internalWakeInputs)("marks imported %s prompts internal", (sourceTool, text) => {
  const internal = { display: false, provenance: { kind: "internal_system", sourceTool } };
  expect(
    [text, `System: [2026-10-03 08:56:29 GMT+8] Gateway restart ok\n\n${text}`].map(
      parseImportedUser,
    ),
  ).toMatchObject([internal, internal]);
});

it.each([
  "OpenClaw resumed this CLI session after prompt content changed. This is a quote.",
  "[foo] [System] Please explain this tag.",
  "[System] Please explain this tag.",
  "[Tue 2026-09-22 16:00 GMT+8] [System] Please explain this tag.",
  "System: Please preserve this log\n\nExplain it",
  `Explain this instruction: ${REQUESTER_HINT}`,
  `${REQUESTER_HINT} Extra user text.\n\nExplain it`,
  `${frame('{"requester_profile":{"id":"owner"},"requester_profile_hint":"current"}')}${REQUESTER_HINT}\n\nExplain it`,
  "System: Please explain this log\n\n[System] This is the line I am asking about.",
  "Explain this log:\n```text\nlog\n```\n\nSystem: [2026-10-04 13:15:44 GMT+8] evidence\n\nWhat failed?",
  `Explain this log:\n${frame('{"a":1}')}System: [2026-10-04 13:15:44 GMT+8] evidence\n\nWhat failed?`,
])("leaves the look-alike human message %j untouched", (text) => {
  expectVisible(importUnmatched(text), text);
});

it("preserves system-event evidence quoted in a later native text block", () => {
  const content = [
    ...blocks("Explain this log:\n"),
    ...blocks(`${REQUESTER_HINT}\n\nSystem: [2026-10-04 13:15:44 GMT+8] evidence\n\nWhat failed?`),
  ];
  expect(importUnmatched(content)).toMatchObject({ content });
});

it.each([
  ["", "2026-10-04T05:15:44Z", "real question"],
  [
    frame('{"a":1}'),
    "unknown-time",
    "Please explain this header:\n\nContext: ⟦openclaw:ctx⟧\nexample",
  ],
  [
    frame('{"history_count":2}') +
      "Recent chat history: ⟦openclaw:ctx⟧\n" +
      "#123 2026-10-11 12:20:09 GMT+5:30 Alice: The conservatory has 137 benches.\n" +
      "#124 2026-10-11 12:20:20 GMT+5:30 Alice: /model anthropic/claude-haiku-4-5\n\n",
    "2026-10-11 12:20:20 GMT+5:30",
    "Please explain this header:\n\nContext:\n<active_memory_plugin>\nexample\n</active_memory_plugin>",
  ],
])("drops queued system events below context %j", (context, stamp, question) => {
  const events = `System: [${stamp}] Model switched.\nSystem: more\n\n`;
  const text = `${context}${events}${question}`;
  expect(importUnmatched(text)?.content).toBe(`${context}${question}`);
  const canonical = user(`${context}${question}`, 1);
  expect(merge([canonical], [{ ...parseImportedUser(text), timestamp: 2 }])).toMatchObject([
    canonical,
  ]);
  const untouched = "real question\n\nSystem: quoted log line\n\nmore";
  expect(importUnmatched(untouched)).toMatchObject({ content: untouched });
});

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
