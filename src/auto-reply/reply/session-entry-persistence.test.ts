import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { persistReplySessionEntry } from "./session-entry-persistence.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    clearSessionStoreCacheForTest();
    cleanup();
  }),
);
const sessionKey = "agent:main:main";
const baseEntry: SessionEntry = { sessionId: "session-1", updatedAt: 100 };

function fixture() {
  const scope = {
    sessionKey,
    storePath: path.join(tempDirs.make("openclaw-reply-session-store-"), "sessions.json"),
  };
  return {
    ...scope,
    read: () => loadSessionEntry({ ...scope, readConsistency: "latest" }),
    persist: (params: Omit<Parameters<typeof persistReplySessionEntry>[0], keyof typeof scope>) =>
      persistReplySessionEntry({ ...scope, ...params }),
    replace: (entry: SessionEntry) => replaceSessionEntry(scope, entry),
  };
}

describe("persistReplySessionEntry", () => {
  it("rejects account selection authority revoked while waiting for the session writer", async () => {
    const { storePath, read, persist, replace } = fixture();
    const initialEntry: SessionEntry = { ...baseEntry, delivery: { kind: "none" } };
    await replace(initialEntry);
    const entered = createDeferred();
    const release = createDeferred();
    const writer = patchSessionEntryCore({ sessionKey, storePath }, async () => {
      entered.resolve();
      await release.promise;
      return null;
    });
    await entered.promise;
    let authorized = true;
    const pending = persist({
      initialEntry,
      entry: {
        ...initialEntry,
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "user",
      },
      validateCommit: () => (authorized ? undefined : "Select an account you own."),
    });
    authorized = false;
    release.resolve();
    await writer;

    expect(await pending).toMatchObject({
      status: "commit-rejected",
      error: "Select an account you own.",
      entry: initialEntry,
    });
    expect(read()).toEqual(initialEntry);
  });

  it("does not restore policy fields revoked during reply processing", async () => {
    const { read, persist, replace } = fixture();
    const initialEntry: SessionEntry = {
      ...baseEntry,
      thinkingLevel: "low",
      elevatedLevel: "full",
      inheritedToolAllow: ["exec"],
      sendPolicy: "allow",
    };
    const currentEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 400,
      thinkingLevel: "low",
      sendPolicy: "deny",
    };
    await replace(currentEntry);

    const hostSql = observeHostDataSql();
    let result: Awaited<ReturnType<typeof persistReplySessionEntry>>;
    try {
      result = await persist({
        initialEntry,
        entry: {
          ...initialEntry,
          thinkingLevel: "high",
          updatedAt: 250,
        },
        skipMaintenance: true,
        validateCommit: () => undefined,
      });
    } finally {
      hostSql.restore();
    }
    expect(hostSql.queries.filter(isSessionEntryDataSql)).toEqual([]);

    expect(result).toMatchObject({
      status: "current",
      entry: { ...currentEntry, thinkingLevel: "high" },
    });
    expect(result.entry?.elevatedLevel).toBeUndefined();
    expect(result.entry?.inheritedToolAllow).toBeUndefined();
    expect(read()).toEqual(result.entry);
  });

  it.each([
    {
      name: "rotated",
      initialEntry: { ...baseEntry, thinkingLevel: "low" },
      currentEntry: {
        sessionId: "session-2",
        updatedAt: 400,
        thinkingLevel: "medium",
        delivery: { kind: "none" },
      },
      changes: { thinkingLevel: "high" },
      error: "changed while starting work. Retry.",
    },
    {
      name: "deleted (without recreating the row)",
      initialEntry: baseEntry,
      error: "was deleted while starting work. Retry.",
    },
    {
      name: "archived (even for a same-value write)",
      initialEntry: { ...baseEntry, modelOverride: "gpt-5.5" },
      currentEntry: {
        ...baseEntry,
        modelOverride: "gpt-5.5",
        updatedAt: 400,
        archivedAt: 300,
        delivery: { kind: "none" },
      },
      touchedFields: ["modelOverride"],
      error: "is archived. Restore it before starting new work.",
    },
  ] satisfies Array<{
    name: string;
    initialEntry: SessionEntry;
    currentEntry?: SessionEntry;
    changes?: Partial<SessionEntry>;
    touchedFields?: Array<keyof SessionEntry>;
    error: string;
  }>)("rejects persistence when the session is $name", async (row) => {
    const { read, persist, replace } = fixture();
    if (row.currentEntry) {
      await replace(row.currentEntry);
    }
    const result = await persist({
      initialEntry: row.initialEntry,
      entry: { ...row.initialEntry, ...row.changes, updatedAt: 250 },
      touchedFields: row.touchedFields,
    });
    expect(result).toEqual({
      status: "lifecycle-invalidated",
      error: `Session "${sessionKey}" ${row.error}`,
      ...(row.currentEntry ? { entry: row.currentEntry } : {}),
    });
    expect(read()).toEqual(row.currentEntry);
  });
});
