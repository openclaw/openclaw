import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import * as configEnv from "../config-env-vars.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
  retainPreparedSessionSharingFacts,
  projectSessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  applySessionEntryCanonicalReplacements,
  applySessionEntryExactReplacements,
} from "./session-accessor.sqlite-replacement-projection.js";

it("commits platform-normalized replacements without entering a caller-thread SQLite write transaction", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:replacement-worker";
    writeSessionEntry(database, sessionKey, {
      sessionId: "replacement",
      lifecycleRevision: "initial-lifecycle",
      updatedAt: 1,
    });
    const mutations: SessionIdentityMutation[] = [];
    const normalized = withMockedPlatform("win32", () =>
      configEnv.cloneEnvWithPlatformSemantics(process.env),
    );
    expect(() => structuredClone(normalized)).toThrow();
    const clone = vi
      .spyOn(configEnv, "cloneEnvWithPlatformSemantics")
      .mockReturnValueOnce(normalized);
    const databasePrototype: DatabaseSync = Object.getPrototypeOf(database.db);
    const exec = vi.spyOn(databasePrototype, "exec");
    const unsubscribe = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    try {
      const token = {};
      expect(
        await applySessionEntryExactReplacements({
          agentId: "main",
          storePath: database.path,
          sessionKeys: [sessionKey],
          update: ([row]) => ({
            result: token,
            replacements: [{ sessionKey, entry: { ...row!.entry, label: "committed" } }],
          }),
        }),
      ).toBe(token);
      expect(mutations).toEqual([]);
      await applySessionEntryExactReplacements({
        agentId: "main",
        storePath: database.path,
        sessionKeys: [sessionKey],
        update: ([row]) => ({
          result: undefined,
          replacements: [
            { sessionKey, entry: { ...row!.entry, lifecycleRevision: "next-lifecycle" } },
          ],
        }),
      });
      expect(mutations).toEqual([
        {
          agentId: "main",
          kind: "reset",
          previous: { sessionId: "replacement", sessionKeys: [sessionKey] },
          current: { sessionId: "replacement", sessionKeys: [sessionKey] },
        },
      ]);
      expect(exec.mock.calls.filter(([sql]) => /\bBEGIN\s+IMMEDIATE\b/i.test(sql))).toEqual([]);
    } finally {
      unsubscribe();
      exec.mockRestore();
      clone.mockRestore();
    }
    expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe("committed");
  });
});

it("publishes committed sharing and reader invalidation before observers, and rolls back revoked canonical writes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:replacement-publication";
    const targetKey = "agent:main:replacement-moved";
    const original = { sessionId: "publication", updatedAt: 1 };
    writeSessionEntry(database, sessionKey, original);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey,
      entry: projectSessionSharingEntry(original),
      membership: new Set(["member"]),
    });
    const reader = new OpenClawAgentDatabaseReadOnlyScope();
    let readerDatabase: DatabaseSync | undefined;
    reader.read(
      (opened) => {
        readerDatabase = opened.db;
        return readSessionEntryCache(opened, { cache: true });
      },
      { agentId: "main", path: database.path },
    );
    const observed: unknown[] = [];
    const stop = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === sessionKey) {
        observed.push({
          visibility: sharing.readCurrent()?.entry?.visibility,
          membership: [...(sharing.readCurrent()?.membership ?? [])],
          cache: readerDatabase && readCommittedSessionEntryCache(readerDatabase),
        });
      }
    });
    try {
      await applySessionEntryExactReplacements({
        storePath: database.path,
        sessionKeys: [sessionKey],
        update: ([row]) => ({
          result: undefined,
          replacements: [{ sessionKey, entry: { ...row!.entry, visibility: "read-only" } }],
        }),
      });
      expect(observed).toEqual([
        { visibility: "read-only", membership: ["member"], cache: undefined },
      ]);
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      let current = true;
      const admitted = vi
        .spyOn(admission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((callback) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit") {
              current = false;
            }
            return callback(request, grant);
          }),
        );
      const move = () =>
        applySessionEntryCanonicalReplacements({
          storePath: database.path,
          sessionKeys: [sessionKey, targetKey],
          assertCommitAllowed() {
            if (!current) {
              throw new Error("Replacement authority revoked");
            }
          },
          update: ([row]) => ({
            result: undefined,
            replacements: [
              { sessionKey: targetKey, previousSessionKeys: [sessionKey], entry: row!.entry },
            ],
          }),
        });
      try {
        await expect(move()).rejects.toThrow("Replacement authority revoked");
        expect(current).toBe(false);
        expect(readExactSessionEntryRow(database, sessionKey)?.entry.visibility).toBe("read-only");
        expect(readExactSessionEntryRow(database, targetKey)).toBeUndefined();
        expect(observed).toHaveLength(1);
      } finally {
        admitted.mockRestore();
      }
      current = true;
      await move();
      expect(readExactSessionEntryRow(database, sessionKey)).toBeUndefined();
      expect(readExactSessionEntryRow(database, targetKey)?.entry).toMatchObject({
        ...original,
        visibility: "read-only",
      });
      expect(sharing.readCurrent()).toBeUndefined();
    } finally {
      stop();
      sharing.release();
      reader.close();
    }
  });
});

it("creates a missing durable replacement database entirely through its worker owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("new-replacement.sqlite");
    const sessionKey = "agent:main:replacement-created";
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      await applySessionEntryCanonicalReplacements({
        storePath,
        sessionKeys: [sessionKey],
        update: (entries) => {
          expect(entries).toEqual([]);
          return {
            result: undefined,
            replacements: [
              {
                sessionKey,
                previousSessionKeys: [],
                entry: { sessionId: "created", updatedAt: 1 },
              },
            ],
          };
        },
      });
      expect(exec.mock.calls.filter(([sql]) => /\bBEGIN\s+IMMEDIATE\b/i.test(sql))).toEqual([]);
    } finally {
      exec.mockRestore();
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    expect(readExactSessionEntryRow(database, sessionKey)?.entry.sessionId).toBe("created");
  });
});
