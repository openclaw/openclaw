import rawFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { captureTranscriptRedactionSnapshot } from "../agents/transcript-redact-text.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../state/openclaw-agent-db-readonly-scope.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareCliSessionHistoryReader } from "./cli-session-history.js";
import { withClaudeProjectsDir } from "./cli-session-history.test-support.js";
import { readChatHistoryPageKernel } from "./server-methods/chat-history-page-kernel.js";
import { createReadonlySessionHistoryReader } from "./session-history-readonly-reader.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import { archiveSessionTranscriptPaths } from "./session-transcript-files.fs.js";

it("serves a captured history prefix while both transcripts append and observes the next revision", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId: nativeId, filePath }) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cli-prefix",
        sessionId: "cli-prefix",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: nativeId } },
      };
      await replaceSessionEntry(scope, entry);
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        ...Array.from({ length: 70 }, (_, index) => ({
          type: "message",
          id: `local-${index + 1}`,
          parentId: index ? `local-${index}` : null,
          message: { role: "assistant", content: `Local ${index + 1}`, timestamp: index + 1 },
        })),
      ]);
      await waitForSessionTranscriptProjection(scope);
      const native = (id: string, timestamp: number) =>
        JSON.stringify({
          type: "assistant",
          uuid: id,
          timestamp: new Date(timestamp).toISOString(),
          message: { role: "assistant", content: id },
        });
      await fs.writeFile(filePath, native("external-prefix", 0));
      const nativePath = await fs.realpath(filePath);
      const createReadStream = rawFs.createReadStream;
      let nativeAppended = false;
      const stream = vi.spyOn(rawFs, "createReadStream").mockImplementation((file, options) => {
        if (file === nativePath && !nativeAppended) {
          nativeAppended = true;
          rawFs.appendFileSync(filePath, `\n${native("external-appended", 1000)}`);
        }
        return createReadStream(file, options);
      });
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const target = {
        transcript: { ...scope, sessionFile: scope.sessionKey },
        database: { agentId: database.agentId, path: database.path },
        entryValidationKey: scope.sessionKey,
      };
      const owner = new OpenClawAgentDatabaseReadOnlyScope();
      const base = createReadonlySessionHistoryReader(target);
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
      const params = {
        entry,
        provider: "claude-cli",
        sessionId: scope.sessionId,
        storePath: scope.storePath,
        sessionAgentId: scope.agentId,
        canonicalKey: scope.sessionKey,
        cliHistoryHomeDir: homeDir,
        cliHistoryRedaction: captureTranscriptRedactionSnapshot(),
        max: 4,
        maxHistoryBytes: 64 * 1024,
        effectiveMaxChars: 4096,
        offset: undefined,
        messageId: undefined,
      };
      const read = () =>
        owner.run(target.database, async () => {
          const cli = await prepareCliSessionHistoryReader(params, readers);
          if (!cli) {
            throw new Error("Expected native history reader");
          }
          try {
            return await readChatHistoryPageKernel(params, {
              readers: cli.readers,
              readMessageSequence: cli.sequence,
              deferProfileDisplay: true,
            });
          } finally {
            cli.dispose();
          }
        });
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
        owner.close();
      }
    });
  });
});

it("applies native history eligibility to actual empty, message, and marker-only source pages", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId: nativeId }) => {
      const scope = {
        agentId: "main",
        sessionId: "cli-eligibility",
        sessionKey: "agent:main:cli-eligibility",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: nativeId } },
      };
      await replaceSessionEntry(scope, entry);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const target = {
        transcript: { ...scope, sessionFile: scope.sessionKey },
        database: { agentId: database.agentId, path: database.path },
        entryValidationKey: scope.sessionKey,
      };
      const owner = new OpenClawAgentDatabaseReadOnlyScope();
      const readers = createReadonlySessionHistoryReader(target);
      const message = {
        type: "message",
        id: "local",
        parentId: null,
        message: { role: "assistant", content: "Local answer" },
      };
      const marker = {
        type: "compaction",
        id: "compact",
        parentId: null,
        summary: "Compacted",
        tokensBefore: 100,
        firstKeptEntryId: null,
      };
      try {
        for (const cell of [
          { provider: "claude-cli", events: [message], imported: true },
          { provider: "anthropic", events: [message], imported: true },
          { provider: "openai", events: [message], imported: false },
          { provider: "openai", events: [marker], imported: false },
          { provider: "openai", events: [], imported: true },
        ]) {
          await replaceTranscriptEvents(scope, [
            { type: "session", version: 3, id: scope.sessionId },
            ...cell.events,
          ]);
          await waitForSessionTranscriptProjection(scope);
          await owner.run(target.database, async () => {
            const cli = await prepareCliSessionHistoryReader(
              {
                entry,
                provider: cell.provider,
                sessionId: scope.sessionId,
                storePath: scope.storePath,
                sessionAgentId: scope.agentId,
                canonicalKey: scope.sessionKey,
                cliHistoryHomeDir: homeDir,
                cliHistoryRedaction: captureTranscriptRedactionSnapshot(),
                max: 10,
                maxHistoryBytes: 64 * 1024,
                effectiveMaxChars: 4096,
                offset: undefined,
                messageId: undefined,
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
                    __openclaw: expect.objectContaining({ cliSessionId: nativeId }),
                  }),
                );
              }
            } finally {
              cli?.dispose();
            }
          });
        }
      } finally {
        owner.close();
      }
    });
  });
});

it("observes newly available reset archives and refuses changed archive bodies under older identities", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId: nativeId, filePath }) => {
      const scope = {
        agentId: "main",
        sessionId: "cli-archive",
        sessionKey: "agent:main:cli-archive",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: nativeId } },
      };
      const header = { type: "session", version: 3, id: scope.sessionId };
      await replaceSessionEntry(scope, entry);
      await replaceTranscriptEvents(scope, [header]);
      await waitForSessionTranscriptProjection(scope);
      await fs.writeFile(
        filePath,
        JSON.stringify({
          type: "assistant",
          uuid: "native-only",
          timestamp: new Date(1).toISOString(),
          message: { role: "assistant", content: "Native body" },
        }),
      );
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const target = {
        transcript: { ...scope, sessionFile: scope.sessionKey },
        database: { agentId: database.agentId, path: database.path },
        entryValidationKey: scope.sessionKey,
      };
      const owner = new OpenClawAgentDatabaseReadOnlyScope();
      const readers = createReadonlySessionHistoryReader(target);
      const params = {
        entry,
        provider: "claude-cli",
        sessionId: scope.sessionId,
        storePath: scope.storePath,
        sessionAgentId: scope.agentId,
        canonicalKey: scope.sessionKey,
        cliHistoryHomeDir: homeDir,
        cliHistoryRedaction: captureTranscriptRedactionSnapshot(),
        max: 10,
        maxHistoryBytes: 64 * 1024,
        effectiveMaxChars: 4096,
        offset: undefined,
        messageId: undefined,
      };
      const read = async () => {
        const cli = await prepareCliSessionHistoryReader(params, readers);
        if (!cli) {
          throw new Error("Expected native history reader");
        }
        try {
          return await readChatHistoryPageKernel(params, {
            readers: cli.readers,
            readMessageSequence: cli.sequence,
            deferProfileDisplay: true,
          });
        } finally {
          cli.dispose();
        }
      };
      const archive = (id: string, content: string) =>
        [
          header,
          {
            type: "message",
            id,
            parentId: null,
            message: { role: "assistant", content, timestamp: 0 },
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n";
      try {
        await owner.run(target.database, async () => {
          const revision = readers.readHistoryRevision();
          expect((await read()).messages.map(readChatHistoryMessageId)).toEqual(["native-only"]);
          const legacyPath = path.join(state.sessionsDir(), `${scope.sessionId}.jsonl`);
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

          const cli = await prepareCliSessionHistoryReader(params, readers);
          if (!cli) {
            throw new Error("Expected archive-backed native history reader");
          }
          try {
            const replacement = `${archived.archivedPath}.replacement`;
            await fs.writeFile(replacement, archive("replacement", "Replacement body"));
            await fs.rename(replacement, archived.archivedPath);
            await expect(
              readChatHistoryPageKernel(params, {
                readers: cli.readers,
                readMessageSequence: cli.sequence,
                deferProfileDisplay: true,
              }),
            ).rejects.toMatchObject({
              name: "SessionTranscriptProjectionUnavailableError",
              reason: "window-changed",
            });
          } finally {
            cli.dispose();
          }
          const refreshed = await read();
          expect(refreshed.messages.map(readChatHistoryMessageId)).toEqual([
            "replacement",
            "native-only",
          ]);
          expect(refreshed.messages).toContainEqual(
            expect.objectContaining({
              content: "Replacement body",
              __openclaw: expect.objectContaining({ id: "replacement" }),
            }),
          );
        });
      } finally {
        owner.close();
      }
    });
  });
});
