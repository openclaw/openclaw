import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { buildCliSessionDriftNote } from "../agents/cli-session.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { applySessionHints } from "../auto-reply/reply/body.js";
import { buildExecEventPrompt } from "../infra/heartbeat-events-filter.js";
import { buildInterSessionPromptContext } from "../sessions/input-provenance.js";
import { formatSystemTurnPrompt } from "../sessions/system-turn-prompt.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { classifyClaudeCliHistoryLine } from "./cli-session-history.claude-activity.js";
import {
  cleanClaudeCliImportedUserDisplay,
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
const REQUESTER_HINT =
  'requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.';
const frame = (json: string) =>
  `Conversation info: ⟦openclaw:ctx⟧\n\`\`\`json\n${json}\n\`\`\`\n\n`;
const execPrompt = buildExecEventPrompt(["Exec completed (example, code 0) :: done"]);

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

it.each(["sessions_send", "subagent_settle"])(
  "preserves routed %s input for the shared provenance projection",
  (sourceTool) => {
    const text = `${
      buildInterSessionPromptContext({
        kind: "inter_session",
        sourceSessionKey: "agent:peer:main",
        sourceTool,
      }).text
    }\nRouted result.`;
    for (const content of [text, blocks(text)]) {
      const imported = parseImportedUser(content);
      expect(imported).toMatchObject({ role: "user", content });
      expect(imported?.display).not.toBe(false);
      expect(imported?.provenance).not.toMatchObject({ kind: "internal_system" });
    }
  },
);

it.each([
  ["resume", "string"],
  ["resume", "text-block"],
  ["legacy requester", "string"],
  ["legacy requester", "text-block"],
])("removes the %s decorator, not its real %s user turn", (decoration, encoding) => {
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
  expectVisible(
    importUnmatched(encoding === "string" ? text : [...blocks(text), image]),
    encoding === "string" ? body : [...blocks(body), image],
  );
});

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
  "",
  frame('{"a":1}'),
  frame('{"history_count":2}') +
    "Recent chat history: ⟦openclaw:ctx⟧\n" +
    "#123 2026-10-11 12:20:09 GMT+5:30 Alice: The conservatory has 137 benches.\n" +
    "#124 2026-10-11 12:20:20 GMT+5:30 Alice: /model anthropic/claude-haiku-4-5\n\n",
])("drops queued system event lines from a real user turn", (context) => {
  for (const stamp of [
    "2026-10-04 13:15:44 GMT+8",
    "2026-10-11 12:20:20 GMT+5:30",
    "2026-10-04T05:15:44Z",
    "unknown-time",
  ]) {
    const events = `System: [${stamp}] Model switched.\nSystem: more\n\n`;
    for (const question of [
      "real question",
      "Please explain this header:\n\nContext: ⟦openclaw:ctx⟧\nexample",
      "Please explain this header:\n\nContext:\n<active_memory_plugin>\nexample\n</active_memory_plugin>",
    ]) {
      const text = `${context}${events}${question}`;
      expect(importUnmatched(text)?.content).toBe(`${context}${question}`);
      const canonical = user(`${context}${question}`, 1);
      expect(merge([canonical], [{ ...parseImportedUser(text), timestamp: 2 }])).toMatchObject([
        canonical,
      ]);
    }
  }
  const untouched = "real question\n\nSystem: quoted log line\n\nmore";
  expect(importUnmatched(untouched)).toMatchObject({ content: untouched });
});

it("hides decorated internal rows through JSONL import, merge and the common client history projection", async () => {
  await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
    const note = buildCliSessionDriftNote(["prompt-tools"]);
    await fs.writeFile(
      filePath,
      [
        claudeUser("real question", { uuid: "human" }),
        ...internalInputs.map(([kind, text]) =>
          claudeUser(kind === "resume" ? text : `${note}\n\n${text}`, { uuid: kind }),
        ),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const messages = merge([], await readMessages());
    expect(projectChatDisplayMessages(messages)).toMatchObject([
      { role: "user", content: "real question" },
    ]);
  });
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

it.each([
  [
    "latest explicit summary",
    [
      claudeUser("PRE-COMPACT user turn"),
      assistantTurn("PRE-COMPACT assistant turn"),
      summary("EARLY"),
      boundary(),
      claudeUser("mid-window turn"),
      summary("LATER"),
      boundary(),
      claudeUser("tail turn"),
      assistantTurn("tail reply"),
    ],
    {
      summaryText: "LATER",
      recentTurns: [user("tail turn"), assistantTurn("tail reply").message],
    },
  ],
  [
    "boundary fallback after a compaction without a summary",
    [
      summary("FIRST"),
      boundary("Conversation compacted (1)"),
      claudeUser("post-first-compact turn"),
      boundary("Conversation compacted (2)"),
      claudeUser("post-second-compact turn"),
    ],
    {
      summaryText: "Conversation compacted (2)",
      recentTurns: [user("post-second-compact turn")],
    },
  ],
  [
    "trailing summary without a boundary",
    [
      claudeUser("earlier turn"),
      summary("trailing summary without boundary"),
      claudeUser("later turn"),
    ],
    { summaryText: "trailing summary without boundary" },
  ],
] as const)("seeds from the %s", async (_name, lines, expected) => {
  expect(await readSeed(lines)).toMatchObject(expected);
});
