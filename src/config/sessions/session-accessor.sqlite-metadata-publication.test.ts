import { afterEach, expect, it, vi } from "vitest";
import { authorizePreparedSessionMutation } from "../../gateway/session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { rolePolicyConfig, sharingPolicyClient } from "../../gateway/session-sharing.test-utils.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../config.js";
import {
  retainPreparedSessionSharingFacts,
  retainSessionEntryWorkerPublication,
  projectSessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
import type { SessionEntry } from "./types.js";

// Retain real transaction admission/COMMIT and alter only result delivery ordering.
const delivery = vi.hoisted(() => ({ afterResult: undefined as (() => void) | undefined }));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owned = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owned,
        runExisting: (source, operation, options) =>
          owned.runExisting(
            source,
            (scope) =>
              operation({
                execute: async (command, commandOptions) => {
                  const result = await scope.execute(command, commandOptions);
                  if (command.type === "session.entries.replace") {
                    delivery.afterResult?.();
                  }
                  return result;
                },
              }),
            options,
          ),
      };
    },
  };
});
afterEach(() => {
  delivery.afterResult = undefined;
});

it.each([
  "metadata",
  "revisionless metadata",
  "lost result",
  "revoked member",
  "visibility",
  "archived",
  "reset",
  "replacement",
] as const)(
  "retains only unchanged live sharing through worker result delivery (%s)",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const sessionKey = "agent:main:metadata-publication";
      const scope = { agentId: "main", storePath: database.path, sessionKey };
      const original: SessionEntry = {
        sessionId: "original-session",
        lifecycleRevision:
          boundary === "revisionless metadata" ? undefined : "original-incarnation",
        updatedAt: 1,
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "creator" },
      };
      replaceSessionEntrySync(scope, original);
      addSessionMember(scope, { identityId: "requester", addedBy: "creator" });
      const read = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
      const client = sharingPolicyClient({ user: "requester" });
      const authorize = () =>
        authorizePreparedSessionMutation(
          { cfg, client, sessionKey, agentId: "main" },
          read.readCurrent(cfg),
          { policy: cfg.gateway!.roles!.definitions.view!, aliases: new Set(["requester"]) },
        );
      const changesPolicy = ["visibility", "archived", "reset", "replacement"].includes(boundary);
      let effects = 0;
      const lostReply = new Error("synthetic result delivery failure");
      delivery.afterResult = () => {
        effects++;
        expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe("committed");
        if (changesPolicy) {
          expect(() => read.readCurrent(cfg)).toThrow("Session access facts are unavailable");
        } else {
          expect(authorize()).toBeNull();
          expect(read.readCurrent(cfg).target.entry.sessionId).toBe(original.sessionId);
        }
        if (boundary === "revoked member") {
          expect(removeSessionMember(scope, "requester")).not.toBeNull();
          expect(authorize()).not.toBeNull();
        }
        if (boundary === "lost result") {
          throw lostReply;
        }
      };
      try {
        expect(authorize()).toBeNull();
        const operation = applySessionEntryExactReplacements({
          storePath: database.path,
          sessionKeys: [sessionKey],
          update: ([row]) => {
            if (!row) {
              throw new Error("Fixture session disappeared");
            }
            return {
              result: undefined,
              replacements: [
                {
                  sessionKey,
                  entry: {
                    ...row.entry,
                    updatedAt: 2,
                    label: "committed",
                    ...(boundary === "visibility" ? { visibility: "draft" as const } : {}),
                    ...(boundary === "archived" ? { archivedAt: 2 } : {}),
                    ...(boundary === "reset"
                      ? { lifecycleRevision: "replacement-incarnation" }
                      : {}),
                    ...(boundary === "replacement" ? { sessionId: "replacement-session" } : {}),
                  },
                },
              ],
            };
          },
        });
        if (boundary === "lost result") {
          await expect(operation).rejects.toBe(lostReply);
        } else {
          await operation;
        }
        expect(effects).toBe(1);
        if (boundary === "reset" || boundary === "replacement") {
          expect(() => read.readCurrent(cfg)).toThrow("Session access facts are unavailable");
          replaceSessionEntrySync(scope, original);
          expect(() => read.readCurrent(cfg)).toThrow("Session access facts are unavailable");
        } else if (boundary === "revoked member") {
          expect(authorize()).not.toBeNull();
          expect(read.readCurrent(cfg).membership.has("requester")).toBe(false);
        } else if (boundary === "archived") {
          expect(read.readCurrent(cfg).target.entry.archivedAt).toBe(2);
        } else if (!changesPolicy) {
          expect(authorize()).toBeNull();
          expect(read.readCurrent(cfg).target.entry.updatedAt).toBe(2);
        }
      } finally {
        read.release();
      }
    });
  },
);

it("invalidates certified unchanged sharing on an unknown native outcome", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:metadata-unknown";
    const entry = { sessionId: "original", updatedAt: 1, lifecycleRevision: "one" };
    replaceSessionEntrySync({ agentId: "main", storePath: database.path, sessionKey }, entry);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharingEntry = projectSessionSharingEntry(entry);
    const read = retainPreparedSessionSharingFacts({
      databaseIdentity: "file:" + identity,
      sessionKey,
      entry: sharingEntry,
      membership: new Set(["requester"]),
    });
    const publication = retainSessionEntryWorkerPublication({
      agentId: "main",
      storePath: database.path,
      databaseIdentity: identity,
    });
    try {
      publication.begin([sessionKey], [], new Map([[sessionKey, sharingEntry]]));
      expect(read.readCurrent()?.entry).toEqual(sharingEntry);
      publication.settle(undefined, true);
      expect(read.readCurrent()).toBeUndefined();
    } finally {
      publication.settle(undefined, false);
      read.release();
    }
  });
});
