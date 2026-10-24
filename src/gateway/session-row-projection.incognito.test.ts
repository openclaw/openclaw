import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.native.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import * as sessions from "../config/sessions/session-accessor.js";
import type { SessionEntryReadScope } from "../config/sessions/session-accessor.types.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { identifiedClient } from "./server-methods/sessions-read-cache.test-support.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import type { Lookup, SnapshotOptions } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { createTestProjection } from "./session-row-projection.read-fixture.test-support.js";
import { appendProjectionMessages } from "./session-row-projection.test-support.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import { resolveGatewaySessionStoreTargetWithStoreAsync } from "./session-utils-store-lookup.js";

afterEach(() => memorySessionActorOwners.reset());

const cfg = { agents: { entries: { main: {} } } };
const sessionScope = { agentId: "main", sessionKey: "agent:main:dashboard:incognito-test" };
const rowQuery = { agentId: sessionScope.agentId, key: sessionScope.sessionKey };
const baseEntry = {
  sessionId: "private-original",
  updatedAt: 1,
  incognito: true,
} satisfies InternalSessionEntry;
function writePrivate(target: SessionEntryReadScope, patch: Partial<InternalSessionEntry> = {}) {
  return sessions.replaceSessionEntry(target, { ...baseEntry, ...patch });
}

function findKeys(
  rows: SessionRowProjection,
  query: Parameters<SessionRowProjection["findBySessionId"]>[0],
) {
  return rows.findBySessionId(query).map((row) => row.key);
}

function presentExact(rows: SessionRowProjection, query: Lookup, options?: SnapshotOptions) {
  return rows.withPreparedExactRows(
    () => [query],
    (read) => read.present(read.describe(query)!, options),
  );
}

it("finds retained incognito sessions from an explicit root distinct from the ambient root", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot(cfg);
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: state.path("previous-root") },
    });
    const target = { ...sessionScope, storePath },
      key = target.sessionKey;
    await writePrivate(target);
    using rows = await createTestProjection({ cfg, modelCatalog: [] });
    const query = { agentId: "main", sessionId: "private-original", federated: true };
    expect(rows.findBySessionId(query)).toMatchObject([
      { key, storeTarget: { storePath }, entry: { sessionId: "private-original" } },
    ]);
    expect(rows.findBySessionId({ ...target, sessionId: "private-original" })).toMatchObject([
      { key, entry: { sessionId: "private-original" } },
    ]);
    await writePrivate(target, { sessionId: "private-current", updatedAt: 2 });
    expect(rows.findBySessionId(query)).toEqual([]);
    expect(rows.findBySessionId({ ...query, sessionId: "private-current" })).toMatchObject([
      { key, storeTarget: { storePath }, entry: { sessionId: "private-current" } },
    ]);
  });
});

it("reads a private parent once despite multiple durable store candidates", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sharedConfig = {
      agents: { entries: { main: {}, work: {} }, defaults: { sessionStore: { agentId: "main" } } },
    };
    setRuntimeConfigSnapshot(sharedConfig);
    for (const storePath of [undefined, state.statePath("extra.sqlite")]) {
      sessions.replaceSessionEntrySync(
        {
          agentId: "main",
          storePath,
          sessionKey: storePath ? "agent:main:extra" : "agent:main:main",
        },
        { sessionId: storePath ? "extra" : "durable-main", updatedAt: 1 },
      );
    }
    const parent = sessionScope.sessionKey,
      key = "agent:work:dashboard:incognito-child";
    await writePrivate(sessionScope, {
      sessionId: "private-parent",
      providerOverride: "ollama",
      modelOverride: "qwen3:14b",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    });
    await writePrivate(
      { agentId: "work", sessionKey: key },
      {
        sessionId: "private-child",
        updatedAt: 2,
        parentSessionKey: parent,
      },
    );
    const selected = await resolveGatewaySessionStoreTargetWithStoreAsync({
      cfg: sharedConfig,
      key,
      agentId: "work",
      exactRead: true,
      includeStoreChildEntries: true,
    });
    expect(selected.store[parent]).toBeUndefined();
    const scoped = loadCombinedSessionStoreForGatewayCore(sharedConfig, {
      agentId: "work",
      includeIncognito: true,
    });
    expect(scoped.targetsBySessionKey.get(key)?.readSourceEntry(parent)?.modelOverride).toBe(
      "qwen3:14b",
    );
    using rows = await createTestProjection({ cfg: sharedConfig, modelCatalog: [] });
    const query = { agentId: "work", key };
    expect(await presentExact(rows, query)).toMatchObject({
      key,
      parentSessionKey: parent,
      model: "qwen3:14b",
      modelOverrideSource: "inherited",
    });
    expect(rows.selectEntries().map((row) => row.key)).not.toContain(key);
  });
});

it("keeps archived incognito rows private and retires captures when their session or owner closes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    const entry = {
      ...baseEntry,
      sessionId: "ephemeral-id",
      lifecycleRevision: "original",
      archivedAt: 1,
    };
    const query = { ...rowQuery, storePath },
      { key } = query;
    const target = { ...sessionScope, storePath };
    await writePrivate(target, entry);
    await appendProjectionMessages(
      { ...target, sessionId: entry.sessionId },
      { role: "user", content: "Private conversation title" },
      { role: "assistant", content: "Private response" },
    );
    const viewer = identifiedClient("incognito-observer");
    using rows = await createTestProjection({ cfg, getModelCatalog: async () => [] });
    using cleanup = new DisposableStack();
    cleanup.defer(() => clearAgentRunContext("incognito-live-model"));
    const owner = memorySessionActorOwners.read({ agentId: "main", path: storePath })!;
    const actor = (await owner.acquireExisting(key, {
      assertCurrent() {},
      assertReadable() {},
    }))!;
    await actor.release();
    const original = runWithSessionActorStorage(
      {
        actor,
        agentId: "main",
        path: storePath,
        authority: { assertCurrent() {}, authorize() {} },
      },
      () => rows.capture(query),
    )!;
    expect(original?.entry?.sessionId).toBe(entry.sessionId);
    expect(rows.isCurrent(original)).toBe(true);
    registerAgentRunContext("incognito-live-model", {
      agentId: "main",
      sessionKey: key,
      sessionId: entry.sessionId,
      activeModel: { provider: "row-fixture", model: "active" },
    });
    expect(
      await presentExact(rows, query, {
        includeDerivedTitles: true,
        includeLastMessage: true,
      }),
    ).toMatchObject({
      activeModelProvider: "row-fixture",
      activeModel: "active",
      derivedTitle: "Private conversation title",
      lastMessagePreview: "Private response",
    });
    expect(rows.capture({ ...query, storePath: "/configured/sessions.json" })?.entry).toEqual(
      original.entry,
    );
    expect(rows.selectEntries()).toEqual([]);
    sessionChanges.emit({ all: true, scope: "catalog" });
    await rows.ensureMaterialized();
    expect(rows.selectEntries()).toEqual([]);
    await rows.withPreparedExactRows(
      () => [query],
      (read) => {
        const presentation = prepareProjectedSessionPresentation(read, viewer);
        expect(presentation.authorizeDescription(query)?.message).toContain("not found");
        expect(
          canReceiveSessionEvent({
            cfg,
            client: viewer,
            sessionKeys: [key],
            agentId: "main",
            event: "session.message",
            payload: { sessionKey: key },
            prepared: { sharing: presentation.sharing, target: () => presentation.target(query) },
          }),
        ).toBe(false);
      },
    );
    const identity = { agentId: "main", sessionId: entry.sessionId };
    expect(findKeys(rows, { ...identity, storePath })).toEqual([key]);
    expect(findKeys(rows, { ...identity, federated: true })).toEqual([key]);
    expect(rows.selectEntries()).toEqual([]);
    const internal = resolveInternalSessionEffectsIdentity({
      agentId: "main",
      incognito: true,
      runId: "private-maintenance",
    });
    const internalScope = { agentId: "main", storePath, ...internal };
    await sessions.replaceSessionEntry(internalScope, { ...entry, sessionId: internal.sessionId });
    await appendProjectionMessages(internalScope, {
      role: "assistant",
      content: "Internal maintenance",
    });
    // Exact internal readers may address their private row; discovery must not.
    expect(findKeys(rows, internalScope)).toEqual([internal.sessionKey]);
    expect(
      rows.findBySessionId({
        agentId: "main",
        sessionId: internal.sessionId,
        federated: true,
      }),
    ).toEqual([]);
    memorySessionActorOwners.closeSession({ agentId: "main", path: storePath }, key);
    expect(rows.capture(query)).toBeUndefined();
    await writePrivate(target, entry);
    await rows.ensureMaterialized();
    expect(rows.isCurrent(original)).toBe(false);
    const reset = rows.capture(query)!;
    expect(rows.isCurrent(reset)).toBe(true);
    memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
    expect(rows.capture(query)).toBeUndefined();
    await writePrivate(target, entry);
    await rows.ensureMaterialized();
    expect(rows.isCurrent(reset)).toBe(false);
    expect(await presentExact(rows, query)).toMatchObject({
      key,
      sessionId: entry.sessionId,
    });
    expect(rows.selectEntries()).toEqual([]);
  });
});
