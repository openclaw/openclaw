import { performance } from "node:perf_hooks";
import { expect, vi } from "vitest";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { SessionRowDatabaseFacts } from "../config/sessions/session-row-facts.types.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import type { InternalSessionEntry, SessionAcpMeta } from "../config/sessions/types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as databaseFactsRead from "./session-row-database-facts.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { ready, type Row } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import * as rowFixture from "./session-row-projection.read-fixture.test-support.js";
import * as rowInputs from "./session-utils-row.js";

/** Pause after the real worker read scope has released its request hold. */
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
    const cfg = {
      agents: {
        entries: { main: {} },
        defaults: { utilityModel: "unit-test/small" },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const keys = [
      "agent:main:accepted-a",
      options.acpMeta === undefined ? "agent:main:accepted-b" : "agent:main:acp:accepted-b",
    ];
    const query = { agentId: "main", key: keys[1]! };
    const scope = { agentId: query.agentId, sessionKey: query.key };
    const [profileOwner, viewer] = options.membership
      ? ["owner", "viewer"].map((name) => ensureProfileForEmail(`accepted-${name}@example.test`))
      : [];
    const entries = keys.map<InternalSessionEntry>((_key, index) => ({
      sessionId: `accepted-${index}`,
      updatedAt: 1,
      label: `initial-${index}`,
    }));
    const suffixEntry = entries[1]!;
    if (options.acpMeta !== undefined) {
      suffixEntry.lifecycleRevision = "accepted-lifecycle";
    }
    if (options.archived) {
      suffixEntry.archivedAt = 1;
    }
    if (profileOwner) {
      suffixEntry.visibility = "read-only";
      suffixEntry.createdActor = { type: "human", source: "profile", id: profileOwner.id };
    }
    for (const [index, sessionKey] of keys.entries()) {
      rowFixture.seedRow(sessionKey, entries[index]!);
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
    if (profileOwner && viewer) {
      addSessionMember(scope, { identityId: viewer.id, addedBy: profileOwner.id, addedAt: 1 });
    }
    const replacementPath = state.statePath("imports", "accepted-replacement.sqlite");
    if (options.replacement) {
      replaceSessionEntrySync(
        { ...scope, storePath: replacementPath },
        { ...entries[1]!, updatedAt: 2, label: "replacement store" },
      );
      await closeOpenClawAgentDatabaseByPathAsync(replacementPath, "main");
    }
    using _ = rowFixture.holdForeground();
    using projection = await rowFixture.createTestProjection({ cfg, modelCatalog: [] });
    const paused = createDeferredCore();
    const release = createDeferredCore();
    let reading: Promise<void> | undefined;
    try {
      await projection.ensureMaterialized();
      const previous = await withReadySessionRows(
        projection,
        () => keys.map((key) => ({ agentId: "main", key })),
        (read) => read.describe(query)!,
      );
      const count = projection.materializedCount;
      let releases = 0;
      let trackingCustody = false;
      const reads: SessionRowDatabaseFacts[][] = [];
      const databases = rowFixture.watchRowFacts((owner) => async (input) => {
        const reply = await owner.readRowFacts(input);
        reads.push(structuredClone(reply.rows));
        return reply;
      });
      const readDatabases = databases.getMockImplementation()!;
      databases.mockImplementation(async (...args) => {
        const tracked = trackingCustody;
        const result = await readDatabases(...args);
        releases += tracked ? 1 : 0;
        return result;
      });
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
      const acceptedEntries = entries.map((entry, index) => ({
        ...entry,
        updatedAt: 2,
        label: `accepted-${index}`,
      }));
      for (const [index, sessionKey] of keys.entries()) {
        rowFixture.seedRow(sessionKey, acceptedEntries[index]!);
        sessionChanges.emit({
          agentId: "main",
          storePath: previous.storeTarget.storePath,
          sessionKey,
          factsInvalidated: true,
        });
      }
      reading = projection.ensureMaterialized();
      await Promise.race([
        paused.promise,
        reading.then(() => {
          throw new Error("Drain bypassed the released-custody boundary");
        }),
      ]);
      expect(releases).toBe(1);
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
        viewerId: viewer?.id,
        scope,
        entry: acceptedEntries[1]!,
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
    }
  });
}
