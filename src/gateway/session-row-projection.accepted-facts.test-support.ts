import { performance } from "node:perf_hooks";
import { expect, vi } from "vitest";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { getRuntimeConfig } from "../config/io.runtime.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.sqlite-entry-list.read.js";
import * as canonical from "../config/sessions/session-canonical-key.js";
import type { SessionRowDatabaseFacts } from "../config/sessions/session-row-facts.types.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { InternalSessionEntry, SessionAcpMeta } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import * as agentDatabases from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import * as databaseFactsRead from "./session-row-projection-read.js";
import { ready, type Row } from "./session-row-projection-record.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import * as rowInputs from "./session-utils-row.js";

/** Pause after the real read boundary has released Worker, continuation, and native custody. */
export async function withAcceptedSuffix(
  run: (fixture: {
    projection: SessionRowProjection;
    suffix: Row;
    scope: { agentId: string; sessionKey: string };
    query: { agentId: string; key: string };
    entry: InternalSessionEntry;
    reads: SessionRowDatabaseFacts[][];
    replacementPath: string;
    viewerId?: string;
    resume: () => Promise<void>;
    failNextRender: () => void;
  }) => Promise<void>,
  options: {
    archived?: boolean;
    membership?: boolean;
    replacement?: boolean;
    acpMeta?: SessionAcpMeta | null;
    legacyAcp?: true;
  } = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    getRuntimeConfig();
    const keys = [
      "agent:main:accepted-a",
      options.acpMeta === undefined ? "agent:main:accepted-b" : "agent:main:acp:accepted-b",
    ];
    const identities = options.membership
      ? {
          owner: ensureProfileForEmail("accepted-owner@example.test"),
          viewer: ensureProfileForEmail("accepted-viewer@example.test"),
        }
      : undefined;
    const entries = keys.map<InternalSessionEntry>((_, index) => ({
      sessionId: `accepted-${index}`,
      updatedAt: 1,
      label: `initial-${index}`,
      ...(options.acpMeta !== undefined && index === 1
        ? { lifecycleRevision: "accepted-lifecycle" }
        : {}),
      ...(options.archived && index === 1 ? { archivedAt: 1 } : {}),
      ...(identities && index === 1
        ? {
            visibility: "read-only",
            createdActor: { type: "human", source: "profile", id: identities.owner.id },
          }
        : {}),
    }));
    for (const [index, sessionKey] of keys.entries()) {
      replaceSessionEntrySync({ agentId: "main", sessionKey }, entries[index]!);
    }
    if (options.acpMeta) {
      seedCanonicalAcpSessionMeta({
        sessionKey: keys[1]!,
        sessionId: entries[1]!.sessionId,
        lifecycleRevision: options.legacyAcp ? undefined : "accepted-lifecycle",
        meta: options.acpMeta,
        now: () => 1,
      });
    }
    if (identities) {
      addSessionMember(
        { agentId: "main", sessionKey: keys[1]! },
        {
          identityId: identities.viewer.id,
          addedBy: identities.owner.id,
          addedAt: 1,
        },
      );
    }
    const replacementPath = state.statePath("imports", "accepted-replacement.sqlite");
    if (options.replacement) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: keys[1]!, storePath: replacementPath },
        { ...entries[1]!, updatedAt: 2, label: "replacement store" },
      );
      await closeOpenClawAgentDatabaseByPathAsync(replacementPath, "main");
    }
    const releaseForeground = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg: {
        agents: {
          entries: { main: {} },
          defaults: { utilityModel: "unit-test/small" },
        },
      },
      modelCatalog: [],
    });
    const paused = createDeferredCore();
    const release = createDeferredCore();
    let reading: Promise<void> | undefined;
    try {
      await projection.ensureMaterialized();
      // Cold projection admission is worker-owned; explicitly admit the native continuation fixture.
      listSessionEntriesReadOnly({ agentId: "main" });
      const query = { agentId: "main", key: keys[1]! };
      const previous = await withReadySessionRows(
        projection,
        () => [query],
        (read) => read.describe(query)!,
      );
      const count = projection.materializedCount;
      const releases: string[] = [];
      const continuations: SharedArrayBuffer[] = [];
      let trackingCustody = false;
      const capture = canonical.captureCanonicalSessionReaderContinuation;
      vi.spyOn(canonical, "captureCanonicalSessionReaderContinuation").mockImplementation((db) => {
        const owner = capture(db);
        if (!owner || !trackingCustody) {
          return owner;
        }
        continuations.push(owner.receipt.live);
        return {
          ...owner,
          release() {
            owner.release();
            releases.push("continuation");
          },
        };
      });
      const retain = agentDatabases.retainOpenClawAgentDatabaseReadCandidates;
      vi.spyOn(agentDatabases, "retainOpenClawAgentDatabaseReadCandidates").mockImplementation(
        (...args) => {
          const owner = retain(...args);
          if (!trackingCustody) {
            return owner;
          }
          expect(owner.databases).toHaveLength(1);
          return {
            ...owner,
            release() {
              owner.release();
              releases.push("native");
            },
          };
        },
      );
      const reads: SessionRowDatabaseFacts[][] = [];
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
        async (selected, consume) => {
          const tracked = trackingCustody;
          const result = await readDatabases(selected, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                async readRowFacts(input) {
                  const reply = await owner.readRowFacts(input);
                  reads.push(structuredClone(reply.rows));
                  return reply;
                },
              })),
            ),
          );
          if (tracked) {
            releases.push("worker");
          }
          return result;
        },
      );
      let elapsed = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const readInputs = rowInputs.readSessionRowInputs;
      const inputs = vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementation((params) => {
        const result = readInputs(params);
        elapsed += 20;
        return result;
      });
      const readFacts = databaseFactsRead.withSessionRowDatabaseFacts;
      vi.spyOn(databaseFactsRead, "withSessionRowDatabaseFacts").mockImplementationOnce(
        async (...args) => {
          trackingCustody = true;
          try {
            await readFacts(...args);
          } finally {
            trackingCustody = false;
          }
          paused.resolve();
          await release.promise;
        },
      );
      for (const [index, sessionKey] of keys.entries()) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { ...entries[index]!, updatedAt: 2, label: `accepted-${index}` },
        );
      }
      reading = projection.ensureMaterialized();
      await Promise.race([
        paused.promise,
        reading.then(() => {
          throw new Error("Drain bypassed the released-custody boundary");
        }),
      ]);
      expect(releases).toEqual(["worker", "continuation", "native"]);
      expect(continuations).toHaveLength(1);
      expect(Atomics.load(new Int32Array(continuations[0]!), 0)).toBe(0);
      const suffix = projection.findBySessionId({
        agentId: "main",
        sessionId: entries[1]!.sessionId,
      })[0]!;
      expect(suffix.pendingDatabaseFacts?.entry.label).toBe("accepted-1");
      expect(suffix.pendingDatabaseFacts?.acpMeta).toEqual(options.acpMeta ?? null);
      expect(suffix.materialized).toBe(previous.materialized);
      expect(suffix.materializedSequence).toBe(previous.materializedSequence);
      expect(ready(suffix)).toBe(false);
      expect(projection.materializedCount).toBe(count + 1);
      expect(reads).toHaveLength(1);
      expect(reads[0]?.map((row) => row.sessionKey)).toEqual(keys);
      await run({
        projection,
        suffix,
        query,
        reads,
        replacementPath,
        viewerId: identities?.viewer.id,
        scope: { agentId: "main", sessionKey: query.key },
        entry: { ...entries[1]!, updatedAt: 2, label: "accepted-1" },
        resume: async () => {
          release.resolve();
          await reading;
        },
        failNextRender: () => {
          inputs.mockImplementationOnce(() => {
            throw new Error("presentation unavailable");
          });
        },
      });
    } finally {
      release.resolve();
      await Promise.allSettled(reading ? [reading] : []);
      vi.restoreAllMocks();
      projection.dispose();
      releaseForeground();
    }
  });
}
