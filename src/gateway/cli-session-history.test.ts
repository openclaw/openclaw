import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  formatCliImageTurnContext,
  hashCliImageTurnEntryId,
} from "../agents/cli-image-turn-correlation.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import { sanitizeTranscriptMessage } from "../agents/transcript-sanitize.js";
import { MemoryCliSessionHistoryIndex } from "./cli-session-history-index-memory.js";
import { CliSessionHistoryIndex } from "./cli-session-history-index.worker.js";
import { mergeCliHistoryWithLookupStats } from "./cli-session-history-lookup.test-support.js";
import {
  readClaudeCliSessionMessagesAsync,
  mergeImportedChatHistoryMessages,
  answer,
  buildLegacyReseedPrompt,
  claudeUser,
  cliMeta,
  receipt,
  user,
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";
import { requireGatewayRecord } from "./test-helpers.assertions.js";

const CLAUDE_RESUME_DRIFT_NOTES = [
  "OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=system-prompt.",
  "OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=prompt-tools.",
  "OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=system-prompt,prompt-tools.",
] as const;

const readRecord = (value: unknown) => requireGatewayRecord(value, "record");
function readBoundHistory(
  entries: readonly Record<string, unknown>[],
  localMessages: unknown[],
  reseedReceipt?: ReturnType<typeof receipt>,
) {
  return withClaudeProjectsDir(async ({ filePath, readMessages, sessionId }) => {
    await writeClaudeEntries(filePath, entries);
    const imported = await readMessages({ localSessionId: "openclaw-session", reseedReceipt });
    return { messages: merge(localMessages, imported), sessionId };
  });
}

function merge(localMessages: unknown[], importedMessages: unknown[]) {
  return mergeImportedChatHistoryMessages({ localMessages, importedMessages });
}

function imageTurn(id: string, content: string, timestamp: number, filename: string) {
  return user(content, timestamp, {
    id,
    media: [{ kind: "image", contentType: "image/png", path: `/media/inbound/${filename}.png` }],
  });
}

function imagePrompt(id: string, hash = "a") {
  return `${formatCliImageTurnContext(hashCliImageTurnEntryId(id))}\n\n@/tmp/openclaw/openclaw-cli-images/${hash.repeat(64)}.png`;
}

function expectDeduped(
  localMessage: ReturnType<typeof user>,
  importedMessage: ReturnType<typeof user>,
) {
  const before = structuredClone({ localMessage, importedMessage });
  expect(merge([localMessage], [importedMessage])).toEqual([
    {
      ...localMessage,
      __openclaw: { ...localMessage["__openclaw"], ...importedMessage["__openclaw"] },
    },
  ]);
  expect({ localMessage, importedMessage }).toEqual(before);
}

function writeClaudeEntries(filePath: string, entries: readonly Record<string, unknown>[]) {
  return fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf-8");
}

function readImportedHistory(
  entries: readonly Record<string, unknown>[],
  options?: Omit<
    Parameters<typeof readClaudeCliSessionMessagesAsync>[0],
    "cliSessionId" | "homeDir"
  >,
) {
  return withClaudeProjectsDir(async ({ filePath, readMessages, sessionId }) => {
    await writeClaudeEntries(filePath, entries);
    return { messages: await readMessages(options), sessionId };
  });
}

const nativeImage = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "x" },
};
const nativeReply = {
  type: "assistant",
  uuid: "assistant-1",
  message: { role: "assistant", content: "response" },
};
const transformedPrompt = "transformed synthetic reseed prompt";
const reseedOptions = {
  localSessionId: "openclaw-session",
  reseedReceipt: receipt(transformedPrompt),
};
const extraReseedText = [
  { type: "text", text: transformedPrompt },
  { type: "text", text: "real extra user text" },
  nativeImage,
];
const caption = { type: "text", text: "real caption" };
const document = { type: "document", source: { type: "text", data: "notes" } };

describe("cli session history", () => {
  it("omits isMeta rows and records internal Claude context provenance", async () => {
    const notification =
      "<task-notification>\n<task-id>task-1</task-id>\n<status>completed</status>\n<summary>Background review finished.</summary>\n</task-notification>";
    const { messages } = await readImportedHistory([
      claudeUser("run the review", { uuid: "operator-1" }),
      claudeUser([{ type: "text", text: "Base directory for this skill" }], {
        isMeta: true,
        sourceToolUseID: "toolu_skill",
      }),
      claudeUser("This session is being continued from a previous conversation.", {
        isCompactSummary: true,
      }),
      claudeUser("Transcript-only synthetic context row.", { isVisibleInTranscriptOnly: true }),
      claudeUser(notification, { origin: { kind: "task-notification" } }),
      claudeUser(notification, { uuid: "operator-pasted-xml-1" }),
    ]);

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
    expectDeduped(localMessage, importedMessage);
  });

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

    const merged = merge(localMessages, [
      user(literal, 1_002, literalMeta),
      repeatedImport,
      user("hello", 1_004, plainMeta),
    ]);

    expect(merged).toEqual([
      { ...localMessages[0], __openclaw: plainMeta },
      { ...localMessages[1], __openclaw: literalMeta },
      repeatedImport,
    ]);
  });

  it("does not strip drift notes from non-Claude imports", () => {
    const localMessage = { role: "user", content: "hello", timestamp: 1_000 };
    const importedMessage = user(`${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nhello`, 1_001, {
      importedFrom: "other-cli",
      cliSessionId: "session-1",
      externalId: "native-row",
    });

    expect(merge([localMessage], [importedMessage])).toEqual([localMessage, importedMessage]);
  });

  it("matches image-only imports to their exact local turns", () => {
    const timestamp = Date.parse("2026-03-26T16:29:54.500Z");
    const localEntryId = "local-image-b";
    const orphanedImport = user(imagePrompt("local-image-a"), timestamp, cliMeta("image-a"));
    const matchedImport = user(
      imagePrompt(localEntryId, "b"),
      timestamp + 60_000,
      cliMeta("image-b"),
    );
    const localMessage = imageTurn(localEntryId, "", timestamp + 60_000, "b");
    const merged = merge([localMessage], [orphanedImport, matchedImport]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(orphanedImport);
    expect(readRecord(readRecord(merged[1])["__openclaw"])).toMatchObject({
      id: localEntryId,
      ...cliMeta("image-b"),
      media: [{ kind: "image", contentType: "image/png", path: "/media/inbound/b.png" }],
    });
  });

  it.each([
    {
      name: "recovers the current user text from legacy reseed envelopes",
      entries: [claudeUser(buildLegacyReseedPrompt(), { uuid: "reseed-user" })],
      expected: [user("current")],
    },
    {
      name: "fails open when the receipt belongs to a different local session",
      entries: [claudeUser(transformedPrompt, { uuid: "synthetic-reseed" })],
      options: {
        localSessionId: "new-openclaw-session",
        reseedReceipt: receipt(transformedPrompt, "old-openclaw-session"),
      },
      expected: [user(transformedPrompt)],
    },
    {
      name: "suppresses only receipt-matched text while preserving sibling attachments",
      entries: [
        claudeUser([{ type: "text", text: transformedPrompt }, nativeImage], {
          uuid: "synthetic-reseed",
        }),
        nativeReply,
      ],
      options: reseedOptions,
      expected: [user([nativeImage]), { role: "assistant", content: "response" }],
    },
    {
      name: "preserves receipt-matched arrays with multiple text blocks",
      entries: [
        claudeUser(extraReseedText, { uuid: "synthetic-reseed" }),
        claudeUser(transformedPrompt, { uuid: "later-exact-match" }),
      ],
      options: reseedOptions,
      expected: [user(extraReseedText), user(transformedPrompt)],
    },
    {
      name: "drops empty legacy reseed text while preserving sibling native content",
      entries: [
        claudeUser(
          [caption, { type: "text", text: buildLegacyReseedPrompt("") }, nativeImage, document],
          { uuid: "legacy-empty-reseed" },
        ),
      ],
      expected: [user([caption, nativeImage, document])],
    },
    {
      name: "fails open when the first user row does not match the reseed receipt",
      entries: [
        claudeUser("different prompt", { uuid: "unexpected-first-user" }),
        claudeUser(transformedPrompt, { uuid: "later-matching-user" }),
      ],
      options: reseedOptions,
      expected: [user("different prompt"), user(transformedPrompt)],
    },
  ])("$name", async ({ entries, options, expected }) => {
    const { messages } = await readImportedHistory(entries, options);
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual(expected);
  });

  it("recovers legacy array-form reseed text while preserving attachments", async () => {
    const { messages, sessionId } = await readImportedHistory([
      claudeUser([{ type: "text", text: buildLegacyReseedPrompt() }, nativeImage]),
    ]);
    expect(messages).toHaveLength(1);
    expect(readRecord(messages[0])["__openclaw"]).toMatchObject({
      id: `claude-cli:${sessionId}:line:1`,
    });
    expect(readRecord(messages[0]).content).toEqual([
      { type: "text", text: "current" },
      nativeImage,
    ]);
  });

  it.each([
    ["string", buildLegacyReseedPrompt("")],
    ["single text block", [{ type: "text", text: buildLegacyReseedPrompt("") }]],
  ])("drops empty legacy reseed rows in %s form", async (_label, content) => {
    const { messages } = await readImportedHistory([
      claudeUser(content, { uuid: "legacy-empty-reseed" }),
    ]);
    expect(messages).toEqual([]);
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
    const secretText = "key is sk-abcdef1234567890xyz";
    const localMessage = sanitizeTranscriptMessage({
      role: "user",
      content: secretText,
    } as AgentMessage);
    const redactedContent = readRecord(localMessage).content;
    expect(typeof redactedContent).toBe("string");
    const { messages, sessionId } = await readBoundHistory(
      [
        claudeUser(`${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\n${secretText}`, {
          uuid: "user-secret-copy",
          timestamp: "2026-03-26T16:29:54.800Z",
        }),
      ],
      [localMessage],
    );
    expect(messages).toHaveLength(1);
    expect(readRecord(messages[0])["__openclaw"]).toMatchObject({
      importedFrom: "claude-cli",
      externalId: "user-secret-copy",
      cliSessionId: sessionId,
    });
    expect(readRecord(messages[0]).content).toBe(redactedContent);
  });

  it("reserves later exact identities before earlier fuzzy imports", () => {
    const timestamp = Date.parse("2026-09-01T10:00:00Z");
    const exact = answer(timestamp, "exact-id", null);
    const merged = merge([exact, answer(timestamp)], [answer(timestamp), exact, answer(timestamp)]);

    expect(merged).toEqual([exact, answer(timestamp), answer(timestamp)]);
  });

  it.each(["edited", "unchanged", "image"])(
    "keeps drift-note order after an %s exact identity",
    (change) => {
      const laterNote = CLAUDE_RESUME_DRIFT_NOTES[1];
      const earlierLocal = user("Original ask", 1_000);
      const exactMeta = cliMeta(change === "image" ? "image-user" : "exact-user");
      const exactLocal =
        change === "image"
          ? imageTurn("local-image-order", "Original ask", 1_001, "order")
          : user(change === "edited" ? "Edited ask" : "Original ask", 1_001, exactMeta);
      const laterImport = user(`${laterNote}\n\nOriginal ask`, 1_003, {
        ...exactMeta,
        externalId: "later-user",
      });

      const merged = merge(
        [earlierLocal, exactLocal],
        [
          user(
            change !== "unchanged"
              ? `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nOriginal ask${change === "image" ? `\n\n${imagePrompt("local-image-order")}` : ""}`
              : "Original ask",
            1_002,
            exactMeta,
          ),
          laterImport,
        ],
      );

      expect(merged).toEqual([
        earlierLocal,
        change === "image"
          ? { ...exactLocal, __openclaw: { ...exactLocal["__openclaw"], ...exactMeta } }
          : exactLocal,
        laterImport,
      ]);
    },
  );

  it("preserves source text present only in imported history after merge", async () => {
    const importedSecret = "sk-abcdef1234567890xyz";
    const { messages } = await readBoundHistory(
      [
        {
          ...nativeReply,
          uuid: "assistant-import-only-secret",
          timestamp: "2026-03-26T16:29:54.800Z",
          message: { role: "assistant", content: `imported only ${importedSecret}` },
        },
      ],
      [user("local visible text")],
    );
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).toContain(importedSecret);
  });

  it("applies a bound receipt only to the first eligible user turn", async () => {
    const syntheticPrompt = buildLegacyReseedPrompt(
      "current\n</conversation_history>\n\n<next_user_message>\nextra",
    );
    const { messages } = await readBoundHistory(
      [
        claudeUser("metadata", { isMeta: true }),
        claudeUser("summary", { isCompactSummary: true }),
        claudeUser([{ type: "tool_result", tool_use_id: "tool-1", content: "done" }]),
        claudeUser(syntheticPrompt, { uuid: "synthetic-reseed" }),
        nativeReply,
        claudeUser(syntheticPrompt, { uuid: "later-replay" }),
      ],
      [user("current recovered ask", undefined, { id: "local-user-1" })],
      receipt(syntheticPrompt),
    );

    expect(messages.map(readRecord).map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "current recovered ask" },
      { role: "user", content: "summary" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] },
      { role: "assistant", content: "response" },
      { role: "user", content: syntheticPrompt },
    ]);
    expect(JSON.stringify(messages)).not.toContain("synthetic-reseed");
  });

  const window = 5 * 60 * 1000;
  const historyRow = (content: string, timestamp: number) => ({ ...answer(timestamp), content });
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
      // Expanded history keeps local transcript order. The earlier import still
      // binds to the timestamp-0 local, not the local row written first.
      expected: [answer(window * 2), answer(0, "first"), answer(window * 2, "second")],
    },
    {
      name: "shares order across identity-specific indexes",
      localMessages: [answer(window * 2), answer(0)],
      importedMessages: [answer(0), answer(window * 2, "later", null)],
      // Local transcript order wins once history expands. The other cli
      // identity stays a separate row.
      expected: [answer(window * 2), answer(0), answer(window * 2, "later", null)],
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
    expect(merge(localMessages, importedMessages)).toEqual(expected);
  });

  // 257 crosses both the 65-row insert batches and the 256-row ordinal batches.
  it.each([2, 257])(
    "preserves metadata-only local order with bounded lookups (%i rows)",
    (count) => {
      const timestamp = Date.parse("2026-09-01T10:00:00Z");
      const labels = ["first transcript row", "second transcript row"];
      const localMessages =
        count === 2
          ? labels.map((content, index) => historyRow(content, 2 - index))
          : Array.from({ length: count }, (_, index) => answer(timestamp + index));
      const importedMessages = localMessages.map((message, index) => ({
        ...message,
        __openclaw: cliMeta(`external-${index}`),
      }));

      const { merged, executions } = mergeCliHistoryWithLookupStats({
        localMessages,
        importedMessages,
      });

      if (count === 257) {
        expect(executions).toBeGreaterThanOrEqual(count);
        expect(executions).toBeLessThanOrEqual(count * 2);
      } else {
        expect(merged.map((message) => readRecord(message).content)).toEqual(labels);
      }
      expect(
        merged.map((message) => readRecord(readRecord(message)["__openclaw"]).externalId),
      ).toEqual(importedMessages.map((message) => message["__openclaw"].externalId));
    },
  );

  it("does not reuse a text-consumed local row for image deduplication", () => {
    const localEntryId = "local-image-row";
    const timestamp = Date.parse("2026-09-01T10:00:00Z");
    const localMessage = imageTurn(localEntryId, "look at this", timestamp, "a");
    const textImport = user("look at this", timestamp, cliMeta("text-import"));
    const imageImport = user(
      `look at this\n\n${imagePrompt(localEntryId)}`,
      timestamp + 1,
      cliMeta("image-import"),
    );

    expect(merge([localMessage], [textImport, imageImport])).toMatchObject([
      { __openclaw: { externalId: "text-import" } },
      { __openclaw: { externalId: "image-import" } },
    ]);
  });

  it.each([
    {
      name: "keeps earlier imports before a backdated local's preceding answer",
      localMessages: [200, 100, 300].map((t) => historyRow(`local ${t}`, t)),
      imported: [50, 150, 200, 250].map((t) => historyRow(`import ${t}`, t)),
      expected: [
        "import 50",
        "import 150",
        "local 200",
        "local 100",
        "import 200",
        "import 250",
        "local 300",
      ],
    },
    {
      name: "splices unmatched imports in timestamp order without moving local rows",
      localMessages: [200, 300, 0, 400, 500, 600].map((t) => historyRow(`local ${t}`, t)),
      imported: [150, 100].map((t) => historyRow(`import ${t}`, t)),
      expected: [
        "import 100",
        "import 150",
        "local 200",
        "local 300",
        "local 0",
        "local 400",
        "local 500",
        "local 600",
      ],
    },
  ])(
    "$name when an import expands history in both indexes",
    ({ localMessages, imported, expected }) => {
      for (const Index of [CliSessionHistoryIndex, MemoryCliSessionHistoryIndex]) {
        const contents = mergeImportedChatHistoryMessages(
          { localMessages, importedMessages: imported },
          new Index(),
        ).map((message) => readRecord(message).content);
        expect(contents).toEqual(expected);
      }
    },
  );
});

it("keeps lone surrogates distinct from replacement characters in SQLite match keys", () => {
  const local = { role: "assistant", content: "\ud800" };
  const imported = { role: "assistant", content: "\ufffd" };
  expect(merge([local], [imported])).toEqual([local, imported]);
});

it.each([
  ["covered", [], 1],
  ["identity", [], 1],
  ["uuidless", [], 1],
  ["undated", [], 1],
  ["partial", ["covered"], 1],
  ["audio", ["covered"], 1],
  ["ambiguous", ["earlier", "covered"], 2],
  ["identified", ["earlier"], 2],
  ["separate-window", ["earlier"], 2],
  ["resume", [], 1],
  ["image", [], 1],
  ["retry", ["retry"], 1],
  ["tool-result", [], 2],
  ["thinking", [], 1],
  ["other-backend", ["covered"], 1],
] as const)("reconciles native aggregate coverage: %s", (mode, retained, userCount) => {
  const at = mode === "undated" ? undefined : mode === "separate-window" ? 600_001 : 1_000;
  const timestamp = (offset: number) => (at === undefined ? undefined : at + offset);
  const meta = (externalId: string) => ({
    importedFrom: mode === "other-backend" ? "codex" : "claude-cli",
    cliSessionId: "session-1",
    ...(mode === "uuidless" ? {} : { externalId }),
  });
  const prompt =
    mode === "image"
      ? imageTurn("coverage-image", "question", 1_000, "coverage")
      : user(
          "question",
          mode === "identified" ? undefined : at,
          mode === "identity" ? meta("native-user") : undefined,
        );
  const aggregate: Record<string, unknown> = {
    ...answer(timestamp(3)),
    content: "Checking. Done.",
    idempotencyKey: "cli-assistant:covered",
  };
  if (mode === "identity") {
    aggregate["__openclaw"] = { idempotencyKey: aggregate.idempotencyKey };
    delete aggregate.idempotencyKey;
  }
  if (mode === "audio") {
    aggregate.openclawDisplayContent = [{ type: "audio", url: "/managed-audio" }];
  }
  if (mode === "thinking") {
    aggregate.content = [
      { type: "text", text: "Checking. Done." },
      { type: "thinking", thinking: "Internal reasoning." },
    ];
  }
  const localMessages: unknown[] = [prompt, aggregate];
  if (mode === "ambiguous" || mode === "identified" || mode === "separate-window") {
    localMessages.unshift(
      user("question", 1_000, mode === "identified" ? cliMeta("earlier-user") : undefined),
      { ...aggregate, idempotencyKey: "cli-assistant:earlier" },
    );
  }
  if (mode === "retry") {
    localMessages.push({ ...aggregate, idempotencyKey: "cli-assistant:retry" });
  }
  const nativePrompt =
    mode === "image"
      ? `Different caption\n\n${imagePrompt("coverage-image")}`
      : mode === "resume"
        ? `${CLAUDE_RESUME_DRIFT_NOTES[0]}\n\nquestion`
        : mode === "identity"
          ? "rewritten question"
          : "question";
  const imported: unknown[] = [
    user(nativePrompt, at, meta("native-user")),
    ...["Checking.", "Done."].map((content, index) => ({
      role: "assistant",
      timestamp: timestamp(index + 1),
      content:
        mode === "tool-result" && index === 0
          ? [
              { type: "text", text: content },
              { type: "toolcall", id: "calc", name: "calc", arguments: {} },
            ]
          : content,
      __openclaw: meta(`segment-${index}`),
    })),
  ];
  if (mode === "partial") {
    imported.pop();
  }
  if (mode === "tool-result") {
    imported.splice(
      2,
      0,
      user(
        [{ type: "tool_result", tool_use_id: "calc", content: "4" }],
        timestamp(2),
        meta("tool-result"),
      ),
    );
  }
  const merged = merge(localMessages, imported);
  const keys = merged
    .map(readRecord)
    .map(
      (message) =>
        message.idempotencyKey ?? asOptionalRecord(message["__openclaw"])?.idempotencyKey,
    )
    .filter((key) => typeof key === "string" && key.startsWith("cli-assistant:"));
  expect(keys).toEqual(retained.map((key) => `cli-assistant:${key}`));
  expect(merged).toEqual(expect.arrayContaining(imported.slice(1)));
  expect(merged.filter((message) => readRecord(message).role === "user")).toHaveLength(userCount);
});
