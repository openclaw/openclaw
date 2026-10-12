import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatCliImageTurnContext,
  hashCliImageTurnEntryId,
} from "../agents/cli-image-turn-correlation.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import { redactTranscriptMessage } from "../agents/transcript-redact.js";
import type { SessionEntry } from "../config/sessions.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import { mergeCliHistoryWithLookupStats } from "./cli-session-history-lookup.test-support.js";
import {
  readClaudeCliSessionMessagesAsync,
  mergeImportedChatHistoryMessages,
  answer,
  boundEntry,
  buildLegacyReseedPrompt,
  claudeUser,
  cliMeta,
  createClaudeTextHistoryLines,
  receipt,
  user,
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";
import { expectRecordFields, requireGatewayRecord } from "./test-helpers.assertions.js";

type AugmentCliHistoryParams = {
  entry: SessionEntry | undefined;
  localMessages: unknown[];
  homeDir?: string;
};

async function readChatHistory(params: AugmentCliHistoryParams) {
  const binding = getCliSessionBinding(params.entry, "claude-cli");
  const importedMessages = binding?.sessionId
    ? await readClaudeCliSessionMessagesAsync({
        cliSessionId: binding.sessionId,
        homeDir: params.homeDir,
        localSessionId: params.entry?.sessionId,
        reseedReceipt: binding.reseedReceipt,
      })
    : [];
  return {
    messages: mergeImportedChatHistoryMessages({
      localMessages: params.localMessages,
      importedMessages,
    }),
  };
}

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

async function augmentBoundClaudeHistory(
  homeDir: string,
  sessionId: string,
  localMessages: AugmentCliHistoryParams["localMessages"] = [],
) {
  return (
    await readChatHistory({
      entry: boundEntry(sessionId),
      localMessages,
      homeDir,
    })
  ).messages;
}

function writeClaudeEntries(filePath: string, entries: readonly Record<string, unknown>[]) {
  return fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf-8");
}

describe("cli session history", () => {
  it("omits isMeta rows and records internal Claude context provenance", async () => {
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
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

      const messages = await readMessages();

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

  it.each(
    ["", `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\n`].flatMap((driftContext) =>
      ["messages occurred outside this Claude session", "earlier messages in this chat"].map(
        (description) => ({ driftContext, description }),
      ),
    ),
  )(
    "dedupes $description context before optional drift context: $driftContext",
    ({ driftContext, description }) => {
      const prompt = "What token did I give the other model?";
      const localMessage = user(prompt, 1_000, { id: "local-return", senderIsOwner: true });
      const note = `[OpenClaw: 2 ${description} from 2026-10-10T22:30:29.302Z to 2026-10-10T22:30:43.592Z, using "mock/mock-model". Their contents are not included here. Before answering a question that may depend on these messages, call mcp__openclaw__sessions_history({"sessionKey":"agent:main:switch-back","limit":100}) to read them; page older messages with offset if needed.]`;
      const importedMessage = user(
        `${note}\n\n${driftContext}${prompt}`,
        1_001,
        cliMeta("native-return"),
      );
      const before = structuredClone({ localMessage, importedMessage });
      expect(
        mergeImportedChatHistoryMessages({
          localMessages: [localMessage],
          importedMessages: [importedMessage],
        }),
      ).toEqual([
        {
          ...localMessage,
          __openclaw: { ...localMessage["__openclaw"], ...importedMessage["__openclaw"] },
        },
      ]);
      expect({ localMessage, importedMessage }).toEqual(before);
      expect(
        mergeImportedChatHistoryMessages({
          localMessages: [],
          importedMessages: [importedMessage],
        }),
      ).toEqual([importedMessage]);
    },
  );

  it("keeps ordinary matches after an unsuccessful stripped lookup", () => {
    const timestamp = 1_000;
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
  });

  it("does not strip drift notes from non-Claude imports", () => {
    const localMessage = { role: "user", content: "hello", timestamp: 1_000 };
    const importedMessage = {
      role: "user",
      content: `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nhello`,
      timestamp: 1_001,
      __openclaw: {
        importedFrom: "other-cli",
        cliSessionId: "session-1",
        externalId: "native-row",
      },
    };

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [localMessage],
      importedMessages: [importedMessage],
    });

    expect(merged).toEqual([localMessage, importedMessage]);
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
    expect(merged[0]).toEqual(orphanedImport);
    expect(readRecord(readRecord(merged[1])["__openclaw"])).toMatchObject({
      id: localEntryId,
      importedFrom: "claude-cli",
      cliSessionId: "session-1",
      externalId: "image-b",
      media: [{ kind: "image", contentType: "image/png", path: "/media/inbound/b.png" }],
    });
  });

  it("recovers the current user text from legacy reseed envelopes", async () => {
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
      const reseedPrompt = buildLegacyReseedPrompt();
      await writeClaudeEntries(filePath, [claudeUser(reseedPrompt, { uuid: "reseed-user" })]);

      const messages = await readMessages();

      expect(messages).toHaveLength(1);
      expectFields(messages[0], { role: "user", content: "current" });
    });
  });

  it("fails open when the receipt belongs to a different local session", async () => {
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
      const transformedPrompt = "transformed synthetic reseed prompt";
      await writeClaudeEntries(filePath, [
        claudeUser(transformedPrompt, { uuid: "synthetic-reseed" }),
      ]);

      const messages = await readMessages({
        localSessionId: "new-openclaw-session",
        reseedReceipt: receipt(transformedPrompt, "old-openclaw-session"),
      });

      expect(messages).toHaveLength(1);
      expectFields(messages[0], { role: "user", content: transformedPrompt });
    });
  });

  it("suppresses only receipt-matched text while preserving sibling attachments", async () => {
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
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

      const messages = await readMessages({
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
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
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

      const messages = await readMessages({
        localSessionId: "openclaw-session",
        reseedReceipt: receipt(transformedPrompt),
      });

      expect(messages).toHaveLength(2);
      expect(readRecord(messages[0]).content).toEqual(content);
      expectFields(messages[1], { role: "user", content: transformedPrompt });
    });
  });

  it("recovers legacy array-form reseed text while preserving attachments", async () => {
    await withClaudeProjectsDir(async ({ sessionId, filePath, readMessages }) => {
      await writeClaudeEntries(filePath, [
        claudeUser([
          { type: "text", text: buildLegacyReseedPrompt() },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
        ]),
      ]);

      const messages = await readMessages();

      expect(messages).toHaveLength(1);
      expectFields(readRecord(messages[0])["__openclaw"], {
        id: `claude-cli:${sessionId}:line:1`,
      });
      expect(readRecord(messages[0]).content).toEqual([
        { type: "text", text: "current" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ]);
    });
  });

  it("drops empty legacy reseed text while preserving sibling native content", async () => {
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
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

      const messages = await readMessages();

      expect(messages).toHaveLength(1);
      expect(readRecord(messages[0]).content).toEqual([caption, image, document]);
    });
  });

  it.each([
    ["string", buildLegacyReseedPrompt("")],
    ["single text block", [{ type: "text", text: buildLegacyReseedPrompt("") }]],
  ])("drops empty legacy reseed rows in %s form", async (_label, content) => {
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
      await writeClaudeEntries(filePath, [claudeUser(content, { uuid: "legacy-empty-reseed" })]);

      const messages = await readMessages();

      expect(messages).toEqual([]);
    });
  });

  it("fails open when the first user row does not match the reseed receipt", async () => {
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
      const expectedPrompt = "expected synthetic prompt";
      await writeClaudeEntries(filePath, [
        claudeUser("different prompt", { uuid: "unexpected-first-user" }),
        claudeUser(expectedPrompt, { uuid: "later-matching-user" }),
      ]);

      const messages = await readMessages({
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
        expect(await readClaudeCliSessionMessagesAsync({ cliSessionId, homeDir })).toEqual([]);
      }
    });
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

      const messages = await augmentBoundClaudeHistory(homeDir, sessionId, localMessages);

      expect(messages).toHaveLength(1);
      expectFields(readRecord(messages[0])["__openclaw"], {
        importedFrom: "claude-cli",
        externalId: "user-secret-copy",
        cliSessionId: sessionId,
      });
      expect(readRecord(messages[0]).content).toBe(redactedContent);
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

  it.each(["edited", "unchanged"])(
    "keeps drift-note order after an %s exact identity",
    (change) => {
      const laterNote = CLAUDE_RESUME_DRIFT_NOTES[1];
      const earlierLocal = { role: "user", content: "Original ask", timestamp: 1_000 };
      const exactMeta = cliMeta("exact-user");
      const exactLocal = user(
        change === "edited" ? "Edited ask" : "Original ask",
        1_001,
        exactMeta,
      );
      const laterImport = user(`${laterNote}\n\nOriginal ask`, 1_003, {
        ...exactMeta,
        externalId: "later-user",
      });

      const merged = mergeImportedChatHistoryMessages({
        localMessages: [earlierLocal, exactLocal],
        importedMessages: [
          user(
            change === "edited"
              ? `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nOriginal ask`
              : "Original ask",
            1_002,
            exactMeta,
          ),
          laterImport,
        ],
      });

      expect(merged).toEqual([earlierLocal, exactLocal, laterImport]);
    },
  );

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

      const messages = await augmentBoundClaudeHistory(homeDir, sessionId, [
        { role: "user", content: "local visible text" },
      ]);

      expect(messages).toHaveLength(2);
      expect(JSON.stringify(messages)).not.toContain(importedSecret);
    });
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

      const messages = (
        await readChatHistory({
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
          localMessages: [
            {
              role: "user",
              content: "current recovered ask",
              __openclaw: { id: "local-user-1" },
            },
          ],
          homeDir,
        })
      ).messages;

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

  it("consumes repeated-text histories with bounded indexed candidate lookups", () => {
    const timestamp = Date.parse("2026-09-01T10:00:00Z");
    // Cross both the 65-row insert batches and the 256-row ordinal batches.
    const count = 257;
    const localMessages = Array.from({ length: count }, (_, index) => answer(timestamp + index));
    const importedMessages = localMessages.map((message, index) => ({
      ...message,
      timestamp: timestamp + index,
      __openclaw: cliMeta(`external-${index}`),
    }));

    const { merged, executions } = mergeCliHistoryWithLookupStats({
      localMessages,
      importedMessages,
    });

    // Each import probes timestamped text, then undated text if needed.
    expect(executions).toBeGreaterThanOrEqual(count);
    expect(executions).toBeLessThanOrEqual(count * 2);
    expect(
      merged.map((message) => readRecord(readRecord(message)["__openclaw"]).externalId),
    ).toEqual(importedMessages.map((message) => message["__openclaw"].externalId));
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
});

it("keeps lone surrogates distinct from replacement characters in SQLite match keys", () => {
  const local = { role: "assistant", content: "\ud800" };
  const imported = { role: "assistant", content: "\ufffd" };
  expect(
    mergeImportedChatHistoryMessages({ localMessages: [local], importedMessages: [imported] }),
  ).toEqual([local, imported]);
});
