import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { captureTranscriptRedactionSnapshot } from "../agents/transcript-redact-text.js";
import {
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
        cliHistoryProjectsRoot: path.join(homeDir, ".claude", "projects"),
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
