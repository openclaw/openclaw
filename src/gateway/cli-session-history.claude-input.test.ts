import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildCliSessionDriftNote } from "../agents/cli-session.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { applySessionHints } from "../auto-reply/reply/body.js";
import { buildExecEventPrompt } from "../infra/heartbeat-events-filter.js";
import {
  buildInterSessionPromptContext,
  type InputProvenance,
} from "../sessions/input-provenance.js";
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
  merge,
  user,
  withClaudeProjectsDir,
  blocks,
  REQUESTER_HINT,
  frame,
  DRIFT_NOTES,
  cliMeta,
  readImportedHistory,
  writeClaudeEntries,
} from "./cli-session-history.test-support.js";

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
const execPrompt = buildExecEventPrompt(["Exec completed (example, code 0) :: done"]);

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

it.each(internalInputs)("hides %s copies without hiding real user messages", async (kind, text) => {
  for (const content of [
    text,
    blocks(text),
    ...(kind === "resume" ? [] : [`${DRIFT_NOTES[1]}\n\n${text}`]),
  ]) {
    const { messages } = await readImportedHistory([
      claudeUser(content, { uuid: kind }),
      claudeUser(`Please explain this:\n${text}`),
    ]);
    const [imported, quoted] = messages;
    expect(projectChatDisplayMessages([imported])).toEqual([]);
    expect(projectChatDisplayMessages(merge([], messages))).toMatchObject([
      { role: "user", content: `Please explain this:\n${text}` },
    ]);
    expect(classify(JSON.stringify(claudeUser(content))).humanTurn).toBe(false);
    expect(projectChatDisplayMessages([quoted])).toHaveLength(1);
    const human = user(content, 1);
    const merged = merge([human], imported ? [{ ...imported, timestamp: 2 }] : []);
    expect(projectChatDisplayMessages(merged)).toMatchObject([{ role: "user", content }]);
  }
});

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

it.each(["null", "not json"])("ignores non-record or malformed activity row %s", (line) => {
  expect(classify(line)).toEqual({ humanTurn: false });
});

function readSeed(
  lines: readonly unknown[] | undefined,
  options: { fromHome?: boolean; cliSessionId?: string } = {},
) {
  return withClaudeProjectsDir(async ({ filePath, sessionId, homeDir }) => {
    if (lines) {
      await writeClaudeEntries(filePath, lines);
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

const DRIFT_NOTE = DRIFT_NOTES[2];
const OPS_PROVENANCE: InputProvenance = {
  kind: "inter_session",
  sourceSessionKey: "agent:ops:main",
  sourceTool: "sessions_send",
};
const REQUESTER_FRAME = frame();

function envelope(provenance: InputProvenance = OPS_PROVENANCE) {
  return buildInterSessionPromptContext(provenance).text;
}

function routed(
  content: string,
  timestamp: number,
  externalId?: string,
  provenance: InputProvenance = OPS_PROVENANCE,
) {
  return {
    ...user(content, timestamp, externalId ? cliMeta(externalId) : undefined),
    provenance,
  };
}

describe("routed CLI prompts in chat history", () => {
  it.each([
    "earlier messages in this chat",
    "messages recorded in this chat since your last reply here (possibly already in this session)",
  ])("preserves unmatched routed text block provenance beneath %s context", async (description) => {
    const provenance = OPS_PROVENANCE;
    const note = `[OpenClaw: 2 ${description} from 2026-10-10T22:30:29.302Z to 2026-10-10T22:30:43.592Z, using "mock/mock-model". Their contents are not included here. Before answering a question that may depend on these messages, call mcp__openclaw__sessions_history({"sessionKey":"agent:main:switch-back","limit":100}) to read them; page older messages with offset if needed.]`;
    const raw = `${note}\n\n${envelope()}\nPlease check the build.`;
    const content = [{ type: "text", text: raw }];
    const { messages } = await readImportedHistory([
      claudeUser(content, { uuid: "routed-switch-back" }),
    ]);
    const merged = merge([], messages);

    expect(merged).toMatchObject([{ role: "user", content, provenance }]);
    expect(merged[0]).not.toMatchObject({ senderIsOwner: true });
  });

  it.each(["sessions_send", "subagent_settle"])(
    "records %s provenance from the routed prompt envelope",
    async (sourceTool) => {
      const provenance: InputProvenance = {
        kind: "inter_session",
        sourceSessionKey: "agent:main:main",
        sourceChannel: "webchat",
        sourceTool,
      };
      const text = envelope(provenance);
      const { messages } = await readImportedHistory([
        claudeUser(`${text}\n${DRIFT_NOTE}\nPlease check the build.`, { uuid: "routed-1" }),
        claudeUser([{ type: "text", text: `${text}\nBlock body.` }], { uuid: "routed-2" }),
        claudeUser(
          `[Inter-session message] sourceTool=sessions_send isUser=false\nTyped by hand.`,
          {
            uuid: "look-alike-1",
          },
        ),
      ]);

      expect(messages).toMatchObject([
        {
          role: "user",
          content: `${text}\n${DRIFT_NOTE}\nPlease check the build.`,
          provenance,
        },
        { role: "user", content: [{ type: "text", text: `${text}\nBlock body.` }], provenance },
        { role: "user" },
      ]);
      expect(messages[2]?.provenance).toBeUndefined();
      for (const message of messages.slice(0, 2)) {
        expect(message.display).not.toBe(false);
      }
    },
  );

  it("matches literal routed text block requester frame before removing generated-looking decorations", async () => {
    const provenance = OPS_PROVENANCE;
    const quoted = `${REQUESTER_FRAME}${REQUESTER_HINT}\n\nPlease check the build.`;
    const content = [{ type: "text", text: `${envelope()}\n${quoted}` }];
    const plain = { ...user("Please check the build."), provenance };
    const literal = { ...user([{ type: "text", text: quoted }]), provenance };
    const { messages: imported, sessionId } = await readImportedHistory([
      claudeUser(content, { uuid: "routed-literal" }),
    ]);
    const merged = merge([plain, literal], imported);

    expect(merged).toEqual([
      plain,
      { ...literal, __openclaw: cliMeta("routed-literal", sessionId) },
    ]);
    expect(imported[0]?.content).toEqual(content);
  });

  it("keeps routed quotation identities from advancing the plain-body floor on reload", () => {
    const provenance = OPS_PROVENANCE;
    const quoted = `${REQUESTER_FRAME}${REQUESTER_HINT}\n\nhello`;
    const plain = { ...user("hello"), provenance };
    const literal = { ...user(quoted, undefined, cliMeta("literal")), provenance };
    const imports = [
      user(`${envelope()}\n${quoted}`, undefined, cliMeta("literal")),
      user(`${envelope()}\nhello`, undefined, cliMeta("plain")),
    ];

    expect(merge([plain, literal], imports)).toEqual([
      { ...plain, __openclaw: cliMeta("plain") },
      literal,
    ]);
  });

  it("matches repeated ordinary turns in order across different generated context", async () => {
    const context =
      'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"requester_profile":{"id":"owner"},"requester_profile_hint":"current"}\n```\n\n';
    const first = user(`${context}hello`);
    const second = user("hello");
    const { messages, sessionId } = await readImportedHistory([
      claudeUser(`${DRIFT_NOTE}\n\nhello`, { uuid: "first" }),
      claudeUser("hello", { uuid: "second" }),
    ]);

    expect(merge([first, second], messages)).toEqual([
      { ...first, __openclaw: cliMeta("first", sessionId) },
      { ...second, __openclaw: cliMeta("second", sessionId) },
    ]);
  });

  it("dedupes routed prompts whose drift note sits under the inter-session envelope", () => {
    const provenance: InputProvenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:main:main",
      sourceTool: "sessions_send",
    };
    const settleProvenance: InputProvenance = {
      kind: "inter_session",
      sourceTool: "subagent_settle",
    };
    const local = routed(
      `${envelope(provenance)}\nPlease check the build.`,
      1_000,
      undefined,
      provenance,
    );
    const settled = routed(
      "[Subagent Context] Every subagent has settled.",
      2_000,
      undefined,
      settleProvenance,
    );
    const imports = [
      user(
        `${envelope(provenance)}\n${DRIFT_NOTE}\nPlease check the build.`,
        1_001,
        cliMeta("routed"),
      ),
      user(
        `${envelope(settleProvenance)}\n[Subagent Context] Every subagent has settled.`,
        2_001,
        cliMeta("settled"),
      ),
    ];
    expect(merge([local, settled], imports)).toEqual([
      { ...local, __openclaw: cliMeta("routed") },
      { ...settled, __openclaw: cliMeta("settled") },
    ]);
  });

  it("keeps equal routed bodies from different source sessions apart", () => {
    const finance = { ...OPS_PROVENANCE, sourceSessionKey: "agent:finance:main" };
    const localWithEnvelope = routed(`${envelope()}\ndone`, 1_000);
    const localBodyOnly = routed("done", 1_000_000);
    const importedFinance = routed(`${envelope(finance)}\ndone`, 1_001, "finance-1", finance);
    const importedFinanceLater = routed(
      `${envelope(finance)}\ndone`,
      1_000_001,
      "finance-2",
      finance,
    );
    const importedOps = routed(`${envelope()}\ndone`, 1_000_002, "ops-2");

    expect(
      merge(
        [localWithEnvelope, localBodyOnly],
        [importedFinance, importedFinanceLater, importedOps],
      ),
    ).toEqual([
      localWithEnvelope,
      importedFinance,
      { ...localBodyOnly, __openclaw: cliMeta("ops-2") },
      importedFinanceLater,
    ]);
  });

  it("keeps an owner message apart from a routed message with the same body", () => {
    const owner = user("done", 1_000);
    const importedRouted = routed(`${envelope()}\ndone`, 1_001, "routed");
    expect(merge([owner], [importedRouted])).toEqual([owner, importedRouted]);
  });

  it("dedupes routed prompts carrying queued system event lines", () => {
    const local = routed("what changed?", 1_000);
    const imported = routed(
      `${envelope()}\nSystem: [2026-09-30 17:16:38 UTC] Gateway connected.\n\nwhat changed?`,
      1_001,
      "routed-events",
    );
    expect(merge([local], [imported])).toEqual([
      { ...local, __openclaw: cliMeta("routed-events") },
    ]);
  });
});
