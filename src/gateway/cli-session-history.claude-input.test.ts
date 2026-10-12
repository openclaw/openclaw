import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildCliSessionDriftNote } from "../agents/cli-session.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { applySessionHints } from "../auto-reply/reply/body.js";
import { buildExecEventPrompt } from "../infra/heartbeat-events-filter.js";
import { buildInterSessionPromptContext } from "../sessions/input-provenance.js";
import { formatSystemTurnPrompt } from "../sessions/system-turn-prompt.js";
import { withEnvAsync } from "../test-utils/env.js";
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
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const userTurn = (uuid: string, content: string) => ({
  type: "user",
  uuid,
  message: { role: "user", content },
});
const assistantTurn = (uuid: string, text: string) => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text }] },
});
const boundary = (content = "Conversation compacted") => ({
  type: "system",
  subtype: "compact_boundary",
  content,
});

const internalInputs = [
  ["resume", buildCliSessionDriftNote(["system-prompt"])],
  [
    "compact-command",
    "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>",
  ],
  ["compact-output", "<local-command-stdout>Compacted </local-command-stdout>"],
  ["exec", buildExecEventPrompt(["Exec completed (example, code 0) :: done"])],
  [
    "exec-with-queued-system-event",
    `System: [2026-10-06 14:35:17 GMT+8] Control UI reaction added: 👍 by Alice on msg m1 from assistant\n\n${buildExecEventPrompt(["Exec completed (example, code 0) :: done"])}`,
  ],
  [
    "exec-after-interrupted-run",
    applySessionHints({
      baseBody: buildExecEventPrompt(["Exec completed (example, code 0) :: done"]),
      abortedLastRun: true,
    }),
  ],
] as const;
// The display projection already rewrites or hides these even on canonical rows,
// so only the imported copy is asserted.
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

/** Import one native row, merge it with no canonical match, then clean it as the reader does. */
function importUnmatched(content: string | unknown[]) {
  const imported = parseImportedUser(content);
  // The importer and the merge must both carry the original text.
  expect(imported?.content).toEqual(content);
  const [merged] = mergeImportedChatHistoryMessages({
    localMessages: [],
    importedMessages: [imported],
  });
  expect(merged).toMatchObject({ content });
  return cleanClaudeCliImportedUserDisplay(merged) as
    | { content?: unknown; display?: unknown; provenance?: unknown }
    | undefined;
}

// Native SDK rows do not retain the canonical input provenance. Exercise both
// native encodings; real local turns must win even when quoting the exact envelope.
describe("Claude imported internal inputs", () => {
  it.each(internalInputs)("hides %s copies without hiding real user messages", (_kind, text) => {
    for (const content of [text, [{ type: "text", text }]]) {
      const imported = parseImportedUser(content);
      expect(projectChatDisplayMessages([imported])).toEqual([]);
      expect(
        classifyClaudeCliHistoryLine({
          line: JSON.stringify(claudeUser(content)),
          cliSessionId: "native-session",
          sourceLineNumber: 1,
        }).humanTurn,
      ).toBe(false);
      const quoted = parseImportedUser(`Please explain this:\n${text}`);
      expect(projectChatDisplayMessages([quoted])).toHaveLength(1);
      const human = { role: "user", content, timestamp: 1 };
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [human],
        importedMessages: imported ? [{ ...imported, timestamp: 2 }] : [],
      });
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
      for (const content of [text, [{ type: "text", text }]]) {
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
    const hint =
      'requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.';
    const body = decoration === "resume" ? "real question" : `${hint}\n\nreal question`;
    const prefix =
      decoration === "resume"
        ? buildCliSessionDriftNote(["system-prompt", "prompt-tools"])
        : 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"requester_profile":{"id":"owner"}}\n```\n\n' +
          hint;
    const text = `${prefix}\n\n${body}`;
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aa" },
    };
    const message = importUnmatched(encoding === "string" ? text : [{ type: "text", text }, image]);
    expect(message?.content).toEqual(
      encoding === "string" ? body : [{ type: "text", text: body }, image],
    );
    expect(message?.display).not.toBe(false);
    expect(message?.provenance).toBeUndefined();
    expect(
      importUnmatched(
        "OpenClaw resumed this CLI session after prompt content changed. This is a quote.",
      )?.content,
    ).toContain("This is a quote.");
  });

  it.each(internalWakeInputs)("marks imported %s prompts internal", (sourceTool, text) => {
    const internal = { display: false, provenance: { kind: "internal_system", sourceTool } };
    expect(parseImportedUser(text)).toMatchObject(internal);
    expect(
      parseImportedUser(`System: [2026-10-03 08:56:29 GMT+8] Gateway restart ok\n\n${text}`),
    ).toMatchObject(internal);
  });

  it.each([
    "[foo] [System] Please explain this tag.",
    "[System] Please explain this tag.",
    "[Tue 2026-09-22 16:00 GMT+8] [System] Please explain this tag.",
    "System: Please preserve this log\n\nExplain it",
    'Explain this instruction: requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.',
    'requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available. Extra user text.\n\nExplain it',
    'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"requester_profile":{"id":"owner"},"requester_profile_hint":"current"}\n```\n\nrequester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.\n\nExplain it',
    "System: Please explain this log\n\n[System] This is the line I am asking about.",
    "Explain this log:\n```text\nlog\n```\n\nSystem: [2026-10-04 13:15:44 GMT+8] evidence\n\nWhat failed?",
    'Explain this log:\nConversation info: ⟦openclaw:ctx⟧\n```json\n{"a":1}\n```\n\nSystem: [2026-10-04 13:15:44 GMT+8] evidence\n\nWhat failed?',
  ])("leaves the look-alike human message %j untouched", (text) => {
    const message = importUnmatched(text);
    expect(message).toMatchObject({ content: text });
    expect(message?.display).not.toBe(false);
    expect(message?.provenance).toBeUndefined();
  });

  it("preserves system-event evidence quoted in a later native text block", () => {
    const content = [
      { type: "text", text: "Explain this log:\n" },
      {
        type: "text",
        text: 'requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.\n\nSystem: [2026-10-04 13:15:44 GMT+8] evidence\n\nWhat failed?',
      },
    ];
    expect(importUnmatched(content)).toMatchObject({ content });
  });

  it.each([
    "",
    'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"a":1}\n```\n\n',
    'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"history_count":2}\n```\n\n' +
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
        // The canonical row holds the turn without the queued events; the pair is one turn.
        const canonical = { role: "user", content: `${context}${question}`, timestamp: 1 };
        expect(
          mergeImportedChatHistoryMessages({
            localMessages: [canonical],
            importedMessages: [{ ...parseImportedUser(text), timestamp: 2 }],
          }),
        ).toMatchObject([canonical]);
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
      const messages = mergeImportedChatHistoryMessages({
        localMessages: [],
        importedMessages: await readMessages(),
      });
      expect(projectChatDisplayMessages(messages)).toMatchObject([
        { role: "user", content: "real question" },
      ]);
      expect(projectChatDisplayMessages(messages)).toHaveLength(1);
    });
  });
});

describe("Claude history activity rows", () => {
  it.each(["null", "not json"])("ignores non-record or malformed activity row %s", (line) => {
    expect(
      classifyClaudeCliHistoryLine({ line, cliSessionId: "activity", sourceLineNumber: 1 }),
    ).toEqual({ humanTurn: false });
  });
});

describe("readClaudeCliFallbackSeed", () => {
  let homeDir: string;
  let projectsDir: string;
  const SESSION_ID = "fallback-seed-session";

  beforeEach(async () => {
    homeDir = path.join(tempDirs.make("openclaw-fallback-seed-"), "home");
    projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
    await fs.mkdir(projectsDir, { recursive: true });
  });

  function readFallbackSeed(cliSessionId = SESSION_ID) {
    return readClaudeCliFallbackSeed({ cliSessionId, homeDir });
  }

  async function writeJsonl(lines: ReadonlyArray<unknown>): Promise<void> {
    const file = path.join(projectsDir, `${SESSION_ID}.jsonl`);
    await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  }

  it.each(["missing", "empty", "path escape"])("returns no seed for %s", async (kind) => {
    if (kind === "empty") {
      await writeJsonl([{ ...userTurn("u-side", "sidechain user turn"), isSidechain: true }]);
    }
    expect(
      await readFallbackSeed(kind === "path escape" ? "../escape" : SESSION_ID),
    ).toBeUndefined();
  });

  it("collects valid turns through the HOME-resolved session store despite null rows", async () => {
    const reseedPrompt = buildLegacyReseedPrompt();
    await writeJsonl([
      userTurn("u-reseed", reseedPrompt),
      userTurn("u-1", "first user prompt"),
      null,
      assistantTurn("a-1", "first assistant reply"),
      userTurn("u-2", "second user prompt"),
    ]);
    const seed = await withEnvAsync({ HOME: homeDir }, async () =>
      readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID }),
    );
    expect(seed).toMatchObject({
      recentTurns: [
        { role: "user", content: reseedPrompt },
        { role: "user", content: "first user prompt" },
        { role: "assistant", content: [{ type: "text", text: "first assistant reply" }] },
        { role: "user", content: "second user prompt" },
      ],
    });
    expect(seed?.summaryText).toBeUndefined();
  });

  it.each([
    {
      name: "latest explicit summary",
      lines: [
        userTurn("u-pre", "PRE-COMPACT user turn"),
        assistantTurn("a-pre", "PRE-COMPACT assistant turn"),
        { type: "summary", summary: "EARLY summary that should be superseded.", leafUuid: "a-pre" },
        boundary(),
        userTurn("u-mid", "mid-window turn"),
        { type: "summary", summary: "LATER summary that must win.", leafUuid: "u-mid" },
        boundary(),
        userTurn("u-tail", "tail turn"),
        assistantTurn("a-tail", "tail reply"),
      ],
      expected: {
        summaryText: "LATER summary that must win.",
        recentTurns: [
          { role: "user", content: "tail turn" },
          { role: "assistant", content: [{ type: "text", text: "tail reply" }] },
        ],
      },
    },
    {
      name: "boundary fallback after a compaction without a summary",
      lines: [
        { type: "summary", summary: "FIRST compact summary", leafUuid: "x" },
        boundary("Conversation compacted (1)"),
        userTurn("u-mid", "post-first-compact turn"),
        boundary("Conversation compacted (2)"),
        userTurn("u-tail", "post-second-compact turn"),
      ],
      expected: {
        summaryText: "Conversation compacted (2)",
        recentTurns: [{ role: "user", content: "post-second-compact turn" }],
      },
    },
    {
      name: "trailing summary without a boundary",
      lines: [
        userTurn("u-1", "earlier turn"),
        { type: "summary", summary: "trailing summary without boundary", leafUuid: "x" },
        userTurn("u-2", "later turn"),
      ],
      expected: { summaryText: "trailing summary without boundary" },
    },
  ])("seeds from the $name", async ({ lines, expected }) => {
    await writeJsonl(lines);
    expect(await readFallbackSeed()).toMatchObject(expected);
  });
});
