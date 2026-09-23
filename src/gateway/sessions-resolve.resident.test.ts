import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";
import {
  filterAndSortSessionEntries,
  listProjectedSessions,
  prepareSessionRowSelection,
} from "./session-utils-list.js";
import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";

afterEach(() => vi.restoreAllMocks());

function addUnrelatedSessions() {
  for (let index = 0; index < 96; index++) {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: `agent:main:other-${index}` },
      { sessionId: `other-${index}`, updatedAt: index + 2, displayName: "Other session" },
    );
  }
}

it("resolves free ACP aliases from current resident facts without SQLite or discovery materialization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const acpKey = "agent:harness:acp:12345678-0aaa-4000-8000-000000000009";
    const acpEntry = {
      sessionId: "free-acp-resident",
      lifecycleRevision: "resident-revision",
      updatedAt: 1,
      label: "Free ACP",
    };
    replaceSessionEntrySync({ agentId: "harness", sessionKey: acpKey }, acpEntry);
    writeAcpSessionMetaForMigration({
      sessionKey: acpKey.replace("agent:harness:", "agent:HARNESS:"),
      lifecycleRevision: acpEntry.lifecycleRevision,
      meta: {
        backend: "fixture",
        agent: "harness",
        runtimeSessionName: "free-resident",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
      },
    });
    addUnrelatedSessions();
    const projection = await createSessionRowProjection({ cfg });
    // Match the Gateway request lifetime so idle preview reads stay outside this proof.
    const releaseForegroundWork = retainSessionListForegroundWork();
    try {
      await projection.ensureMaterialized();
      const reads = (["all", "get", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      const describe = vi.spyOn(projection, "describe");
      const selections = vi.spyOn(projection, "selectEntries");
      try {
        for (const p of [
          { sessionId: acpEntry.sessionId },
          { label: acpEntry.label },
          { shortId: "12345678" },
        ]) {
          selections.mockClear();
          expect(resolveSessionKeyFromResolveParams({ client: null, projection, p })).toMatchObject(
            { ok: true, key: acpKey, agentId: "harness" },
          );
          if ("sessionId" in p) {
            const enumerated = selections.mock.results.reduce(
              (count, selection) =>
                count + (selection.type === "return" ? selection.value.length : 0),
              0,
            );
            expect(enumerated).toBeLessThanOrEqual(2);
          }
        }
        expect(describe).not.toHaveBeenCalled();
        expect(
          resolveSessionKeyFromResolveParams({
            client: null,
            projection,
            p: { key: acpKey },
          }),
        ).toMatchObject({ ok: true, key: acpKey, agentId: "harness" });
        for (const read of reads) {
          expect(read).not.toHaveBeenCalled();
        }
      } finally {
        describe.mockRestore();
        selections.mockRestore();
        for (const read of reads) {
          read.mockRestore();
        }
      }
    } finally {
      projection.dispose();
      releaseForegroundWork();
    }
  });
});

const cfg = {
  agents: {
    ownership: "explicit" as const,
    entries: { main: { model: { primary: "openai/gpt-5.5" } } },
  },
};
const key = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";
const scope = { agentId: "main", sessionKey: key };
const entry = {
  sessionId: "resident-resolve",
  updatedAt: 1,
  label: "Original label",
  modelProvider: "ollama",
  model: "qwen3:7b",
};

it("bounds exact discovery by matching rows instead of the resident roster", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(scope, entry);
    addUnrelatedSessions();
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      const selections = vi.spyOn(projection, "selectEntries");
      for (const p of [
        { sessionId: entry.sessionId },
        { sessionId: entry.sessionId, agentId: "main" },
        { sessionId: key },
        { reference: { key, slug: "other-session" } },
        { sessionId: "missing-id", allowMissing: true },
        { reference: { key: "agent:main:missing" }, allowMissing: true },
      ]) {
        selections.mockClear();
        const result = resolveSessionKeyFromResolveParams({
          client: null,
          projection,
          p,
        });
        expect(result).toMatchObject(
          p.allowMissing ? { ok: true, missing: true } : { ok: true, key },
        );
        const enumerated = selections.mock.results.reduce(
          (count, selection) => count + (selection.type === "return" ? selection.value.length : 0),
          0,
        );
        expect(enumerated).toBeLessThanOrEqual(2);
      }
    } finally {
      projection.dispose();
    }
  });
});

it.each(["exact", "broad"] as const)(
  "resolves replaced IDs immediately after a %s committed publication",
  async (publication) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      replaceSessionEntrySync(scope, entry);
      const projection = await createSessionRowProjection({ cfg });
      const resolve = (sessionId: string) =>
        resolveSessionKeyFromResolveParams({
          client: null,
          projection,
          p: { sessionId, allowMissing: true },
        });
      try {
        await projection.ensureMaterialized();
        const emit = sessionChanges.emit.bind(sessionChanges);
        const publicationSpy =
          publication === "broad"
            ? vi.spyOn(sessionChanges, "emit").mockImplementation((change, database) =>
                emit(
                  "all" in change
                    ? change
                    : {
                        all: true,
                        scope: {
                          agentId: change.agentId,
                          storePath: change.storePath,
                        },
                      },
                  database,
                ),
              )
            : undefined;
        try {
          runOpenClawAgentWriteTransaction(
            (database) =>
              writeSessionEntry(database, key, { ...entry, sessionId: "replacement-id" }),
            { agentId: "main" },
          );
        } finally {
          publicationSpy?.mockRestore();
        }
        expect(resolve("replacement-id")).toEqual({ ok: true, key, agentId: "main" });
        expect(resolve(entry.sessionId)).toEqual({ ok: true, missing: true });
        expect(resolve(key)).toEqual({ ok: true, key, agentId: "main" });
      } finally {
        projection.dispose();
      }
    });
  },
);

it.each(["global", "unknown"] as const)(
  "keeps the advertised %s store winner when resolving IDs and filtering discovery",
  async (sentinel) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = {
        ...cfg,
        session: { store: state.statePath("stores", "{agentId}.sqlite") },
      };
      const configuredPath = state.statePath("stores", "main.sqlite");
      const defaultPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const winner = { sessionId: `configured-${sentinel}`, updatedAt: 1 };
      const shadow = { sessionId: `default-${sentinel}`, updatedAt: 2 };
      for (const [storePath, stored] of [
        [configuredPath, winner],
        [defaultPath, shadow],
      ] as const) {
        replaceSessionEntrySync({ agentId: "main", storePath, sessionKey: sentinel }, stored);
        registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
      }
      const projection = await createSessionRowProjection({ cfg: config });
      const client = sharingPolicyClient({ user: "viewer" });
      const opts = { includeGlobal: true, includeUnknown: true };
      const resolve = (sessionId: string) =>
        resolveSessionKeyFromResolveParams({
          client,
          projection,
          p: { ...opts, sessionId, allowMissing: true },
        });
      try {
        const listed = await listProjectedSessions({ projection, client, opts });
        expect(listed.sessions).toMatchObject([
          { key: sentinel, agentId: "main", sessionId: winner.sessionId },
        ]);
        expect(projection.describe({ agentId: "main", key: sentinel })?.entry.sessionId).toBe(
          winner.sessionId,
        );
        expect(
          projection.describe({ agentId: "main", key: sentinel, storePath: defaultPath })?.entry
            .sessionId,
        ).toBe(shadow.sessionId);
        expect(resolve(winner.sessionId)).toEqual({
          ok: true,
          key: sentinel,
          agentId: "main",
        });
        expect(resolve(shadow.sessionId)).toEqual({ ok: true, missing: true });

        for (const change of [{ archivedAt: 2 }, { visibility: "draft" as const }]) {
          replaceSessionEntrySync(
            { agentId: "main", storePath: configuredPath, sessionKey: sentinel },
            { ...winner, ...change },
          );
          expect(resolve(winner.sessionId)).toEqual({ ok: true, missing: true });
          expect(resolve(shadow.sessionId)).toEqual({ ok: true, missing: true });
          expect((await listProjectedSessions({ projection, client, opts })).sessions).toEqual([]);
          expect(projection.describe({ agentId: "main", key: sentinel })?.entry.sessionId).toBe(
            winner.sessionId,
          );
        }
      } finally {
        projection.dispose();
      }
    });
  },
);

it("resolves all selectors from one resident projection and sees committed label changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(scope, entry);
    const projection = await createSessionRowProjection({ cfg });
    const resolve = (p: SessionsResolveParams) =>
      resolveSessionKeyFromResolveParams({ client: null, projection, p });
    try {
      await projection.ensureMaterialized();
      const reads = (["all", "get", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      try {
        for (const p of [
          { key },
          { sessionId: entry.sessionId },
          { label: entry.label },
          { shortId: "12345678" },
          { reference: { key } },
        ]) {
          expect(resolve(p)).toMatchObject({ ok: true, key, agentId: "main" });
        }
        for (const read of reads) {
          expect(read).not.toHaveBeenCalled();
        }
      } finally {
        for (const read of reads) {
          read.mockRestore();
        }
      }
      replaceSessionEntrySync(scope, { ...entry, label: "Updated label" });
      expect(resolve({ label: "Updated label" })).toEqual({ ok: true, key, agentId: "main" });
      expect(resolve({ label: entry.label, allowMissing: true })).toEqual({
        ok: true,
        missing: true,
      });
    } finally {
      projection.dispose();
    }
  });
});

it("searches stored and selected model identities from retained row facts without SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(scope, entry);
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      const reads = (["all", "get", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      try {
        for (const search of ["Original label", "ollama/qwen3", "openai/gpt-5.5", "direct"]) {
          const opts = { search };
          expect(
            filterAndSortSessionEntries({
              ...prepareSessionRowSelection(projection, opts),
              opts,
              now: Date.now(),
            }).map(([selected]) => selected),
          ).toEqual([key]);
        }
        for (const read of reads) {
          expect(read).not.toHaveBeenCalled();
        }
      } finally {
        for (const read of reads) {
          read.mockRestore();
        }
      }
    } finally {
      projection.dispose();
    }
  });
});

it("resolves authorized exact incognito keys without admitting them to discovery or resident rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const incognitoKey = "agent:main:dashboard:incognito-12345678-0aaa-4000-8000-000000000002";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: incognitoKey },
      { sessionId: "private-resolve", updatedAt: 1, incognito: true, label: "Private" },
    );
    const projection = await createSessionRowProjection({ cfg });
    const client = sharingPolicyClient({ scopes: ["operator.admin"] });
    const resolve = (p: SessionsResolveParams) =>
      resolveSessionKeyFromResolveParams({ client, projection, p });
    try {
      expect(resolve({ key: incognitoKey })).toEqual({
        ok: true,
        key: incognitoKey,
        agentId: "main",
      });
      for (const selector of [
        { sessionId: "private-resolve" },
        { label: "Private" },
        { reference: { key: incognitoKey } },
      ]) {
        expect(resolve({ ...selector, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
      }
      expect(
        resolveSessionKeyFromResolveParams({
          client: sharingPolicyClient({ user: "viewer" }),
          projection,
          p: { key: incognitoKey, allowMissing: true },
        }),
      ).toEqual({ ok: true, missing: true });
      expect(projection.selectEntries().length).toBe(0);
    } finally {
      projection.dispose();
    }
  });
});
