import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { observeMainThreadReads } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";
import {
  filterAndSortSessionEntries,
  listProjectedSessions,
  prepareSessionRowSelection,
} from "./session-utils-list.js";
import {
  resolveSessionKeyFromResolveParams,
  withPreparedSessionResolve,
} from "./sessions-resolve.js";

afterEach(() => {
  vi.restoreAllMocks();
  memorySessionActorOwners.reset();
});

async function residentProjection(
  config: Parameters<typeof createSessionRowProjection>[0]["cfg"] = cfg,
) {
  const projection = await createSessionRowProjection({ cfg: config });
  return { projection, [Symbol.dispose]: () => projection.dispose() };
}

function preparedResolve(
  projection: Awaited<ReturnType<typeof createSessionRowProjection>>,
  p: SessionsResolveParams,
  client: Parameters<typeof withPreparedSessionResolve>[0]["client"] = null,
) {
  return withPreparedSessionResolve({ client, projection, p }, (result) => result);
}

function resolved(key: string, agentId = "main") {
  return { ok: true, key, agentId };
}
const missing = { ok: true, missing: true };

function observeReads() {
  const reads = observeMainThreadReads();
  return { ...reads, [Symbol.dispose]: () => reads.restore() };
}

function selectedCount(selections: MockInstance<SessionRowProjection["selectEntries"]>) {
  return selections.mock.results.reduce(
    (count, selection) => count + (selection.type === "return" ? selection.value.length : 0),
    0,
  );
}

function seed(values: Parameters<typeof replaceSessionEntrySync>[1] = entry, sessionKey = key) {
  replaceSessionEntrySync({ agentId: "main", sessionKey }, values);
}

function acpMeta(
  sessionKey: string,
  runtimeSessionName: string,
  identity: Pick<
    Parameters<typeof seedCanonicalAcpSessionMeta>[0],
    "sessionId" | "lifecycleRevision"
  >,
) {
  seedCanonicalAcpSessionMeta({
    sessionKey,
    ...identity,
    meta: {
      backend: "fixture",
      agent: "harness",
      runtimeSessionName,
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    },
  });
}

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
    acpMeta(acpKey.replace("agent:harness:", "agent:HARNESS:"), "free-resident", {
      lifecycleRevision: acpEntry.lifecycleRevision,
    });
    addUnrelatedSessions();
    using lifetime = new DisposableStack();
    // Keep idle preview reads outside the Gateway request lifetime.
    lifetime.defer(retainSessionListForegroundWork());
    const { projection } = lifetime.use(await residentProjection());
    await projection.ensureMaterialized();
    using reads = observeReads();
    using describe = vi.spyOn(projection, "describe");
    using selections = vi.spyOn(projection, "selectEntries");
    for (const p of [
      { sessionId: acpEntry.sessionId },
      { label: acpEntry.label },
      { shortId: "12345678" },
    ]) {
      selections.mockClear();
      expect(resolveSessionKeyFromResolveParams({ client: null, projection, p })).toMatchObject(
        resolved(acpKey, "harness"),
      );
      if ("sessionId" in p) {
        expect(selectedCount(selections)).toBeLessThanOrEqual(2);
      }
    }
    expect(describe).not.toHaveBeenCalled();
    expect(
      resolveSessionKeyFromResolveParams({ client: null, projection, p: { key: acpKey } }),
    ).toMatchObject(resolved(acpKey, "harness"));
    reads.expectIdle();
  });
});

const cfg = {
  agents: {
    ownership: "explicit" as const,
    entries: { main: { model: { primary: "openai/gpt-5.5" } } },
  },
};
const key = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";
const entry = {
  sessionId: "resident-resolve",
  updatedAt: 1,
  label: "Original label",
  modelProvider: "ollama",
  model: "qwen3:7b",
};

it.each(["exact", "broad"] as const)(
  "resolves replaced IDs immediately after a %s committed publication",
  async (publication) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      seed();
      using owner = await residentProjection();
      const { projection } = owner;
      const resolve = (sessionId: string) =>
        preparedResolve(projection, { sessionId, allowMissing: true });

      await projection.ensureMaterialized();
      const emit = sessionChanges.emit.bind(sessionChanges);
      using publicationSpy =
        publication === "broad"
          ? vi.spyOn(sessionChanges, "emit").mockImplementation((change, database) => {
              if ("all" in change) {
                return emit(change, database);
              }
              const { agentId, storePath } = change;
              return emit({ all: true, scope: { agentId, storePath } }, database);
            })
          : undefined;
      runOpenClawAgentWriteTransaction(
        (database) => writeSessionEntry(database, key, { ...entry, sessionId: "replacement-id" }),
        { agentId: "main" },
      );
      publicationSpy?.mockRestore();
      expect(await resolve("replacement-id")).toEqual(resolved(key));
      expect(await resolve(entry.sessionId)).toEqual(missing);
      expect(await resolve(key)).toEqual(resolved(key));
    });
  },
);

it.each(["global", "unknown"] as const)(
  "keeps the advertised %s store winner when resolving IDs and filtering discovery",
  async (sentinel) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = { ...cfg, session: { store: state.statePath("stores", "{agentId}.sqlite") } };
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
      using owner = await residentProjection(config);
      const { projection } = owner;
      const client = sharingPolicyClient({ user: "viewer" });
      const opts = { includeGlobal: true, includeUnknown: true };
      const resolve = (sessionId: string) =>
        preparedResolve(projection, { ...opts, sessionId, allowMissing: true }, client);

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
      expect(await resolve(winner.sessionId)).toEqual(resolved(sentinel));
      expect(await resolve(shadow.sessionId)).toEqual(missing);

      for (const change of [{ archivedAt: 2 }, { visibility: "draft" as const }]) {
        replaceSessionEntrySync(
          { agentId: "main", storePath: configuredPath, sessionKey: sentinel },
          { ...winner, ...change },
        );
        expect(await resolve(winner.sessionId)).toEqual(missing);
        expect(await resolve(shadow.sessionId)).toEqual(missing);
        expect((await listProjectedSessions({ projection, client, opts })).sessions).toEqual([]);
        await expect(
          withPreparedSessionResolve(
            { client: null, projection, p: { key: sentinel, allowMissing: true } },
            () => projection.describe({ agentId: "main", key: sentinel })?.entry.sessionId,
          ),
        ).resolves.toBe(winner.sessionId);
      }
    });
  },
);

it("bounds exact resident selection without SQLite and sees committed label changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    seed();
    addUnrelatedSessions();
    using owner = await residentProjection();
    const { projection } = owner;
    const resolve = (p: SessionsResolveParams) => preparedResolve(projection, p);

    await projection.ensureMaterialized();
    {
      using reads = observeReads();
      const selections = vi.spyOn(projection, "selectEntries");

      for (const p of [
        { key },
        { sessionId: entry.sessionId },
        { sessionId: entry.sessionId, agentId: "main" },
        { sessionId: key },
        { label: entry.label },
        { shortId: "12345678" },
        { reference: { key } },
        { reference: { key, slug: "other-session" } },
        { sessionId: "missing-id", allowMissing: true },
        { reference: { key: "agent:main:missing" }, allowMissing: true },
      ]) {
        selections.mockClear();
        expect(await resolve(p)).toMatchObject(p.allowMissing ? missing : resolved(key));
        if ("sessionId" in p || "reference" in p) {
          expect(selectedCount(selections)).toBeLessThanOrEqual(2);
        }
      }
      reads.expectIdle();
    }

    seed({ ...entry, label: "Updated label" });
    expect(await resolve({ label: "Updated label" })).toEqual(resolved(key));
    expect(await resolve({ label: entry.label, allowMissing: true })).toEqual(missing);
  });
});

it("searches stored and selected model identities from retained row facts without SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    seed();
    using owner = await residentProjection();
    const { projection } = owner;

    await projection.ensureMaterialized();
    using reads = observeReads();

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
    reads.expectIdle();
  });
});

it("resolves authorized exact incognito keys without admitting them to discovery or resident rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const incognitoKey = "agent:main:dashboard:incognito-12345678-0aaa-4000-8000-000000000002";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: incognitoKey },
      { sessionId: "private-resolve", updatedAt: 1, incognito: true, label: "Private" },
    );
    using owner = await residentProjection();
    const { projection } = owner;
    const client = sharingPolicyClient({ scopes: ["operator.admin"] });
    const resolve = (p: SessionsResolveParams) => preparedResolve(projection, p, client);

    expect(await resolve({ key: incognitoKey })).toEqual(resolved(incognitoKey));
    for (const selector of [
      { sessionId: "private-resolve" },
      { label: "Private" },
      { reference: { key: incognitoKey } },
    ]) {
      expect(await resolve({ ...selector, allowMissing: true })).toEqual(missing);
    }
    expect(
      resolveSessionKeyFromResolveParams({
        client: sharingPolicyClient({ user: "viewer" }),
        projection,
        p: { key: incognitoKey, allowMissing: true },
      }),
    ).toEqual(missing);
    expect(projection.selectEntries().length).toBe(0);
  });
});

it("prepares a cold exact resolution and refuses consumption after its projection owner changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const archivedKey = "agent:harness:acp:44444444-1111-4111-8111-111111111111";
    replaceSessionEntrySync(
      { agentId: "harness", sessionKey: archivedKey },
      { sessionId: "archived-resolve", updatedAt: 1, archivedAt: 1 },
    );
    acpMeta(archivedKey, "archived-runtime", { sessionId: "archived-resolve" });
    using owner = await residentProjection({});
    const { projection } = owner;
    const consume = vi.fn((result) => result);
    const read = (p: SessionsResolveParams, isCurrent?: () => boolean) =>
      withPreparedSessionResolve({ projection, client: null, p, isCurrent }, consume);

    expect(projection.describe({ agentId: "harness", key: archivedKey })).toBeUndefined();
    {
      using reads = observeReads();

      await expect(read({ shortId: "44444444" })).resolves.toMatchObject(
        resolved(archivedKey, "harness"),
      );
      await expect(read({ key: archivedKey })).resolves.toMatchObject(
        resolved(archivedKey, "harness"),
      );
      reads.expectIdle();
    }

    consume.mockClear();
    await expect(read({ key: archivedKey }, () => false)).rejects.toThrow(
      "Session projection changed",
    );
    expect(consume).not.toHaveBeenCalled();
  });
});
