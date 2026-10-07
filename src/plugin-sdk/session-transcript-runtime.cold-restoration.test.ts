import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptRawDelta,
  readSessionTranscriptVisibleMessageDelta,
  type SessionTranscriptTargetParams,
} from "./session-transcript-runtime.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-cold-policy-");
type ReadParams = SessionTranscriptTargetParams & {
  restoreColdStorage?: boolean;
  cursor?: string;
  maxBytes?: number;
};
const readers = [
  {
    name: "raw",
    read: (params: ReadParams) =>
      readSessionTranscriptRawDelta({ maxBytes: 10_000, ...params, maxEvents: 2 }),
  },
  {
    name: "visible",
    read: (params: ReadParams) =>
      readSessionTranscriptVisibleMessageDelta({ maxBytes: 10_000, ...params, maxMessages: 1 }),
  },
];

describe.each(readers)("$name transcript cold-restoration policy", ({ name, read }) => {
  let scope: SessionTranscriptTargetParams & { agentId: string; storePath: string };

  beforeEach(() => {
    scope = {
      agentId: "main",
      sessionKey: "agent:main:sdk-cold-policy",
      sessionId: "sdk-cold-policy",
      storePath: path.join(tempDirs.make(), "agents", "main", "agent", "openclaw-agent.sqlite"),
    };
  });

  async function seed() {
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      eventId: "user-message",
      message: { role: "user", content: "Retained question" },
      now: 1_000,
    });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      eventId: "assistant-message",
      message: { role: "assistant", content: "Retained answer" },
      now: 2_000,
    });
  }

  async function archive() {
    const fixture = await createSessionColdStorageFixture(scope.storePath, scope.sessionKey);
    scope = fixture.scope;
    const hot = await read({ ...scope, restoreColdStorage: false, maxBytes: 1_000_000 });
    if (hot.kind !== "page") {
      throw new Error("expected hot fixture page");
    }
    await expect(
      runSessionColdStorageMaintenance({ config: maintenanceConfig(scope.storePath) }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    return hot.cursor;
  }

  it.each([undefined, true])(
    "refuses restoration until enabled (%s)",
    async (restoreColdStorage) => {
      const cursor = await archive();
      const databasePath = resolveOpenClawAgentSqlitePath({
        agentId: scope.agentId,
        path: scope.storePath,
      });
      await closeOpenClawAgentDatabasesAsync();
      const before = fs.readFileSync(databasePath);
      await expect(read({ ...scope, restoreColdStorage: false })).rejects.toThrow("cold storage");
      await expect(read({ ...scope, restoreColdStorage: false, cursor })).rejects.toThrow(
        "cold storage",
      );
      await closeOpenClawAgentDatabasesAsync();
      expect(fs.readFileSync(databasePath)).toEqual(before);
      const restored = await read({ ...scope, restoreColdStorage, maxBytes: 1_000_000 });
      expect(restored).toMatchObject(
        name === "raw"
          ? {
              kind: "page",
              events: [{ event: { id: "cold-history-window" } }, { event: { id: "history-user" } }],
            }
          : { kind: "page", entries: [{ entryId: "history-user" }] },
      );
      // Subsequent opt-out reads succeed because the default/explicit restoring call made it hot.
      await expect(
        read({ ...scope, restoreColdStorage: false, maxBytes: 1_000_000 }),
      ).resolves.toEqual(restored);
    },
  );

  it("preserves hot count/byte bounds and cursor continuation", async () => {
    await seed();
    const first = await read({ ...scope, restoreColdStorage: false });
    expect(first).toMatchObject(
      name === "raw"
        ? {
            kind: "page",
            events: [{ event: { type: "session" } }, { event: { id: "user-message" } }],
            hasMore: true,
          }
        : { kind: "page", entries: [{ entryId: "user-message" }], hasMore: true },
    );
    if (first.kind !== "page") {
      throw new Error("expected initial page");
    }
    await expect(
      read({ ...scope, restoreColdStorage: false, cursor: first.cursor }),
    ).resolves.toMatchObject(
      name === "raw"
        ? { kind: "page", events: [{ event: { id: "assistant-message" } }], hasMore: false }
        : { kind: "page", entries: [{ entryId: "assistant-message" }], hasMore: false },
    );
    const bounded = await read({ ...scope, restoreColdStorage: false, maxBytes: 1 });
    expect(bounded).toMatchObject({
      kind: "page",
      hasMore: true,
      serializedBytes: 0,
      requiredBytes: expect.any(Number),
      ...(name === "raw" ? { events: [] } : { entries: [] }),
    });
    await expect(
      read({ ...scope, restoreColdStorage: false, cursor: "invalid" }),
    ).resolves.toMatchObject({ kind: "reset", reason: "invalid_cursor" });
  });
});
