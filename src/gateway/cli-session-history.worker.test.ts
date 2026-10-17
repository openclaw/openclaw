import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { ChatHistoryPageParams } from "../config/sessions/session-history-types.js";
import { isSessionHistoryWorkerCold } from "../config/sessions/session-transcript-worker-runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";

async function sourceDigest(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

it("reads oversized native history without caller-thread JSON.parse and survives ordinary close", async (test) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = {
      agentId: "main",
      sessionId: "large-native-history",
      sessionKey: "agent:main:large-native-history",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const nativeId = "5b8b202c-f6bb-4046-9475-d2f15fd07539";
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      cliSessionBindings: { "claude-cli": { sessionId: nativeId } },
    };
    const canonical = { role: "user", content: "Canonical history stays intact", timestamp: 1 };
    // The fixture owns one reader lifecycle, not unrelated automatic maintenance.
    await patchSessionEntryCore(scope, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
    await appendTranscriptMessage(scope, {
      eventId: "canonical",
      now: 1,
      message: canonical,
    });
    await waitForSessionTranscriptProjection(scope);
    const projectDir = path.join(state.home, ".claude", "projects", "large-history");
    const nativePath = path.join(projectDir, `${nativeId}.jsonl`);
    await fs.mkdir(projectDir, { recursive: true });
    const nativeRow = (uuid: string, role: string, content: string, second: number) =>
      JSON.stringify({
        type: role,
        uuid,
        timestamp: new Date(Date.UTC(2026, 9, 14, 0, 0, second)).toISOString(),
        message: { role, content },
      }) + "\n";
    await fs.writeFile(nativePath, nativeRow("warm-native", "assistant", "Warm native reader", 0));
    const params: ChatHistoryPageParams = {
      entry,
      provider: "claude-cli",
      sessionId: scope.sessionId,
      storePath: scope.storePath,
      sessionAgentId: scope.agentId,
      canonicalKey: scope.sessionKey,
      max: 10,
      maxHistoryBytes: 64 * 1024,
      effectiveMaxChars: 4096,
      offset: undefined,
      messageId: undefined,
    };
    const read = (ignoreCliSessionImports = false) =>
      withinTest(
        readChatHistoryPage({ ...params, ignoreCliSessionImports }, test.signal),
        test.signal,
      );
    const close = async () => {
      await closeOpenClawAgentDatabasesAsync(state.root);
      await closeOpenClawStateDatabaseAsync();
    };
    try {
      // Load the native importer before the large read; this is not a fresh parse-only isolate.
      expect((await read()).messages.map(readChatHistoryMessageId)).toEqual([
        "canonical",
        "warm-native",
      ]);
      expect(isSessionHistoryWorkerCold()).toBe(false);
      await fs.writeFile(nativePath, "");
      for (const [uuid, role, mib, second] of [
        ["native-2m", "user", 2, 1],
        ["native-34m", "assistant", 34, 2],
      ] as const) {
        await fs.appendFile(
          nativePath,
          nativeRow(uuid, role, "q".repeat(mib * 1024 * 1024), second),
        );
      }
      await fs.appendFile(
        nativePath,
        nativeRow("native-after", "user", "External history continues", 3),
      );
      const originalSource = await sourceDigest(nativePath);
      const parse = JSON.parse;
      const largeCallerParses: number[] = [];
      const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((source, reviver) => {
        if (typeof source === "string" && source.length > 1024 * 1024) {
          largeCallerParses.push(source.length);
        }
        return parse(source, reviver);
      });
      try {
        const page = await read();
        expect(page.messages.map(readChatHistoryMessageId)).toEqual([
          "canonical",
          "native-2m",
          "native-34m",
          "native-after",
        ]);
        const placeholder =
          "[Claude CLI history record omitted from context because it exceeded 1 MiB.]";
        expect(page.messages).toMatchObject([
          canonical,
          { role: "user", content: placeholder, __openclaw: { externalId: "native-2m" } },
          { role: "assistant", content: placeholder, __openclaw: { externalId: "native-34m" } },
          { role: "user", content: "External history continues" },
        ]);
        expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThan(4096);
        expect(largeCallerParses).toEqual([]);
        const ordinary = await read(true);
        expect(ordinary.messages).toMatchObject([canonical]);
        expect(ordinary.messages.map(readChatHistoryMessageId)).toEqual(["canonical"]);

        await close();
        expect(isSessionHistoryWorkerCold()).toBe(true);
        const reopened = await read(true);
        expect(reopened.messages.map(readChatHistoryMessageId)).toEqual(["canonical"]);
        expect(reopened.messages).toMatchObject([canonical]);
        expect(largeCallerParses).toEqual([]);
        expect(await sourceDigest(nativePath)).toBe(originalSource);
      } finally {
        parseSpy.mockRestore();
      }
    } finally {
      await close();
    }
  });
});
