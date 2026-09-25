import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot, type OpenClawConfig } from "../../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import { getSessionEntryWriteQueries } from "../../../config/sessions/session-accessor.sqlite-entry-write-queries.js";
import * as replacementWorker from "../../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import { bindSessionNode } from "../../../config/sessions/session-accessor.sqlite-session-row.js";
import { readSessionTranscriptHotWatermark } from "../../../config/sessions/session-accessor.sqlite-transcript-watermark-read.js";
import { certifyCanonicalSessionValidationRow } from "../../../config/sessions/session-canonical-validation.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { runSqliteImmediateTransactionSync } from "../../../infra/sqlite-transaction.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../../state/openclaw-agent-db-lifecycle.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../../../state/openclaw-agent-db-registry-listing.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { InheritedToolPolicyV2 } from "../../inherited-tool-policy.schema.js";
import { resolvePersistedSubagentToolPolicyEnvelope } from "./subagent-capabilities.js";
import { withPreparedSubagentCapabilityStore } from "./subagent-capability-preparation.js";
import type { SessionCapabilityLookup } from "./subagent-session-store.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";

it("inherits accepted human credit when participant persistence is still queued", async () => {
  await withOpenClawTestState({ label: "spawn-pending-participant" }, async (state) => {
    const agentId = "main";
    const sessionKey = "agent:main:parent";
    const childSessionKey = "agent:main:subagent:child";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId });
    const scope = { agentId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "parent-id", updatedAt: 1 });
    const releaseWriter = createDeferredCore();
    const writerStarted = createDeferredCore();
    const heldWriter = runOpenClawAgentWriteAdmission({ agentId, path: storePath }, async () => {
      writerStarted.resolve();
      await releaseWriter.promise;
    });
    await writerStarted.promise;
    const work = new AsyncWorkScope();
    const errors: unknown[] = [];
    const inheritedToolPolicy: InheritedToolPolicyV2 = {
      clauses: [
        { kind: "configured", allow: ["group:plugins"], deny: ["release_deploy"] },
        { kind: "execution", allow: ["release_status"] },
      ],
      parameters: { fileTools: [], exec: [], sandbox: [], unsupported: [] },
    };
    try {
      work.run(() =>
        recordSessionParticipantBestEffort({
          ...scope,
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
          identity: { type: "profile", id: "human-requester" },
          promptedAt: 1,
          onError: (error) => errors.push(error),
        }),
      );
      // The real recorder defers its write to the next microtask. Keep that original order.
      await Promise.resolve();
      expect(loadSessionEntry(scope)?.participants ?? []).toEqual([]);
      const creation = createInitialSubagentSession({
        cfg: {},
        targetAgentId: agentId,
        childSessionKey,
        incognito: false,
        requesterInternalKey: sessionKey,
        requesterAgentId: agentId,
        creationPolicy: { actor: { type: "agent", id: agentId } },
        completionOwnerSessionKey: sessionKey,
        admissionPatch: { spawnDepth: 1 },
        inheritedToolPolicy,
        modelPatch: {},
        collect: false,
      });
      releaseWriter.resolve();
      await heldWriter;
      expect(await creation).toMatchObject({ status: "ok" });
      await work.drain();

      expect(errors).toEqual([]);
      expect(loadSessionEntry(scope)?.participants).toEqual([
        { identity: { type: "profile", id: "human-requester" } },
      ]);
      const child = loadSessionEntry({ ...scope, sessionKey: childSessionKey });
      expect(child?.inheritedGitContributorProfileIds).toEqual(["human-requester"]);
      expect(child?.participants ?? []).toEqual([]);
      expect(child).toMatchObject({
        inheritedToolPolicyVersion: 2,
        inheritedToolPolicy,
        spawnedBy: sessionKey,
        parentSessionKey: sessionKey,
        completionOwnerSessionKey: sessionKey,
      });
      expect(child?.inheritedToolAllow).toBeUndefined();
      expect(child?.inheritedToolDeny).toBeUndefined();
      expect(
        resolvePersistedSubagentToolPolicyEnvelope(childSessionKey, {
          cfg: {},
          requiredVersion: 2,
        }),
      ).toMatchObject({ version: 2, policy: inheritedToolPolicy });
    } finally {
      releaseWriter.resolve();
      await heldWriter;
      await work.drain();
    }
  });
});

it("retains cross-agent lineage owners through policy admission", async () => {
  await withOpenClawTestState({ label: "capability-lineage-worker" }, async (state) => {
    const parentKey = "agent:main:subagent:parent";
    const sourceKey = "agent:other:requester";
    await upsertSessionEntryCore({ sessionKey: parentKey }, { sessionId: "parent", updatedAt: 1 });
    await upsertSessionEntryCore({ sessionKey: sourceKey }, { sessionId: "source", updatedAt: 1 });
    const child: SessionEntry = {
      sessionId: "child",
      updatedAt: 1,
      spawnedBy: parentKey,
      completionOwnerSessionKey: parentKey,
      spawnDepth: 1,
    };
    const savedChild: SessionEntry = {
      ...child,
      spawnedBy: "agent:main:retired-sender",
      completionOwnerSessionKey: parentKey,
      inheritedToolPolicyVersion: 2,
      inheritedToolPolicy: {
        clauses: [{ kind: "configured", allow: ["read"] }],
        parameters: { fileTools: [], exec: [], sandbox: [], unsupported: [] },
      },
    };
    await withPreparedSubagentCapabilityStore({
      cfg: {},
      preparedSessionEntry: { sessionKey: "agent:main:subagent:independent", entry: savedChild },
      assertCurrent: () => {},
      consume: async ({ store }) => {
        expect(store.get("agent:main:retired-sender")).toBeUndefined();
        expect(
          resolvePersistedSubagentToolPolicyEnvelope("agent:main:subagent:independent", {
            cfg: {},
            store,
            requiredVersion: 2,
          }),
        ).toMatchObject({ version: 2, policy: savedChild.inheritedToolPolicy });
      },
    });
    let retained: SessionCapabilityLookup | undefined;
    let consumed = false;
    let closing: Promise<boolean> | undefined;
    try {
      await expect(
        withPreparedSubagentCapabilityStore({
          cfg: {},
          preparedSessionEntry: { sessionKey: "agent:main:subagent:child", entry: child },
          extraSessionKeys: [sourceKey],
          assertCurrent: () => {},
          consume: async ({ store, readEntry, assertCurrent }) => {
            retained = store;
            expect(store.authoritative).toBe(true);
            expect(store.get(parentKey)?.sessionId).toBe("parent");
            expect(readEntry(sourceKey)?.sessionId).toBe("source");
            expect(() => store.get("agent:main:subagent:unprepared")).toThrow("unprepared lineage");
            consumed = true;
            await Promise.resolve();
            invalidateRegisteredAgentDatabasesMemo({ env: state.env });
            expect(assertCurrent).not.toThrow();
            closing = closeOpenClawAgentDatabaseByPathAsync(
              resolveOpenClawAgentSqlitePath({ agentId: "other" }),
              "other",
            );
            expect(assertCurrent).toThrow("revoked");
          },
        }),
      ).rejects.toThrow("revoked");
      expect(consumed).toBe(true);
      expect(() => retained?.get(parentKey)).toThrow("no longer active");
    } finally {
      await closing;
    }
  });
});

const creatorPolicy: InheritedToolPolicyV2 = {
  clauses: [],
  parameters: { fileTools: [], exec: [], sandbox: [], unsupported: [] },
};

function createPinnedChild(targetAgentId: string, assertActive: () => void = () => {}) {
  return createInitialSubagentSession({
    cfg: {},
    targetAgentId,
    childSessionKey: `agent:${targetAgentId}:subagent:initial`,
    label: "shared label",
    incognito: false,
    requesterInternalKey: "agent:main:pinned",
    requesterAgentId: "main",
    assertActive,
    creationPolicy: { actor: { type: "agent", id: "main" } },
    completionOwnerSessionKey: "agent:main:pinned",
    inheritedToolPolicy: creatorPolicy,
    admissionPatch: { spawnDepth: 1 },
    modelPatch: {},
    collect: false,
  });
}

it.each(["main", "other"])(
  "creates a native child for %s while retaining the parent reader",
  async (targetAgentId) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const parentScope = { agentId: "main", sessionKey: "agent:main:pinned" };
      await upsertSessionEntryCore(parentScope, {
        sessionId: "parent",
        lifecycleRevision: "parent-generation",
        updatedAt: 1,
        skillLibrarySelections: [],
      });
      const childScope = {
        agentId: targetAgentId,
        sessionKey: `agent:${targetAgentId}:subagent:initial`,
      };
      await upsertSessionEntryCore(
        { agentId: targetAgentId, sessionKey: `agent:${targetAgentId}:neighbor` },
        {
          sessionId: "neighbor",
          updatedAt: 1,
          label: "shared label",
        },
      );
      if (targetAgentId === "other") {
        await upsertSessionEntryCore(childScope, {
          sessionId: "previous-child",
          updatedAt: 1,
          createdVia: "spawn",
        });
      }
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      let result: Awaited<ReturnType<typeof createInitialSubagentSession>>;
      try {
        result = await withSessionEntryReadOnlyInWorker(
          parentScope,
          () => {},
          async (read, assertCurrent) => {
            expect(read).toMatchObject({ ok: true, value: { sessionId: "parent" } });
            return await createPinnedChild(targetAgentId, assertCurrent);
          },
        );
        expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
        expect(exec.mock.calls.filter(([sql]) => /\bBEGIN\s+IMMEDIATE\b/i.test(sql))).toEqual([]);
      } finally {
        exec.mockRestore();
      }
      const child = loadSessionEntry(childScope);
      expect(child).toMatchObject({
        label: "shared label",
        skillLibrarySelections: [],
        inheritedToolPolicyVersion: 2,
      });
      expect(child?.sessionId).not.toBe("previous-child");
      expect(child?.lifecycleRevision).toEqual(expect.any(String));
      if (targetAgentId === "other") {
        expect(child?.previousSessionId).toBe("previous-child");
        expect(child?.usageFamilySessionIds).toContain("previous-child");
      }
      expect(child?.sessionId).toBeDefined();
      if (!child) {
        throw new Error("missing persisted child");
      }
      expect(
        readSessionTranscriptHotWatermark(
          openOpenClawAgentDatabase({ agentId: targetAgentId }),
          child.sessionId,
        ),
      ).toEqual({ generation: null, maxSeq: null });
    });
  },
);

it.each([
  { targetAgentId: "main", mutation: "pins", refused: true },
  { targetAgentId: "main", mutation: "metadata", refused: false },
  { targetAgentId: "other", mutation: "pins", refused: true },
] as const)(
  "rechecks $mutation before the $targetAgentId child commit",
  async ({ targetAgentId, mutation, refused }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const aliasPins = targetAgentId === "main" && mutation === "pins";
      const physicalAgentDir = state.statePath("agents", "main", "physical-agent");
      if (aliasPins) {
        await fs.mkdir(physicalAgentDir, { recursive: true });
        await fs.symlink(
          physicalAgentDir,
          state.agentDir("main"),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const parentKey = "agent:main:pinned";
      const parent = {
        sessionId: "parent",
        lifecycleRevision: "parent-generation",
        updatedAt: 1,
        skillLibrarySelections: [],
      } satisfies SessionEntry;
      const savedParent = await upsertSessionEntryCore(
        { agentId: "main", sessionKey: parentKey },
        parent,
      );
      if (!savedParent) {
        throw new Error("missing parent fixture");
      }
      await upsertSessionEntryCore(
        { agentId: targetAgentId, sessionKey: `agent:${targetAgentId}:neighbor` },
        { sessionId: "neighbor", updatedAt: 1 },
      );
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      if (aliasPins) {
        const canonicalPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
        const physicalPath = await fs.realpath(canonicalPath);
        expect(physicalPath).toBe(path.join(physicalAgentDir, "openclaw-agent.sqlite"));
        expect(physicalPath).not.toBe(canonicalPath);
      }
      const commit = replacementWorker.commitSessionEntryReplacementsInWorker;
      let injected = false;
      const beforeCommit = vi
        .spyOn(replacementWorker, "commitSessionEntryReplacementsInWorker")
        .mockImplementation(async (...args) => {
          if (!injected) {
            injected = true;
            const changed =
              mutation === "pins"
                ? {
                    ...savedParent,
                    skillLibrarySelections: [
                      {
                        skillId: "00000000-0000-0000-0000-000000000001",
                        revision: "a".repeat(64),
                        name: "changed",
                        ownerProfileId: null,
                      },
                    ],
                  }
                : { ...savedParent, compactionCount: 2 };
            if (targetAgentId === "main") {
              // Canonical binding/certification commits valid foreign rows without
              // publishing main-process cache facts; the child must recheck in SQL.
              const foreign = new DatabaseSync(database.path);
              try {
                runSqliteImmediateTransactionSync(foreign, () => {
                  const writer = getSessionEntryWriteQueries(foreign);
                  writer.node(
                    bindSessionNode({
                      entry: changed,
                      sessionKey: parentKey,
                      updatedAt: changed.updatedAt,
                    }),
                  );
                  writer.markValid(parentKey);
                  certifyCanonicalSessionValidationRow({ agentId: "main", db: foreign }, parentKey);
                });
              } finally {
                foreign.close();
              }
            } else {
              writeSessionEntry(database, parentKey, changed);
            }
          }
          return await commit(...args);
        });
      try {
        const result = await createPinnedChild(targetAgentId);
        expect(injected, JSON.stringify(result)).toBe(true);
        if (refused) {
          expect(result, JSON.stringify(result)).toMatchObject({
            status: "error",
            error: expect.stringMatching(/prerequisite changed|Parent skill selection changed/),
          });
          expect(
            loadSessionEntry({
              agentId: targetAgentId,
              sessionKey: `agent:${targetAgentId}:subagent:initial`,
            }),
          ).toBeUndefined();
        } else {
          expect(result, JSON.stringify(result)).toMatchObject({
            status: "ok",
            entry: { skillLibrarySelections: [] },
          });
        }
      } finally {
        beforeCommit.mockRestore();
      }
    });
  },
);

it("inherits global parent pins and credit from the prepared requester agent", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, research: {} },
      },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const selectedPins = [
      {
        skillId: "00000000-0000-0000-0000-000000000002",
        revision: "b".repeat(64),
        name: "research-pin",
        ownerProfileId: null,
      },
    ];
    for (const agentId of ["main", "research"]) {
      await upsertSessionEntryCore(
        { agentId, sessionKey: "global" },
        {
          sessionId: `${agentId}-parent`,
          lifecycleRevision: `${agentId}-generation`,
          updatedAt: Date.now(),
          skillLibrarySelections: agentId === "research" ? selectedPins : [],
          inheritedGitContributorProfileIds: [`${agentId}-contributor`],
        },
      );
    }
    const childSessionKey = "agent:main:subagent:global-source";
    const request: Parameters<typeof createInitialSubagentSession>[0] = {
      cfg,
      targetAgentId: "main",
      childSessionKey,
      incognito: false,
      requesterInternalKey: "global",
      requesterAgentId: "research",
      completionOwnerSessionKey: "global",
      creationPolicy: { actor: { type: "agent", id: "research" } },
      inheritedToolPolicy: creatorPolicy,
      admissionPatch: { spawnDepth: 1 },
      modelPatch: {},
      collect: false,
    };
    const result = await createInitialSubagentSession(request);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    expect(loadSessionEntry({ agentId: "main", sessionKey: childSessionKey })).toMatchObject({
      skillLibrarySelections: selectedPins,
      inheritedGitContributorProfileIds: ["research-contributor"],
      spawnedBy: "global",
      parentSessionKey: "global",
      completionOwnerSessionKey: "global",
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: "global" })).toMatchObject({
      sessionId: "main-parent",
      skillLibrarySelections: [],
    });
    expect(loadSessionEntry({ agentId: "research", sessionKey: "global" })).toMatchObject({
      sessionId: "research-parent",
      skillLibrarySelections: selectedPins,
    });
  });
});
