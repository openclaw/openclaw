import rawFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  formatCliImageTurnContext,
  hashCliImageTurnEntryId,
} from "../agents/cli-image-turn-correlation.js";
import { hashCliReseedPrompt } from "../agents/cli-runner/reseed-envelope.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import { redactTranscriptMessage } from "../agents/transcript-redact.js";
import type { CliSessionReseedReceipt, SessionEntry } from "../config/sessions.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readClaudeCliSessionMessages } from "./cli-session-history.claude.js";
import {
  readChatHistoryCliSessionImportSnapshot,
  resolveChatHistoryWithCliSessionImports,
} from "./cli-session-history.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";
import {
  buildLegacyReseedPrompt,
  createClaudeHistoryLines,
} from "./cli-session-history.test-support.js";
import { expectRecordFields, requireGatewayRecord } from "./test-helpers.assertions.js";

type AugmentCliHistoryParams = Parameters<typeof resolveChatHistoryWithCliSessionImports>[0];

const CLAUDE_RESUME_DRIFT_NOTES = [
  "OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=system-prompt.",
  "OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=prompt-tools.",
  "OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=system-prompt,prompt-tools.",
] as const;

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expectRecordFields(value, "fields", expected);
}

function readRecord(value: unknown): Record<string, unknown> {
  return requireGatewayRecord(value, "record");
}

function cliMeta(externalId: string, cliSessionId: string | null = "session-1") {
  return {
    importedFrom: "claude-cli",
    externalId,
    ...(cliSessionId === null ? {} : { cliSessionId }),
  };
}

function answer(
  timestamp?: number,
  externalId?: string,
  cliSessionId: string | null = "session-1",
) {
  return {
    role: "assistant",
    content: "Repeated answer",
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(externalId === undefined ? {} : { __openclaw: cliMeta(externalId, cliSessionId) }),
  };
}

function boundEntry(sessionId: string): SessionEntry {
  return {
    sessionId: "openclaw-session",
    updatedAt: 1,
    cliSessionBindings: { "claude-cli": { sessionId } },
  };
}

function receipt(prompt: string, localSessionId = "openclaw-session"): CliSessionReseedReceipt {
  return {
    version: 1,
    promptHash: hashCliReseedPrompt(prompt),
    localSessionId,
    userTurnDisposition: "persisted",
  };
}

function user(content: unknown, timestamp?: number, meta?: Record<string, unknown>) {
  return {
    role: "user",
    content,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(meta ? { __openclaw: meta } : {}),
  };
}

function claudeUser(content: unknown, fields: Record<string, unknown> = {}) {
  return { type: "user", ...fields, message: { role: "user", content } };
}

function augmentBoundClaudeHistory(
  homeDir: string,
  sessionId: string,
  localMessages: AugmentCliHistoryParams["localMessages"] = [],
  provider = "claude-cli",
) {
  return resolveChatHistoryWithCliSessionImports({
    entry: boundEntry(sessionId),
    provider,
    localMessages,
    homeDir,
  }).messages;
}

function createClaudeTextHistoryLines(
  entries: Array<{ content: string; role: "assistant" | "user"; uuid: string }>,
): string {
  return entries
    .map((entry, index) =>
      JSON.stringify({
        type: entry.role,
        uuid: entry.uuid,
        timestamp: new Date(Date.parse("2026-03-26T16:29:54.800Z") + index).toISOString(),
        message: { role: entry.role, content: entry.content },
      }),
    )
    .join("\n");
}

function writeClaudeEntries(filePath: string, entries: readonly Record<string, unknown>[]) {
  return fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf-8");
}

async function withClaudeProjectsDir<T>(
  run: (params: { homeDir: string; sessionId: string; filePath: string }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-history-"));
  const homeDir = path.join(root, "home");
  const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(filePath, createClaudeHistoryLines(sessionId), "utf-8");
  try {
    return await withEnvAsync({ HOME: homeDir }, () => run({ homeDir, sessionId, filePath }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("cli session history", () => {
  it("refreshes changed Claude snapshots and singleflights concurrent reads", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const params = {
        entry: boundEntry(sessionId),
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      };
      const read = async () =>
        resolveChatHistoryWithCliSessionImports({
          ...params,
          preparedImportedMessages: await readChatHistoryCliSessionImportSnapshot(params),
        });
      const streamSpy = vi.spyOn(rawFs, "createReadStream");
      const transcriptRedact = await import("../agents/transcript-redact.js");
      const redactSpy = vi.spyOn(transcriptRedact, "redactTranscriptMessage");
      const readdirSyncSpy = vi.spyOn(rawFs, "readdirSync");
      const existsSyncSpy = vi.spyOn(rawFs, "existsSync");
      const initial = await (async () => {
        try {
          const [first, second] = await Promise.all([
            readChatHistoryCliSessionImportSnapshot(params),
            readChatHistoryCliSessionImportSnapshot(params),
          ]);
          expect(second).toEqual(first);
          expect(await readChatHistoryCliSessionImportSnapshot(params)).toEqual(first);
          expect(streamSpy).toHaveBeenCalledTimes(1);
          expect(redactSpy).toHaveBeenCalledTimes(first.length);
          // Scope this to transcript discovery; redaction may load unrelated config.
          const projectsDir = path.dirname(path.dirname(filePath));
          expect(
            readdirSyncSpy.mock.calls.filter(([directory]) => directory === projectsDir),
          ).toHaveLength(0);
          expect(existsSyncSpy).not.toHaveBeenCalledWith(filePath);
          return resolveChatHistoryWithCliSessionImports({
            ...params,
            preparedImportedMessages: first,
          });
        } finally {
          streamSpy.mockRestore();
          redactSpy.mockRestore();
          readdirSyncSpy.mockRestore();
          existsSyncSpy.mockRestore();
        }
      })();
      expect(initial.messages).toHaveLength(3);

      await fs.appendFile(
        filePath,
        `\n${createClaudeTextHistoryLines([
          { role: "user", uuid: "appended-user", content: "appended" },
        ])}`,
        "utf8",
      );
      const appended = await read();
      expect(appended.messages).toHaveLength(4);
      expect(appended.messages.map((message) => readRecord(message)["__openclaw"])).toContainEqual(
        expect.objectContaining({ externalId: "appended-user" }),
      );

      await fs.writeFile(
        filePath,
        createClaudeTextHistoryLines([
          { role: "assistant", uuid: "replacement-assistant", content: "replacement" },
        ]),
        "utf8",
      );
      const replaced = await read();
      expect(replaced.messages).toHaveLength(1);
      expectFields(readRecord(replaced.messages[0])["__openclaw"], {
        externalId: "replacement-assistant",
      });

      const movedProjectDir = path.join(path.dirname(path.dirname(filePath)), "moved-workspace");
      await fs.mkdir(movedProjectDir);
      const movedFilePath = path.join(movedProjectDir, path.basename(filePath));
      await fs.rename(filePath, movedFilePath);
      expect(await read()).toEqual(replaced);

      await fs.rm(movedFilePath);
      const deleted = await read();
      expect(deleted).toEqual({ messages: [], imported: false, expanded: false });
    });
  });

  it("preserves project precedence when a later matching transcript is found first", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const projectsDir = path.dirname(path.dirname(filePath));
      const otherProjectDir = path.join(projectsDir, "other-workspace");
      await fs.mkdir(otherProjectDir);
      await fs.writeFile(
        path.join(otherProjectDir, path.basename(filePath)),
        createClaudeTextHistoryLines([
          { role: "user", uuid: "other-project-user", content: "other project" },
        ]),
      );
      const [firstPath, secondPath] = (await fs.readdir(projectsDir)).map((project) =>
        path.join(projectsDir, project, path.basename(filePath)),
      );
      const expected = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      const releaseFirst = createDeferred();
      const foundSecond = createDeferred();
      const access = fs.access;
      const accessSpy = vi
        .spyOn(rawFs.promises, "access")
        .mockImplementation(async (candidate, mode) => {
          if (candidate === firstPath) {
            await releaseFirst.promise;
          }
          await access(candidate, mode);
          if (candidate === secondPath) {
            foundSecond.resolve();
          }
        });
      const pending = readChatHistoryCliSessionImportSnapshot({
        entry: boundEntry(sessionId),
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      try {
        await Promise.race([foundSecond.promise, pending]);
        releaseFirst.resolve();
        expect(await pending).toEqual(expected);
      } finally {
        releaseFirst.resolve();
        await pending;
        accessSpy.mockRestore();
      }
    });
  });

  it("preserves Date.parse semantics for numeric-looking Claude timestamps", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      await writeClaudeEntries(filePath, [
        claudeUser("zero", { uuid: "numeric-zero", timestamp: "0" }),
        claudeUser("year", { uuid: "numeric-year", timestamp: "2026" }),
      ]);

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expect(messages.map((message) => message.timestamp)).toEqual([
        Date.parse("0"),
        Date.parse("2026"),
      ]);
    });
  });

  it("assigns stable source-line ids when Claude entries have no uuid", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      await writeClaudeEntries(filePath, [
        claudeUser("stable fallback", { timestamp: "2026-03-26T16:29:54.800Z" }),
      ]);
      const first = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      const second = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expectFields(first[0]?.["__openclaw"], { id: `claude-cli:${sessionId}:line:1` });
      expect(second[0]?.["__openclaw"]).toEqual(first[0]?.["__openclaw"]);
    });
  });

  it("omits isMeta rows and records internal Claude context provenance", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const notification =
        "<task-notification>\n<task-id>task-1</task-id>\n<status>completed</status>\n<summary>Background review finished.</summary>\n</task-notification>";
      await writeClaudeEntries(filePath, [
        claudeUser("run the review", { uuid: "operator-1" }),
        claudeUser(
          [
            {
              type: "text",
              text: "Base directory for this skill: /tmp/skills/autoreview\n\n# Auto Review",
            },
          ],
          { uuid: "skill-meta-1", isMeta: true, sourceToolUseID: "toolu_skill" },
        ),
        claudeUser("This session is being continued from a previous conversation.", {
          uuid: "compact-summary-1",
          isCompactSummary: true,
        }),
        claudeUser("Transcript-only synthetic context row.", {
          uuid: "transcript-only-1",
          isVisibleInTranscriptOnly: true,
        }),
        claudeUser(notification, {
          uuid: "task-notification-1",
          origin: { kind: "task-notification" },
        }),
        claudeUser(notification, { uuid: "operator-pasted-xml-1" }),
      ]);

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });

      expect(JSON.stringify(messages)).not.toContain("Base directory for this skill");
      expect(messages).toMatchObject([
        { role: "user" },
        { provenance: { kind: "internal_system", sourceTool: "cli_harness_context" } },
        { provenance: { kind: "internal_system", sourceTool: "cli_harness_context" } },
        { provenance: { kind: "internal_system", sourceTool: "claude_cli_task_notification" } },
        { role: "user" },
      ]);
      expect(readRecord(messages[0]).provenance).toBeUndefined();
      expect(readRecord(messages[4]).provenance).toBeUndefined();
    });
  });

  it("preserves image mentions inside text blocks before history merge", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const mention = "@/Users/demo/workspace/.openclaw-cli-images/cafe03.png";
      await writeClaudeEntries(filePath, [
        claudeUser(
          [
            { type: "text", text: `caption\n\n${mention}` },
            { type: "text", text: mention },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aa" } },
          ],
          { uuid: "block-user", timestamp: "2026-03-26T16:29:54.800Z" },
        ),
        claudeUser([{ type: "text", text: mention }], {
          uuid: "mention-only-block-user",
          timestamp: "2026-03-26T16:29:55.800Z",
        }),
      ]);

      const messages = augmentBoundClaudeHistory(homeDir, sessionId);
      expect(messages).toMatchObject([
        {
          role: "user",
          content: [
            { type: "text", text: `caption\n\n${mention}` },
            { type: "text", text: mention },
            { type: "image" },
          ],
        },
        { role: "user", content: [{ type: "text", text: mention }] },
      ]);
    });
  });

  it("dedupes correlated captioned rows without timestamps and retains import provenance", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const id = "local-captioned-image";
      const media = [
        { kind: "image", contentType: "image/png", path: "/media/inbound/cafe05.png" },
      ];
      await writeClaudeEntries(filePath, [
        claudeUser(
          `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nlook at this\n\n${formatCliImageTurnContext(hashCliImageTurnEntryId(id))}\n\n@/Users/demo/workspace/.openclaw-cli-images/cafe05.png`,
          { uuid: "image-only-user" },
        ),
      ]);
      const localMessage = { role: "user", content: "look at this", __openclaw: { id, media } };
      const result = resolveChatHistoryWithCliSessionImports({
        entry: boundEntry(sessionId),
        provider: "claude-cli",
        localMessages: [localMessage],
        homeDir,
      });
      expect(result).toEqual({
        imported: true,
        expanded: false,
        messages: [
          { ...localMessage, __openclaw: { id, media, ...cliMeta("image-only-user", sessionId) } },
        ],
      });
    });
  });

  it("consumes each local media-bearing turn only once", () => {
    const localCount = 2;
    const timestamp = Date.parse("2026-03-26T16:29:54.500Z");
    const localEntryId = "local-repeated-image";
    const importedMessages = ["first-image-user", "second-image-user", "third-image-user"].map(
      (externalId, index) => ({
        role: "user",
        content: `look at this\n\n${formatCliImageTurnContext(hashCliImageTurnEntryId(localEntryId))}\n\n@/Users/demo/workspace/.openclaw-cli-images/cafe0${index + 5}.png`,
        timestamp: timestamp + index * 60_000,
        __openclaw: {
          importedFrom: "claude-cli",
          cliSessionId: "session-1",
          externalId,
        },
      }),
    );
    const localMessages = Array.from({ length: localCount }, () => ({
      role: "user",
      content: "look at this",
      timestamp,
      __openclaw: {
        id: localEntryId,
        media: [{ kind: "image", contentType: "image/png", path: "/media/inbound/cafe05.png" }],
      },
    }));

    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });

    expect(merged).toHaveLength(localCount + 1);
    for (let index = 0; index < localCount; index += 1) {
      expect(readRecord(merged[index]).content).toBe("look at this");
      expect(readRecord(readRecord(merged[index])["__openclaw"])).toMatchObject({
        id: localEntryId,
        importedFrom: "claude-cli",
        cliSessionId: "session-1",
        externalId: readRecord(readRecord(importedMessages[index])["__openclaw"]).externalId,
        media: [{ kind: "image", contentType: "image/png", path: "/media/inbound/cafe05.png" }],
      });
    }
    expect(merged.at(-1)).toBe(importedMessages[localCount]);
  });

  it("dedupes a drift-note text block while preserving the local turn", () => {
    const note = CLAUDE_RESUME_DRIFT_NOTES[2];
    const timestamp = Date.parse("2026-09-10T10:57:09.764Z");
    const localMessage = user("test ping...", timestamp, {
      id: "local-test-ping",
      senderIsOwner: true,
    });
    const importedText = `${note}\n\nSender: ⟦openclaw:ctx⟧\n\`\`\`json\n{"label":"openclaw-control-ui"}\n\`\`\`\n\n[Thu 2026-03-26 16:29 GMT] test ping... [[reply_to_current]]`;
    const importedMessage = user(
      [{ type: "text", text: importedText }],
      timestamp + 1_531,
      cliMeta("drift-user"),
    );
    const before = structuredClone({ localMessage, importedMessage });

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localMessage],
      importedMessages: [importedMessage],
    });

    expect(merged).toEqual([
      {
        ...localMessage,
        __openclaw: { ...localMessage["__openclaw"], ...importedMessage["__openclaw"] },
      },
    ]);
    expect({ localMessage, importedMessage }).toEqual(before);
  });

  it.each([
    [
      "unknown reason",
      `${CLAUDE_RESUME_DRIFT_NOTES[0].replace("system-prompt", "user-choice")}\n\nhello`,
    ],
    ["leading space", ` ${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nhello`],
    ["two notes", `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\n${CLAUDE_RESUME_DRIFT_NOTES[1]}\n\nhello`],
  ])("retains a distinct imported user row with %s", (_label, content) => {
    const localMessage = { role: "user", content: "hello", timestamp: 1_000 };
    const importedMessage = {
      role: "user",
      content,
      timestamp: 1_001,
      __openclaw: cliMeta("native-user"),
    };

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localMessage],
      importedMessages: [importedMessage],
    });

    expect(merged).toEqual([localMessage, importedMessage]);
  });

  it.each(["text", "external identity"])(
    "keeps an ordinary unprefixed import eligible after a literal %s match",
    (matchKind) => {
      const literal = `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nhello`;
      const literalMeta = cliMeta("literal-note");
      const plainMeta = { ...literalMeta, externalId: "plain-user" };
      const localMessages = [
        { role: "user", content: "hello", timestamp: 1_000 },
        {
          role: "user",
          content: literal,
          timestamp: 1_001,
          ...(matchKind === "external identity" ? { __openclaw: literalMeta } : {}),
        },
      ];

      const merged = mergeImportedChatHistoryMessages({
        localMessages,
        importedMessages: [
          { role: "user", content: literal, timestamp: 1_002, __openclaw: literalMeta },
          { role: "user", content: "hello", timestamp: 1_003, __openclaw: plainMeta },
        ],
      });

      expect(merged).toEqual([
        { ...localMessages[0], __openclaw: plainMeta },
        { ...localMessages[1], __openclaw: literalMeta },
      ]);
    },
  );

  it.each([
    {
      label: "literal then stripped",
      firstLocalIsLiteral: false,
      firstImportTime: 1_002,
      secondImportTime: 1_003,
    },
    {
      label: "stripped then literal",
      firstLocalIsLiteral: true,
      firstImportTime: 600_001,
      secondImportTime: 1_002,
    },
  ])(
    "keeps repeated native text order when matching $label",
    ({ firstLocalIsLiteral, firstImportTime, secondImportTime }) => {
      const literal = `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nhello`;
      const localMessages = [
        { role: "user", content: firstLocalIsLiteral ? literal : "hello", timestamp: 1_000 },
        user(firstLocalIsLiteral ? "hello" : literal, firstImportTime),
      ];
      const firstMeta = cliMeta("first-import");
      const laterImport = user(literal, secondImportTime, {
        ...firstMeta,
        externalId: "later-import",
      });

      const merged = mergeImportedChatHistoryMessages({
        localMessages,
        importedMessages: [
          { role: "user", content: literal, timestamp: firstImportTime, __openclaw: firstMeta },
          laterImport,
        ],
      });

      expect(merged).toHaveLength(3);
      expect(merged).toContainEqual(localMessages[0]);
      expect(merged).toContainEqual({ ...localMessages[1], __openclaw: firstMeta });
      expect(merged).toContainEqual(laterImport);
    },
  );

  it.each([1_000, undefined])(
    "keeps ordinary matches after an unsuccessful stripped lookup (timestamp=%s)",
    (timestamp) => {
      const literal = `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nhello`;
      const localMessages = [
        { role: "user", content: "hello", timestamp },
        { role: "user", content: literal, timestamp: 1_001 },
      ];
      const literalMeta = cliMeta("literal-user");
      const plainMeta = { ...literalMeta, externalId: "plain-user" };
      const repeatedImport = user(literal, 1_003, { ...literalMeta, externalId: "repeated-user" });

      const merged = mergeImportedChatHistoryMessages({
        localMessages,
        importedMessages: [
          { role: "user", content: literal, timestamp: 1_002, __openclaw: literalMeta },
          repeatedImport,
          { role: "user", content: "hello", timestamp: 1_004, __openclaw: plainMeta },
        ],
      });

      expect(merged).toEqual([
        { ...localMessages[0], __openclaw: plainMeta },
        { ...localMessages[1], __openclaw: literalMeta },
        repeatedImport,
      ]);
    },
  );

  it.each([
    {
      label: "assistant text",
      role: "assistant",
      localContent: "hello",
      importedContent: `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nhello`,
      importedFrom: "claude-cli",
    },
    {
      label: "non-Claude imported text",
      role: "user",
      localContent: "hello",
      importedContent: `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nhello`,
      importedFrom: "other-cli",
    },
  ])(
    "does not strip drift notes from $label",
    ({ role, localContent, importedContent, importedFrom }) => {
      const localMessage = { role, content: localContent, timestamp: 1_000 };
      const importedMessage = {
        role,
        content: importedContent,
        timestamp: 1_001,
        __openclaw: { importedFrom, cliSessionId: "session-1", externalId: "native-row" },
      };

      const merged = mergeImportedChatHistoryMessages({
        localMessages: [localMessage],
        importedMessages: [importedMessage],
      });

      expect(merged).toEqual([localMessage, importedMessage]);
    },
  );

  it("retains drift-note imports outside the match window", () => {
    const localMessage = user("hello", 1_000);
    const importedMessage = user(
      `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nhello`,
      1_000 + 5 * 60 * 1_000 + 1,
      cliMeta("native-user"),
    );
    expect(
      mergeImportedChatHistoryMessages({
        localMessages: [localMessage],
        importedMessages: [importedMessage],
      }),
    ).toEqual([localMessage, importedMessage]);
  });

  it("matches image-only imports to their exact local turns", () => {
    const timestamp = Date.parse("2026-03-26T16:29:54.500Z");
    const localEntryId = "local-image-b";
    const orphanedImport = user(
      `${formatCliImageTurnContext(hashCliImageTurnEntryId("local-image-a"))}\n\n@/tmp/openclaw/openclaw-cli-images/${"a".repeat(64)}.png`,
      timestamp,
      cliMeta("image-a"),
    );
    const matchedImport = user(
      `${formatCliImageTurnContext(hashCliImageTurnEntryId(localEntryId))}\n\n@/tmp/openclaw/openclaw-cli-images/${"b".repeat(64)}.png`,
      timestamp + 60_000,
      cliMeta("image-b"),
    );
    const localMessage = {
      role: "user",
      content: "",
      timestamp: timestamp + 60_000,
      __openclaw: {
        id: localEntryId,
        media: [{ kind: "image", contentType: "image/png", path: "/media/inbound/b.png" }],
      },
    };

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localMessage],
      importedMessages: [orphanedImport, matchedImport],
    });

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(orphanedImport);
    expect(readRecord(readRecord(merged[1])["__openclaw"])).toMatchObject({
      id: localEntryId,
      importedFrom: "claude-cli",
      cliSessionId: "session-1",
      externalId: "image-b",
      media: [{ kind: "image", contentType: "image/png", path: "/media/inbound/b.png" }],
    });
  });

  it("retains captioned image mentions when no local media-bearing turn survives", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const content = "look at this\n\n@/Users/demo/workspace/.openclaw-cli-images/cafe07.png";
      const importedContent = `look at this\n\n${formatCliImageTurnContext(hashCliImageTurnEntryId("missing-local-turn"))}\n\n@/Users/demo/workspace/.openclaw-cli-images/cafe07.png`;
      await writeClaudeEntries(filePath, [
        claudeUser(importedContent, {
          uuid: "captioned-image-user",
          timestamp: "2026-03-26T16:29:54.800Z",
        }),
        {
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-03-26T16:29:55.800Z",
          message: { role: "assistant", content: "nice photo" },
        },
      ]);

      const merged = augmentBoundClaudeHistory(homeDir, sessionId);

      expect(merged).toHaveLength(2);
      expectFields(merged[0], { role: "user", content });
      expectFields(merged[1], { role: "assistant", content: "nice photo" });

      const captionOnlyLocal = augmentBoundClaudeHistory(homeDir, sessionId, [
        user("look at this", Date.parse("2026-03-26T16:29:54.800Z")),
      ]);
      expect(captionOnlyLocal).toHaveLength(3);
      expect(captionOnlyLocal).toContainEqual(expect.objectContaining({ content }));
    });
  });

  it("recovers the current user text from legacy reseed envelopes", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const reseedPrompt = buildLegacyReseedPrompt();
      await writeClaudeEntries(filePath, [claudeUser(reseedPrompt, { uuid: "reseed-user" })]);

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });

      expect(messages).toHaveLength(1);
      expectFields(messages[0], { role: "user", content: "current" });
    });
  });

  it("fails open when the receipt belongs to a different local session", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const transformedPrompt = "transformed synthetic reseed prompt";
      await writeClaudeEntries(filePath, [
        claudeUser(transformedPrompt, { uuid: "synthetic-reseed" }),
      ]);

      const messages = readClaudeCliSessionMessages({
        cliSessionId: sessionId,
        homeDir,
        localSessionId: "new-openclaw-session",
        reseedReceipt: receipt(transformedPrompt, "old-openclaw-session"),
      });

      expect(messages).toHaveLength(1);
      expectFields(messages[0], { role: "user", content: transformedPrompt });
    });
  });

  it("suppresses only receipt-matched text while preserving sibling attachments", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const transformedPrompt = "transformed synthetic reseed prompt";
      await writeClaudeEntries(filePath, [
        claudeUser(
          [
            { type: "text", text: transformedPrompt },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
          ],
          { uuid: "synthetic-reseed" },
        ),
        {
          type: "assistant",
          uuid: "assistant-1",
          message: { role: "assistant", content: "response" },
        },
      ]);

      const messages = readClaudeCliSessionMessages({
        cliSessionId: sessionId,
        homeDir,
        localSessionId: "openclaw-session",
        reseedReceipt: receipt(transformedPrompt),
      });

      expect(messages).toHaveLength(2);
      expect(readRecord(messages[0]).content).toEqual([
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ]);
      expectFields(messages[1], { role: "assistant", content: "response" });
    });
  });

  it("preserves receipt-matched arrays with multiple text blocks", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const transformedPrompt = "transformed synthetic reseed prompt";
      const content = [
        { type: "text", text: transformedPrompt },
        { type: "text", text: "real extra user text" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ];
      await writeClaudeEntries(filePath, [
        claudeUser(content, { uuid: "synthetic-reseed" }),
        claudeUser(transformedPrompt, { uuid: "later-exact-match" }),
      ]);

      const messages = readClaudeCliSessionMessages({
        cliSessionId: sessionId,
        homeDir,
        localSessionId: "openclaw-session",
        reseedReceipt: receipt(transformedPrompt),
      });

      expect(messages).toHaveLength(2);
      expect(readRecord(messages[0]).content).toEqual(content);
      expectFields(messages[1], { role: "user", content: transformedPrompt });
    });
  });

  it("recovers legacy array-form reseed text while preserving attachments", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      await writeClaudeEntries(filePath, [
        claudeUser(
          [
            { type: "text", text: buildLegacyReseedPrompt() },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
          ],
          { uuid: "legacy-reseed" },
        ),
      ]);

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });

      expect(messages).toHaveLength(1);
      expect(readRecord(messages[0]).content).toEqual([
        { type: "text", text: "current" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ]);
    });
  });

  it("drops empty legacy reseed text while preserving sibling native content", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const caption = { type: "text", text: "real caption" };
      const image = {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "x" },
      };
      const document = { type: "document", source: { type: "text", data: "notes" } };
      await writeClaudeEntries(filePath, [
        claudeUser(
          [caption, { type: "text", text: buildLegacyReseedPrompt("") }, image, document],
          { uuid: "legacy-empty-reseed" },
        ),
      ]);

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });

      expect(messages).toHaveLength(1);
      expect(readRecord(messages[0]).content).toEqual([caption, image, document]);
    });
  });

  it.each([
    ["string", buildLegacyReseedPrompt("")],
    ["single text block", [{ type: "text", text: buildLegacyReseedPrompt("") }]],
  ])("drops empty legacy reseed rows in %s form", async (_label, content) => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      await writeClaudeEntries(filePath, [claudeUser(content, { uuid: "legacy-empty-reseed" })]);

      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });

      expect(messages).toEqual([]);
    });
  });

  it("fails open when the first user row does not match the reseed receipt", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const expectedPrompt = "expected synthetic prompt";
      await writeClaudeEntries(filePath, [
        claudeUser("different prompt", { uuid: "unexpected-first-user" }),
        claudeUser(expectedPrompt, { uuid: "later-matching-user" }),
      ]);

      const messages = readClaudeCliSessionMessages({
        cliSessionId: sessionId,
        homeDir,
        localSessionId: "openclaw-session",
        reseedReceipt: receipt(expectedPrompt),
      });

      expect(messages).toHaveLength(2);
      expectFields(messages[0], { role: "user", content: "different prompt" });
      expectFields(messages[1], { role: "user", content: expectedPrompt });
    });
  });

  it("rejects path-like Claude CLI session ids", async () => {
    await withClaudeProjectsDir(async ({ homeDir, filePath }) => {
      const projectDir = path.dirname(filePath);
      const projectsDir = path.dirname(projectDir);
      const sentinel = `${JSON.stringify(claudeUser("must not import", { uuid: "path-traversal-sentinel" }))}\n`;
      await fs.writeFile(path.join(projectsDir, "outside.jsonl"), sentinel, "utf-8");
      await fs.mkdir(path.join(projectDir, "nested"), { recursive: true });
      await fs.writeFile(path.join(projectDir, "nested", "session.jsonl"), sentinel, "utf-8");
      if (path.sep !== "\\") {
        await fs.writeFile(path.join(projectDir, "nested\\session.jsonl"), sentinel, "utf-8");
      }

      for (const cliSessionId of ["../outside", "nested/session", "nested\\session"]) {
        expect(readClaudeCliSessionMessages({ cliSessionId, homeDir })).toEqual([]);
        expect(
          await readChatHistoryCliSessionImportSnapshot({
            entry: boundEntry(cliSessionId),
            provider: "claude-cli",
            localMessages: [],
            homeDir,
          }),
        ).toEqual([]);
      }
    });
  });

  it("reads comparable fields once while merging large identity-less histories", () => {
    const rowCount = 200;
    const reads = { role: 0, content: 0, timestamp: 0 };
    const createMessage = (source: "imported" | "local", index: number) => {
      const timestamp = Date.parse("2026-03-26T16:29:54.800Z") + index;
      return {
        get role() {
          reads.role += 1;
          return "user";
        },
        get content() {
          reads.content += 1;
          return `${source}-${index}`;
        },
        get timestamp() {
          reads.timestamp += 1;
          return timestamp;
        },
      };
    };
    const localMessages = Array.from({ length: rowCount }, (_, index) =>
      createMessage("local", index),
    );
    const importedMessages = Array.from({ length: rowCount }, (_, index) =>
      createMessage("imported", rowCount + index),
    );

    // The former growing scan made 59,900 failed comparisons for these unique rows.
    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });

    expect(reads).toEqual({ role: rowCount * 2, content: rowCount * 2, timestamp: rowCount * 2 });
    expect(merged).toHaveLength(rowCount * 2);
    expect(merged[0]).toBe(localMessages[0]);
    expect(merged.at(-1)).toBe(importedMessages.at(-1));
  });

  it("deduplicates a local redacted copy against an imported full copy", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const secretText = "key is sk-abcdef1234567890xyz";
      const localMessage = redactTranscriptMessage({
        role: "user",
        content: secretText,
      } as AgentMessage);
      const localMessages = [localMessage];
      const redactedContent = readRecord(localMessage).content;
      if (typeof redactedContent !== "string") {
        throw new Error("expected redacted local text content");
      }
      await fs.writeFile(
        filePath,
        createClaudeTextHistoryLines([
          {
            role: "user",
            uuid: "user-secret-copy",
            content: `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\n${secretText}`,
          },
        ]),
        "utf-8",
      );

      const messages = augmentBoundClaudeHistory(homeDir, sessionId, localMessages);

      expect(messages).not.toBe(localMessages);
      expect(messages).toHaveLength(1);
      expectFields(readRecord(messages[0])["__openclaw"], {
        importedFrom: "claude-cli",
        externalId: "user-secret-copy",
        cliSessionId: sessionId,
      });
      expect(readRecord(messages[0]).content).toBe(redactedContent);
      const streamSpy = vi.spyOn(rawFs, "createReadStream");
      try {
        await expect(
          readChatHistoryCliSessionImportSnapshot({
            entry: boundEntry(sessionId),
            provider: "openai",
            localMessages,
            homeDir,
          }),
        ).resolves.toEqual([]);
        expect(streamSpy).not.toHaveBeenCalled();
      } finally {
        streamSpy.mockRestore();
      }
    });
  });

  it("reserves later exact identities before earlier fuzzy imports", () => {
    const timestamp = Date.parse("2026-09-01T10:00:00Z");
    const exact = {
      role: "assistant",
      content: "Repeated answer",
      timestamp,
      __openclaw: { importedFrom: "claude-cli", externalId: "exact-id" },
    };
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [exact, answer(timestamp)],
      importedMessages: [answer(timestamp), exact, answer(timestamp)],
    });

    expect(merged).toEqual([exact, answer(timestamp), answer(timestamp)]);
    expect(readRecord(readRecord(merged[0])["__openclaw"]).externalId).toBe("exact-id");
  });

  it("keeps drift-note order after an edited exact identity", () => {
    const laterNote = CLAUDE_RESUME_DRIFT_NOTES[1];
    const earlierLocal = { role: "user", content: "Original ask", timestamp: 1_000 };
    const exactMeta = cliMeta("exact-user");
    const exactLocal = user("Edited ask", 1_001, exactMeta);
    const laterImport = user(`${laterNote}\n\nOriginal ask`, 1_003, {
      ...exactMeta,
      externalId: "later-user",
    });

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [earlierLocal, exactLocal],
      importedMessages: [
        user(`${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nOriginal ask`, 1_002, exactMeta),
        laterImport,
      ],
    });

    expect(merged).toEqual([earlierLocal, exactLocal, laterImport]);
  });

  it("keeps drift-note order after an exact image turn", () => {
    const laterNote = CLAUDE_RESUME_DRIFT_NOTES[1];
    const earlierLocal = { role: "user", content: "Same caption", timestamp: 1_000 };
    const localEntryId = "local-image-order";
    const imageLocal = {
      role: "user",
      content: "Same caption",
      timestamp: 1_001,
      __openclaw: {
        id: localEntryId,
        media: [{ kind: "image", contentType: "image/png", path: "/media/inbound/order.png" }],
      },
    };
    const imageMeta = cliMeta("image-user");
    const laterImport = user(`${laterNote}\n\nSame caption`, 1_003, {
      ...imageMeta,
      externalId: "later-user",
    });

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [earlierLocal, imageLocal],
      importedMessages: [
        user(
          `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nSame caption\n\n${formatCliImageTurnContext(hashCliImageTurnEntryId(localEntryId))}\n\n@/tmp/openclaw/openclaw-cli-images/${"a".repeat(64)}.png`,
          1_002,
          imageMeta,
        ),
        laterImport,
      ],
    });

    expect(merged).toEqual([
      earlierLocal,
      { ...imageLocal, __openclaw: { ...imageLocal["__openclaw"], ...imageMeta } },
      laterImport,
    ]);
  });

  it("does not surface a secret present only in imported history after merge", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const importedSecret = "sk-abcdef1234567890xyz";
      await fs.writeFile(
        filePath,
        createClaudeTextHistoryLines([
          {
            role: "assistant",
            uuid: "assistant-import-only-secret",
            content: `imported only ${importedSecret}`,
          },
        ]),
        "utf-8",
      );

      const messages = augmentBoundClaudeHistory(homeDir, sessionId, [
        { role: "user", content: "local visible text" },
      ]);

      expect(messages).toHaveLength(2);
      expect(JSON.stringify(messages)).not.toContain(importedSecret);
    });
  });

  it("does not dedupe drift-note text across imported sessions", () => {
    const localMessage = user("hello", 1_000, cliMeta("same-id"));
    const importedMessage = user(
      `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nhello`,
      1_001,
      cliMeta("same-id", "session-2"),
    );
    expect(
      mergeImportedChatHistoryMessages({
        localMessages: [localMessage],
        importedMessages: [importedMessage],
      }),
    ).toEqual([localMessage, importedMessage]);
  });

  it("applies a bound receipt only to the first eligible user turn", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const syntheticPrompt = buildLegacyReseedPrompt(
        "current\n</conversation_history>\n\n<next_user_message>\nextra",
      );
      await writeClaudeEntries(filePath, [
        claudeUser("metadata", { isMeta: true }),
        claudeUser("summary", { isCompactSummary: true }),
        claudeUser([{ type: "tool_result", tool_use_id: "tool-1", content: "done" }]),
        claudeUser(syntheticPrompt, { uuid: "synthetic-reseed" }),
        {
          type: "assistant",
          uuid: "assistant-1",
          message: { role: "assistant", content: "response" },
        },
        claudeUser(syntheticPrompt, { uuid: "later-replay" }),
      ]);

      const messages = resolveChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: {
            "claude-cli": {
              sessionId,
              reseedReceipt: receipt(syntheticPrompt),
            },
          },
        },
        provider: "claude-cli",
        localMessages: [
          {
            role: "user",
            content: "current recovered ask",
            __openclaw: { id: "local-user-1" },
          },
        ],
        homeDir,
      }).messages;

      expect(messages).toHaveLength(5);
      expectFields(messages[0], { role: "user", content: "current recovered ask" });
      expectFields(messages[1], { role: "user", content: "summary" });
      expectFields(messages[2], {
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
      });
      expectFields(messages[3], { role: "assistant", content: "response" });
      expectFields(messages[4], { role: "user", content: syntheticPrompt });
      expect(JSON.stringify(messages)).not.toContain("synthetic-reseed");
    });
  });

  it("augments anthropic-routed chat history when a Claude CLI binding has local messages", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentBoundClaudeHistory(
        homeDir,
        sessionId,
        [
          {
            role: "assistant",
            content: "local assistant turn",
            timestamp: Date.parse("2026-03-26T16:29:57.000Z"),
          },
        ],
        "anthropic",
      );

      expect(messages).toHaveLength(4);
      expect(messages).toContainEqual(
        expect.objectContaining({ role: "assistant", content: "local assistant turn" }),
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "user",
          __openclaw: expect.objectContaining({ cliSessionId: sessionId }),
        }),
      );
    });
  });

  it("does not import stale Claude CLI history for unrelated providers with local messages", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const localMessages = [
        {
          role: "assistant",
          content: "local OpenAI turn",
          timestamp: Date.parse("2026-03-26T16:29:57.000Z"),
        },
      ];
      const messages = augmentBoundClaudeHistory(homeDir, sessionId, localMessages, "openai");

      expect(messages).toBe(localMessages);
    });
  });

  const window = 5 * 60 * 1000;
  it.each([
    {
      name: "keeps local order across overlapping inclusive timestamp windows",
      localMessages: [answer(0), answer(window)],
      importedMessages: [answer(window, "first"), answer(window, "second")],
      expected: [answer(0, "first"), answer(window, "second")],
    },
    {
      name: "does not assign identities backward across nonchronological rows",
      localMessages: [answer(window * 2), answer(0)],
      importedMessages: [answer(0, "first"), answer(window * 2, "second")],
      expected: [answer(0, "first"), answer(window * 2), answer(window * 2, "second")],
    },
    {
      name: "shares order across identity-specific indexes",
      localMessages: [answer(window * 2), answer(0)],
      importedMessages: [answer(0), answer(window * 2, "later", null)],
      expected: [answer(0), answer(window * 2), answer(window * 2, "later", null)],
    },
    {
      name: "preserves local candidates after an unmatched import",
      localMessages: [answer(window * 2)],
      importedMessages: [answer(0), answer(window * 2, "later", null)],
      expected: [answer(0), answer(window * 2, "later", null)],
    },
    {
      name: "keeps the order floor monotonic after an earlier exact identity",
      localMessages: [answer(0, "exact", null), answer(window), answer(window * 3)],
      importedMessages: [
        answer(window * 3),
        answer(0, "exact", null),
        answer(window, "later", null),
      ],
      expected: [
        answer(0, "exact", null),
        answer(window),
        answer(window, "later", null),
        answer(window * 3),
      ],
    },
    {
      name: "preserves repeated identityless imports without local history",
      localMessages: [],
      importedMessages: [answer(0), answer(0)],
      expected: [answer(0), answer(0)],
    },
    {
      name: "orders timestamp-less imports across both candidate pools",
      localMessages: [answer(0), answer()],
      importedMessages: [answer(undefined, "first", null), answer(undefined, "second", null)],
      expected: [answer(0, "first", null), answer(undefined, "second", null)],
    },
    {
      name: "breaks equal predecessor timestamp ties using local order",
      localMessages: [answer(0), answer(0)],
      importedMessages: [answer(1, "first"), answer(1, "second")],
      expected: [answer(0, "first"), answer(0, "second")],
    },
    {
      name: "retains timestamped matches after a timestamp-less fallback",
      localMessages: [answer(), answer(window * 2)],
      importedMessages: [answer(0), answer(window * 2, "later", null)],
      expected: [answer(), answer(window * 2, "later", null)],
    },
    {
      name: "prefers timestamped matches before timestamp-less fallbacks",
      localMessages: [answer(), answer(window)],
      importedMessages: [answer(window, "timestamped"), answer(undefined, "timestamp-less")],
      expected: [answer(), answer(window, "timestamped"), answer(undefined, "timestamp-less")],
    },
  ])("$name", ({ localMessages, importedMessages, expected }) => {
    expect(mergeImportedChatHistoryMessages({ localMessages, importedMessages })).toEqual(expected);
  });

  it("consumes large repeated-text histories without rescanning matched candidates", () => {
    const timestamp = Date.parse("2026-09-01T10:00:00Z");
    const count = 20_000;
    const localMessages = Array.from({ length: count }, (_, index) => ({
      role: "assistant",
      content: "Repeated answer",
      timestamp: timestamp + index,
    }));
    const importedMessages = localMessages.map((message, index) => ({
      ...message,
      __openclaw: cliMeta(`external-${index}`),
    }));

    const startedAt = performance.now();
    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(merged).toHaveLength(count);
    expect(readRecord(readRecord(merged[0])["__openclaw"]).externalId).toBe("external-0");
    expect(readRecord(readRecord(merged.at(-1))["__openclaw"]).externalId).toBe(
      `external-${count - 1}`,
    );
  });

  it("does not reuse a text-consumed local row for image deduplication", () => {
    const localEntryId = "local-image-row";
    const timestamp = Date.parse("2026-09-01T10:00:00Z");
    const localMessage = {
      role: "user",
      content: "look at this",
      timestamp,
      __openclaw: {
        id: localEntryId,
        media: [{ kind: "image", contentType: "image/png", path: "/media/inbound/a.png" }],
      },
    };
    const textImport = user("look at this", timestamp, cliMeta("text-import"));
    const imageImport = user(
      `look at this\n\n${formatCliImageTurnContext(hashCliImageTurnEntryId(localEntryId))}\n\n@/tmp/openclaw/openclaw-cli-images/${"a".repeat(64)}.png`,
      timestamp + 1,
      cliMeta("image-import"),
    );

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localMessage],
      importedMessages: [textImport, imageImport],
    });

    expect(merged).toHaveLength(2);
    expect(readRecord(readRecord(merged[0])["__openclaw"]).externalId).toBe("text-import");
    expect(readRecord(readRecord(merged[1])["__openclaw"]).externalId).toBe("image-import");
  });

  it("preserves local transcript order when imports only add metadata", () => {
    const localMessages = [
      { role: "assistant", content: "first transcript row", timestamp: 2 },
      { role: "assistant", content: "second transcript row", timestamp: 1 },
    ];
    const importedMessages = localMessages.map((message, index) => ({
      ...message,
      __openclaw: cliMeta(`external-${index}`),
    }));

    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });

    expect(merged.map((message) => readRecord(message).content)).toEqual([
      "first transcript row",
      "second transcript row",
    ]);
  });

  it("imports a locked legacy Claude conversation after Doctor migration", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const { maybeRepairCodexSessionRoutes } =
        await import("../commands/doctor/shared/codex-route-session-repair.js");
      const { openOpenClawStateDatabase, closeOpenClawStateDatabaseForTest } =
        await import("../state/openclaw-state-db.js");
      const stateDir = path.join(homeDir, "state");
      openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
      closeOpenClawStateDatabaseForTest();
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const key = "agent:main:cli-history";
      const entry: SessionEntry = {
        sessionId: "openclaw-session",
        updatedAt: 1,
        claudeCliSessionId: sessionId,
        modelSelectionLocked: true,
        agentHarnessId: "claude-cli",
      };
      expect(
        resolveChatHistoryWithCliSessionImports({
          entry,
          provider: "claude-cli",
          localMessages: [],
          homeDir,
        }).messages,
      ).toEqual([]);
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify({ [key]: entry }));
      await maybeRepairCodexSessionRoutes({
        cfg: {
          plugins: { enabled: false },
          session: { store: storePath },
          agents: { entries: { main: {} }, defaults: { model: "anthropic/claude-sonnet-4-6" } },
        },
        env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_HOME: homeDir },
        shouldRepair: true,
      });
      const reopened: Record<string, SessionEntry> = JSON.parse(
        await fs.readFile(storePath, "utf8"),
      );
      expect(reopened[key]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(sessionId);
      expect(reopened[key]?.modelSelectionLocked).toBe(true);
      const messages = resolveChatHistoryWithCliSessionImports({
        entry: reopened[key],
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      }).messages;
      expect(messages).toHaveLength(3);
      expectFields(messages[0], {
        role: "user",
      });
      expectFields(readRecord(messages[0])["__openclaw"], { cliSessionId: sessionId });
    });
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
