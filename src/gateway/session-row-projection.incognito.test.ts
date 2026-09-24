import { expect, it } from "vitest";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabaseByPath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { identifiedClient } from "./server-methods/sessions-read-cache.test-support.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";

it("reads a private parent once despite multiple durable store candidates", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: { default: true }, work: {} } } };
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
    replaceSessionEntrySync(
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
    replaceSessionEntrySync(
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
      expect(projection.snapshot({ agentId: "work", key }).row).toMatchObject({
        key,
        parentSessionKey: parent,
        model: "qwen3:14b",
        modelOverrideSource: "inherited",
      });
      expect(projection.selectEntries().map((row) => row.key)).not.toContain(key);
    } finally {
      projection.dispose();
    }
  });
});

it.each([false, true])(
  "fences transient incognito rows across resets and physical database replacement (archived=%s)",
  async (archived) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const key = "agent:main:dashboard:incognito-generation";
      const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
      const query = { agentId: "main", key, storePath };
      const target = { agentId: "main", sessionKey: key, storePath };
      const entry = {
        sessionId: "ephemeral-id",
        lifecycleRevision: "original",
        updatedAt: 1,
        incognito: true as const,
        archivedAt: archived ? 1 : undefined,
      };
      replaceSessionEntrySync(target, entry);
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
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
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
        expect(
          projection.snapshot(query, { includeDerivedTitles: true, includeLastMessage: true }).row,
        ).toMatchObject({
          activeModelProvider: "row-fixture",
          activeModel: "active",
          derivedTitle: "Private conversation title",
          lastMessagePreview: "Private response",
        });
        expect(
          projection.capture({ ...query, storePath: "/configured/sessions.json" })?.entry,
        ).toEqual(original.entry);
        expect(projection.selectEntries()).toEqual([]);
        sessionChanges.emit({ all: true, scope: "catalog" });
        await projection.ensureMaterialized();
        expect(projection.selectEntries()).toEqual([]);
        const viewer = identifiedClient("incognito-observer");
        const presentation = prepareProjectedSessionPresentation(projection, viewer);
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
        expect(
          projection
            .findBySessionId({ agentId: "main", storePath, sessionId: entry.sessionId })
            .map(({ key: foundKey }) => foundKey),
        ).toEqual([key]);
        replaceSessionEntrySync(target, { ...entry, lifecycleRevision: "reset" });
        await projection.ensureMaterialized();
        expect(projection.isCurrent(original)).toBe(false);
        const reset = projection.capture(query)!;
        expect(projection.isCurrent(reset)).toBe(true);
        closeOpenClawAgentDatabaseByPath(storePath);
        expect(projection.capture(query)).toBeUndefined();
        replaceSessionEntrySync(target, { ...entry, lifecycleRevision: "reset" });
        await projection.ensureMaterialized();
        expect(projection.isCurrent(reset)).toBe(false);
        expect(projection.snapshot(query).row).toMatchObject({ key, sessionId: entry.sessionId });
        expect(projection.selectEntries()).toEqual([]);
      } finally {
        clearAgentRunContext("incognito-live-model");
        projection.dispose();
      }
    });
  },
);
