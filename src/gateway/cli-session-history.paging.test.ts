import rawFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  formatCliImageTurnContext,
  hashCliImageTurnEntryId,
} from "../agents/cli-image-turn-correlation.js";
import { buildCliSessionDriftNote } from "../agents/cli-session.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { ChatHistoryPageParams } from "../config/sessions/session-history-types.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../state/openclaw-agent-db-readonly-scope.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { prepareCliSessionHistoryReader, type CliHistoryReaders } from "./cli-session-history.js";
import {
  claudeUser,
  cliMeta,
  LEGACY_EXEC_COMPLETION_PROMPT,
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";
import { readChatHistoryPageKernel } from "./server-methods/chat-history-page-kernel.js";
import { createReadonlySessionHistoryReader } from "./session-history-readonly-reader.js";
import { readChatHistoryMessageId, readChatHistoryMessageSeq } from "./session-history-tail.js";
import { archiveSessionTranscriptPaths } from "./session-transcript-files.fs.js";

async function historyFixture(state: OpenClawTestState, nativeId: string, sessionId: string) {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const entry = {
    sessionId,
    updatedAt: 1,
    cliSessionBindings: { "claude-cli": { sessionId: nativeId } },
  };
  await replaceSessionEntry(scope, entry);
  const header = { type: "session", version: 3, id: sessionId };
  const setEvents = async (events: readonly Record<string, unknown>[]) => {
    await replaceTranscriptEvents(scope, [header, ...events]);
    await waitForSessionTranscriptProjection(scope);
  };
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  const target = {
    transcript: { ...scope, sessionFile: scope.sessionKey },
    database: { agentId: database.agentId, path: database.path },
    entryValidationKey: scope.sessionKey,
  };
  const owner = new OpenClawAgentDatabaseReadOnlyScope();
  const readers = createReadonlySessionHistoryReader(target);
  return { scope, entry, header, setEvents, target, owner, readers };
}
type HistoryFixture = Awaited<ReturnType<typeof historyFixture>>;
type NativeFixture = Parameters<Parameters<typeof withClaudeProjectsDir>[0]>[0];

function withPagingHistory<T>(
  sessionId: string,
  run: (
    fixture: HistoryFixture & NativeFixture & { state: OpenClawTestState; nativeId: string },
  ) => Promise<T>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, (state) =>
    withClaudeProjectsDir(async (nativeFixture) => {
      const nativeId = nativeFixture.sessionId;
      const fixture = await historyFixture(state, nativeId, sessionId);
      try {
        return await run({ ...fixture, ...nativeFixture, state, nativeId });
      } finally {
        fixture.owner.close();
      }
    }),
  );
}

function native(uuid: string, content = uuid, timestamp = 0, role = "assistant") {
  return JSON.stringify({
    type: role,
    uuid,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content },
  });
}

function local(
  id: string,
  parentId: string | null,
  content: string,
  timestamp?: number,
  role = "assistant",
) {
  return { type: "message", id, parentId, message: { role, content, timestamp } };
}

function historyParams(
  { scope, entry }: Pick<HistoryFixture, "scope" | "entry">,
  homeDir: string,
  max = 10,
): ChatHistoryPageParams {
  return {
    entry,
    provider: "claude-cli",
    sessionId: scope.sessionId,
    storePath: scope.storePath,
    sessionAgentId: scope.agentId,
    canonicalKey: scope.sessionKey,
    cliHistoryHomeDir: homeDir,
    max,
    maxHistoryBytes: 64 * 1024,
    effectiveMaxChars: 4096,
    offset: undefined,
    messageId: undefined,
  };
}

async function withCliReader<T>(
  params: ReturnType<typeof historyParams>,
  readers: CliHistoryReaders,
  run: (cli: NonNullable<Awaited<ReturnType<typeof prepareCliSessionHistoryReader>>>) => Promise<T>,
) {
  const cli = await prepareCliSessionHistoryReader(params, readers);
  if (!cli) {
    throw new Error("Expected native history reader");
  }
  try {
    return await run(cli);
  } finally {
    cli.dispose();
  }
}

function readNativePage(params: ReturnType<typeof historyParams>, readers: CliHistoryReaders) {
  return withCliReader(params, readers, (cli) => readPreparedPage(params, cli));
}

function readPreparedPage(
  params: ReturnType<typeof historyParams>,
  cli: NonNullable<Awaited<ReturnType<typeof prepareCliSessionHistoryReader>>>,
) {
  return readChatHistoryPageKernel(params, {
    readers: cli.readers,
    readMessageSequence: cli.sequence,
    deferProfileDisplay: true,
  });
}

it("pages past native interrupts without consuming an identical canonical human turn", async () => {
  await withPagingHistory("cli-interrupts", async (fixture) => {
    const { scope, entry, readers, filePath, homeDir } = fixture;
    const text = "[Request interrupted by user]";
    await fixture.setEvents([local("human", null, text, 2_000, "user")]);
    const userRow = (uuid: string, content: unknown, timestamp: number, promptSource?: string) =>
      JSON.stringify(
        claudeUser(content, {
          uuid,
          timestamp: new Date(timestamp).toISOString(),
          ...(promptSource ? { promptSource } : {}),
        }),
      );
    await fs.writeFile(
      filePath,
      [
        native("before", "Earlier reply", 1_000),
        userRow("interrupt", [{ type: "text", text }], 1_500),
        userRow("native-human", text, 2_001, "sdk"),
        native("after", "Later reply", 3_000),
        userRow(
          "tool-interrupt",
          [{ type: "text", text: "[Request interrupted by user for tool use]" }],
          3_500,
        ),
        userRow("latest", text, 4_000),
      ].join("\n"),
    );
    await fixture.owner.run(fixture.target.database, async () => {
      const params = historyParams({ scope, entry }, homeDir, 2);
      await withCliReader(params, readers, async (cli) => {
        const latest = await readPreparedPage(params, cli);
        const older = await readPreparedPage({ ...params, offset: 2 }, cli);
        expect(latest.messages.map(readChatHistoryMessageId)).toEqual(["after", "latest"]);
        expect(older.messages).toMatchObject([
          { content: "Earlier reply", __openclaw: { id: "before" } },
          { content: text, __openclaw: { id: "human", externalId: "native-human" } },
        ]);
        expect([...older.messages, ...latest.messages].map(cli.sequence)).toEqual([1, 2, 3, 4]);
        const raw = await cli.readers.readRecentSessionMessagesWithStatsAsync(scope, {
          maxMessages: 10,
        });
        expect(raw.totalMessages).toBe(4);
        expect(raw.messages.map(readChatHistoryMessageId)).toEqual([
          "before",
          "human",
          "after",
          "latest",
        ]);
      });
    });
  });
});

it("serves a captured history prefix while both transcripts append and observes the next revision", async () => {
  await withPagingHistory("cli-prefix", async (fixture) => {
    const { scope, entry, readers: base, filePath } = fixture;
    await fixture.setEvents(
      Array.from({ length: 70 }, (_, index) =>
        local(`local-${index + 1}`, index ? `local-${index}` : null, "Local", index + 1),
      ),
    );
    await fs.writeFile(filePath, native("external-prefix"));
    const nativePath = await fs.realpath(filePath);
    const createReadStream = rawFs.createReadStream;
    let nativeAppended = false;
    const stream = vi.spyOn(rawFs, "createReadStream").mockImplementation((file, options) => {
      if (file === nativePath && !nativeAppended) {
        nativeAppended = true;
        rawFs.appendFileSync(filePath, `\n${native("external-appended", undefined, 1000)}`);
      }
      return createReadStream(file, options);
    });
    let localAppended = false;
    const readers = {
      ...base,
      async readSessionMessagesPageWithStatsAsync(
        ...args: Parameters<typeof base.readSessionMessagesPageWithStatsAsync>
      ) {
        const page = await base.readSessionMessagesPageWithStatsAsync(...args);
        if (!localAppended && args[1].captureReadWindow) {
          localAppended = true;
          await appendTranscriptMessage(scope, {
            eventId: "local-appended",
            message: { role: "assistant", content: "Local appended", timestamp: 1001 },
          });
        }
        return page;
      },
    };
    const params = historyParams({ scope, entry }, fixture.homeDir, 4);
    const read = () =>
      fixture.owner.run(fixture.target.database, () => readNativePage(params, readers));
    try {
      const first = await read();
      expect(first.messages.map(readChatHistoryMessageId)).toEqual([
        "local-67",
        "local-68",
        "local-69",
        "local-70",
      ]);
      expect(first.activeLeafEntryId).toBe("local-70");
      const next = await read();
      expect(next.messages.map(readChatHistoryMessageId)).toEqual([
        "local-69",
        "local-70",
        "external-appended",
        "local-appended",
      ]);
      expect(next.activeLeafEntryId).toBe("local-appended");
    } finally {
      stream.mockRestore();
    }
  });
});

it("applies native history eligibility to actual empty, message, and marker-only source pages", async () => {
  await withPagingHistory("cli-eligibility", async (fixture) => {
    const { scope, entry, readers } = fixture;
    const message = local("local", null, "Local answer");
    const marker = {
      type: "compaction",
      id: "compact",
      parentId: null,
      summary: "Compacted",
      tokensBefore: 100,
      firstKeptEntryId: null,
    };
    for (const cell of [
      { provider: "claude-cli", events: [message], imported: true },
      { provider: "anthropic", events: [message], imported: true },
      { provider: "openai", events: [message], imported: false },
      { provider: "openai", events: [marker], imported: false },
      { provider: "openai", events: [], imported: true },
    ]) {
      await fixture.setEvents(cell.events);
      await fixture.owner.run(fixture.target.database, async () => {
        const cli = await prepareCliSessionHistoryReader(
          {
            ...historyParams({ scope, entry }, fixture.homeDir),
            provider: cell.provider,
          },
          readers,
        );
        try {
          expect(
            Boolean(cli),
            `${cell.provider} with ${cell.events[0]?.type ?? "empty"} history`,
          ).toBe(cell.imported);
          if (cli) {
            const page = await cli.readers.readRecentSessionMessagesWithStatsAsync(scope, {
              maxMessages: 10,
            });
            expect(page.messages).toContainEqual(
              expect.objectContaining({
                __openclaw: expect.objectContaining({ cliSessionId: fixture.nativeId }),
              }),
            );
          }
        } finally {
          cli?.dispose();
        }
      });
    }
  });
});

it("observes newly available reset archives and refuses changed archive bodies under older identities", async () => {
  await withPagingHistory("cli-archive", async (fixture) => {
    const { scope, entry, readers } = fixture;
    await fixture.setEvents([]);
    await fs.writeFile(fixture.filePath, native("native-only", "Native body", 1));
    const params = historyParams({ scope, entry }, fixture.homeDir);
    const read = () => readNativePage(params, readers);
    const archive = (id: string, content: string) =>
      [fixture.header, local(id, null, content, 0)]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n";
    await fixture.owner.run(fixture.target.database, async () => {
      const revision = readers.readHistoryRevision();
      expect((await read()).messages.map(readChatHistoryMessageId)).toEqual(["native-only"]);
      const legacyPath = path.join(fixture.state.sessionsDir(), `${scope.sessionId}.jsonl`);
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(legacyPath, archive("retained", "Retained body"));
      const archived = archiveSessionTranscriptPaths({
        paths: [legacyPath],
        reason: "reset",
      })[0];
      if (!archived) {
        throw new Error("Expected reset archive fixture");
      }
      expect(readers.readHistoryRevision()).toMatchObject({
        generation: revision.generation,
        indexedSeq: revision.indexedSeq,
      });
      expect((await read()).messages.map(readChatHistoryMessageId)).toEqual([
        "retained",
        "native-only",
      ]);

      await withCliReader(params, readers, async (cli) => {
        const replacement = `${archived.archivedPath}.replacement`;
        await fs.writeFile(replacement, archive("replacement", "Replacement body"));
        await fs.rename(replacement, archived.archivedPath);
        await expect(readPreparedPage(params, cli)).rejects.toMatchObject({
          name: "SessionTranscriptProjectionUnavailableError",
          reason: "window-changed",
        });
      });
      const refreshed = await read();
      expect(refreshed.messages).toMatchObject([
        { content: "Replacement body", __openclaw: { id: "replacement" } },
        { __openclaw: { id: "native-only" } },
      ]);
    });
  });
});

it.each([
  "resume",
  "legacy hint",
  "legacy context",
  "legacy resume",
  "legacy hint CRLF",
  "legacy context CRLF",
])("matches original native text and cleans unmatched imports with %s", async (decoration) => {
  const kind = decoration.replace(" CRLF", "");
  await withPagingHistory("cli-generated-prefixes", async (fixture) => {
    const { scope, entry, readers } = fixture;
    const note = buildCliSessionDriftNote(["prompt-tools"]);
    const hint =
      'requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.\n\n';
    const context =
      'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"requester_profile":{"id":"owner","display_name":"Owner"}}\n```\n\n';
    const prefix = (
      kind === "resume"
        ? `${note}\n\n`
        : kind === "legacy hint"
          ? hint
          : kind === "legacy context"
            ? context + hint
            : `${note}\n\n${context}${hint}`
    ).replaceAll("\n", decoration.endsWith("CRLF") ? "\r\n" : "\n");
    const literal = `${prefix}hello`;
    const plain =
      kind === "legacy context"
        ? context.replace("}}", '},"requester_profile_hint":"current"}') + "hello"
        : "hello";
    const events = "System: [2026-10-04 13:15:44 GMT+8] Model switched.\n\n";
    await fixture.setEvents([
      local("plain", null, plain, 1_000, "user"),
      local("literal", "plain", literal, 2_000, "user"),
      local("question", "literal", "real question", 3_000, "user"),
    ]);
    const nativeUser = (uuid: string, content: string, timestamp: number) =>
      native(uuid, content, timestamp, "user");
    await fs.writeFile(
      fixture.filePath,
      [
        nativeUser("native-literal", literal, 1_001),
        nativeUser(
          "native-plain",
          kind === "legacy context" ? `${prefix}${events}hello` : "hello",
          2_001,
        ),
        nativeUser("native-question", `${prefix}${events}real question`, 3_001),
        nativeUser("native-unmatched", `${prefix}${events}only in the native file`, 4_000),
        nativeUser("native-exec", `${events}${LEGACY_EXEC_COMPLETION_PROMPT}`, 5_000),
      ].join("\n"),
    );
    await fixture.owner.run(fixture.target.database, async () => {
      await withCliReader(
        historyParams({ scope, entry }, fixture.homeDir),
        readers,
        async (cli) => {
          const page = await cli.readers.readRecentSessionMessagesWithStatsAsync(scope, {
            maxMessages: 10,
          });
          expect(page.messages).toMatchObject([
            { content: plain, __openclaw: { id: "plain", externalId: "native-plain" } },
            { content: literal, __openclaw: { id: "literal", externalId: "native-literal" } },
            { content: "real question", __openclaw: { id: "question" } },
            {
              content: "only in the native file",
              __openclaw: { externalId: "native-unmatched" },
            },
            { display: false, provenance: { kind: "internal_system", sourceTool: "exec" } },
          ]);
        },
      );
    });
  });
});

it("pages merged incognito CLI history without allocating SQLite", async () => {
  await withClaudeProjectsDir(async ({ homeDir, sessionId: nativeId, filePath }) => {
    const scope = {
      agentId: "main",
      sessionId: "cli-memory",
      sessionKey: "agent:main:incognito:cli-memory",
      storePath: path.join(homeDir, "sessions.json"),
    };
    const media = [{ kind: "image", contentType: "image/png", path: "/media/inbound/test.png" }];
    const nativePhoto = `Photo\n\n${formatCliImageTurnContext(hashCliImageTurnEntryId("photo"))}\n\n@/tmp/openclaw/openclaw-cli-images/${"a".repeat(64)}.png`;
    const turns = [
      ["first", "native-first", "user", "repeat", "repeat"],
      ["edited", "known", "assistant", "locally edited", "original answer"],
      ["second", "native-second", "user", "repeat", "repeat"],
      ["photo", "native-photo", "user", "Photo", nativePhoto],
    ] as const;
    const memoryMessages = turns.map(([id, externalId, role, content], index) => ({
      role,
      content,
      timestamp: (index + 1) * 1000,
      __openclaw: {
        id,
        seq: index + 1,
        ...(id === "edited" ? cliMeta(externalId, nativeId) : {}),
        ...(id === "photo" ? { media } : {}),
      },
    }));
    await fs.writeFile(
      filePath,
      [
        ...turns.map(([, externalId, role, , content], index) =>
          native(externalId, content, (index + 1) * 1000 + 1, role),
        ),
        native("native-only", "Native only", 5000),
      ].join("\n"),
    );
    const unusedReader = async (): Promise<never> => {
      throw new Error("Unexpected canonical lookup");
    };
    const readers: CliHistoryReaders = {
      readSessionMessagesPageWithStatsAsync: async (_scope, options) => ({
        messages: memoryMessages
          .filter(
            (message) => readChatHistoryMessageSeq(message)! < (options.beforeSeq ?? Infinity),
          )
          .slice(-options.maxMessages),
        totalMessages: memoryMessages.length,
        transcriptSource: "active",
        displaySource: "memory",
        activeLeafEntryId: "photo",
      }),
      readRecentSessionMessagesWithStatsAsync: unusedReader,
      readSessionMessagesAroundIdWithStatsAsync: unusedReader,
      readSessionMessageByIdAsync: unusedReader,
    };
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation(() => {
      throw new Error("Incognito history must not allocate SQLite");
    });
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      incognito: true,
      cliSessionBindings: { "claude-cli": { sessionId: nativeId } },
    };
    try {
      await withCliReader(historyParams({ scope, entry }, homeDir, 3), readers, async (cli) => {
        const read = (offset: number) =>
          cli.readers.readSessionMessagesPageWithStatsAsync(scope, { offset, maxMessages: 3 });
        const latest = await read(0);
        expect(latest.totalMessages).toBe(5);
        expect(latest.messages).toMatchObject([
          { content: "repeat", __openclaw: { id: "second", externalId: "native-second" } },
          {
            content: "Photo",
            __openclaw: {
              id: "photo",
              externalId: "native-photo",
              media,
            },
          },
          { content: "Native only", __openclaw: { id: "native-only" } },
        ]);
        const older = await read(3);
        expect(older.messages).toMatchObject([
          { content: "repeat", __openclaw: { id: "first", externalId: "native-first" } },
          { content: "locally edited", __openclaw: { id: "edited", externalId: "known" } },
        ]);
        expect([...older.messages, ...latest.messages].map(cli.sequence)).toEqual([1, 2, 3, 4, 5]);
        expect(open).not.toHaveBeenCalled();
      });
    } finally {
      open.mockRestore();
    }
  });
});
