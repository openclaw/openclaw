import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { identifiedClient } from "./server-methods/sessions-read-cache.test-support.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";

afterEach(() => memorySessionActorOwners.reset());

it("reads a private parent once despite multiple durable store candidates", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      agents: { entries: { main: {}, work: {} }, defaults: { sessionStore: { agentId: "main" } } },
    };
    setRuntimeConfigSnapshot(cfg);
    for (const storePath of [undefined, state.statePath("extra.sqlite")]) {
      replaceSessionEntrySync(
        {
          agentId: "main",
          storePath,
          sessionKey: storePath ? "agent:main:extra" : "agent:main:main",
        },
        { sessionId: storePath ? "extra" : "durable-main", updatedAt: 1 },
      );
    }
    const parent = "agent:main:dashboard:incognito-parent";
    const key = "agent:work:dashboard:incognito-child";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: parent },
      {
        sessionId: "private-parent",
        updatedAt: 1,
        incognito: true,
        providerOverride: "ollama",
        modelOverride: "qwen3:14b",
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
      },
    );
    await replaceSessionEntry(
      { agentId: "work", sessionKey: key },
      { sessionId: "private-child", updatedAt: 2, incognito: true, parentSessionKey: parent },
    );
    const selected = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key,
      agentId: "work",
      exactRead: true,
      includeStoreChildEntries: true,
    });
    expect(selected.store[parent]).toBeUndefined();
    const scoped = loadCombinedSessionStoreForGatewayCore(cfg, {
      agentId: "work",
      includeIncognito: true,
    });
    expect(scoped.targetsBySessionKey.get(key)?.readSourceEntry(parent)?.modelOverride).toBe(
      "qwen3:14b",
    );
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      const query = { agentId: "work", key };
      await projection.withPreparedExactRows(
        () => [query],
        (read) => {
          expect(read.present(read.describe(query)!)).toMatchObject({
            key,
            parentSessionKey: parent,
            model: "qwen3:14b",
            modelOverrideSource: "inherited",
          });
        },
      );
      expect(projection.selectEntries().map((row) => row.key)).not.toContain(key);
    } finally {
      projection.dispose();
    }
  });
});

it("keeps archived incognito rows private and retires captures when their session or owner closes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:dashboard:incognito-generation";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    const query = { agentId: "main", key, storePath };
    const target = { agentId: "main", sessionKey: key, storePath };
    const entry = {
      sessionId: "ephemeral-id",
      lifecycleRevision: "original",
      updatedAt: 1,
      incognito: true as const,
      archivedAt: 1,
    };
    await replaceSessionEntry(target, entry);
    await persistSessionTranscriptTurn(
      { ...target, sessionId: entry.sessionId },
      {
        messages: [
          { message: { role: "user", content: "Private conversation title" } },
          { message: { role: "assistant", content: "Private response" } },
        ],
        touchSessionEntry: false,
      },
    );
    const projection = await createSessionRowProjection({ cfg, getModelCatalog: async () => [] });
    try {
      const original = projection.capture(query)!;
      expect(original?.entry?.sessionId).toBe(entry.sessionId);
      expect(projection.isCurrent(original)).toBe(true);
      registerAgentRunContext("incognito-live-model", {
        agentId: "main",
        sessionKey: key,
        sessionId: entry.sessionId,
        activeModel: { provider: "row-fixture", model: "active" },
      });
      await projection.withPreparedExactRows(
        () => [query],
        (read) => {
          expect(
            read.present(read.describe(query)!, {
              includeDerivedTitles: true,
              includeLastMessage: true,
            }),
          ).toMatchObject({
            activeModelProvider: "row-fixture",
            activeModel: "active",
            derivedTitle: "Private conversation title",
            lastMessagePreview: "Private response",
          });
        },
      );
      expect(
        projection.capture({ ...query, storePath: "/configured/sessions.json" })?.entry,
      ).toEqual(original.entry);
      expect(projection.selectEntries()).toEqual([]);
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      expect(projection.selectEntries()).toEqual([]);
      const viewer = identifiedClient("incognito-observer");
      await projection.withPreparedExactRows(
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
      expect(
        projection
          .findBySessionId({ agentId: "main", storePath, sessionId: entry.sessionId })
          .map(({ key: foundKey }) => foundKey),
      ).toEqual([key]);
      expect(
        projection
          .findBySessionId({ agentId: "main", sessionId: entry.sessionId, federated: true })
          .map((row) => row.key),
      ).toEqual([key]);
      expect(projection.selectEntries()).toEqual([]);
      const internal = resolveInternalSessionEffectsIdentity({
        agentId: "main",
        incognito: true,
        runId: "private-maintenance",
      });
      const internalScope = { agentId: "main", storePath, ...internal };
      await replaceSessionEntry(internalScope, { ...entry, sessionId: internal.sessionId });
      await persistSessionTranscriptTurn(internalScope, {
        messages: [{ message: { role: "assistant", content: "Internal maintenance" } }],
        touchSessionEntry: false,
      });
      // Exact internal readers may address their private row; discovery must not.
      expect(projection.findBySessionId(internalScope).map((row) => row.key)).toEqual([
        internal.sessionKey,
      ]);
      expect(
        projection.findBySessionId({
          agentId: "main",
          sessionId: internal.sessionId,
          federated: true,
        }),
      ).toEqual([]);
      memorySessionActorOwners.closeSession({ agentId: "main", path: storePath }, key);
      await replaceSessionEntry(target, entry);
      await projection.ensureMaterialized();
      expect(projection.isCurrent(original)).toBe(false);
      const reset = projection.capture(query)!;
      expect(projection.isCurrent(reset)).toBe(true);
      memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
      expect(projection.capture(query)).toBeUndefined();
      await replaceSessionEntry(target, entry);
      await projection.ensureMaterialized();
      expect(projection.isCurrent(reset)).toBe(false);
      await projection.withPreparedExactRows(
        () => [query],
        (read) => {
          expect(read.present(read.describe(query)!)).toMatchObject({
            key,
            sessionId: entry.sessionId,
          });
        },
      );
      expect(projection.selectEntries()).toEqual([]);
    } finally {
      clearAgentRunContext("incognito-live-model");
      projection.dispose();
    }
  });
});
