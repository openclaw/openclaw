import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareCurrentGitHubPublicationIdentity } from "./github-publication-availability.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import {
  emitSessionsChanged,
  flushPendingSessionsChangedEvents,
} from "./server-methods/session-change-event.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  RespondFn,
} from "./server-methods/types.js";
import {
  createGatewaySessionEntryReader,
  prepareGatewaySessionStoreTargetsReadOnly,
  resolveGatewaySessionStoreTargetWithStore,
  resolveGatewaySessionStoreTargetsReadOnly,
} from "./session-utils-store-lookup.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";
import {
  loadCombinedSessionStoreForGatewayCore,
  loadGatewaySessionLifecycleSnapshot,
  loadGatewaySessionRow,
} from "./session-utils.js";

vi.mock("./github-publication-availability.js", () => ({
  prepareCurrentGitHubPublicationIdentity: vi.fn(async (agentId: string) => ({
    source: "system",
    account: { accountId: `account-${agentId}`, login: `synthetic-${agentId}` },
  })),
}));

async function withGlobalSessions(mainKey: string, run: (cfg: OpenClawConfig) => Promise<void>) {
  await withStateDirEnv("gateway-global-lookup-", async ({ stateDir }) => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {}, research: {} } },
      session: {
        scope: "global",
        mainKey,
        store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    try {
      for (const agentId of ["main", "research"]) {
        for (const sessionKey of ["global", `agent:${agentId}:global`]) {
          await replaceSessionEntry(
            { agentId, sessionKey },
            { sessionId: `${agentId}-${sessionKey}`, updatedAt: 1 },
          );
        }
      }
      await run(cfg);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      resetConfigRuntimeState();
    }
  });
}

describe("global session lookup ownership", () => {
  it("keeps a child-relative parent distinct from qualified parent owners", async () => {
    await withGlobalSessions("main", async (cfg) => {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "unknown" },
        { sessionId: "main-unknown", updatedAt: 1 },
      );
      const selected = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: "agent:main:global",
        readOnly: true,
        exactRead: true,
      });
      const read = createGatewaySessionEntryReader({ cfg, ...selected });
      expect(
        ["global", "unknown", "agent:research:main", "agent:research:global"].map(
          (key) => read(key)?.sessionId,
        ),
      ).toEqual([
        "main-global",
        "main-unknown",
        "research-global",
        "research-agent:research:global",
      ]);
    });
  });

  it("prepares full selected entries while retaining an independent target error", async () => {
    await withGlobalSessions("main", async (cfg) => {
      await replaceSessionEntry(
        { agentId: "research", sessionKey: "global" },
        {
          sessionId: "research-global",
          updatedAt: 1,
          skillsSnapshot: { prompt: "selected synthetic prompt", skills: [] },
        },
      );
      const results = prepareGatewaySessionStoreTargetsReadOnly({
        cfg,
        projection: "full",
        targets: [{ key: "agent:research:main" }, { key: "agent:main:main", agentId: "research" }],
      });
      expect(results).toMatchObject([
        {
          ok: true,
          value: {
            agentId: "research",
            store: { global: { skillsSnapshot: { prompt: "selected synthetic prompt" } } },
          },
        },
        { ok: false, error: { message: expect.stringContaining('belongs to "main"') } },
      ]);
    });
  });

  it("keeps deferred errors in visitor order without changing eager batch failure order", async () => {
    await withStateDirEnv("gateway-deferred-lookup-errors-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, research: {} } },
        session: { store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json") },
      };
      for (const directory of ["Retired Agent", "retired-agent"]) {
        const storePath = path.join(stateDir, "agents", directory, "sessions", "sessions.json");
        mkdirSync(path.dirname(storePath), { recursive: true });
        await replaceSessionEntry(
          { agentId: "retired-agent", sessionKey: "agent:retired-agent:main", storePath },
          {
            sessionId: directory === "Retired Agent" ? "retired-first" : "retired-second",
            updatedAt: 1,
          },
        );
      }
      const targets = [
        { key: "agent:retired-agent:main" },
        { key: "agent:main:main", agentId: "research" },
      ];
      expect(() => resolveGatewaySessionStoreTargetsReadOnly({ cfg, targets })).toThrow(
        'belongs to "main"',
      );
      const results = prepareGatewaySessionStoreTargetsReadOnly({
        cfg,
        targets,
        projection: "full",
      });
      expect(results).toMatchObject([
        { ok: false, error: { message: expect.stringContaining("duplicate rows") } },
        { ok: false, error: { message: expect.stringContaining('belongs to "main"') } },
      ]);
    });
  });

  it.each([false, true])(
    "does not plan a replacement after a deleted-main match or selection error (duplicate: %s)",
    async (duplicate) => {
      await withStateDirEnv("gateway-prepared-legacy-owner-", async ({ stateDir }) => {
        const cfg: OpenClawConfig = {
          agents: { ownership: "explicit", entries: { research: {} } },
          session: {
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
        };
        const key = "agent:main:retained";
        for (const sessionKey of duplicate ? [key, "agent:main:main"] : [key]) {
          await replaceSessionEntry(
            { agentId: "main", sessionKey },
            { sessionId: sessionKey, updatedAt: 1 },
          );
        }
        // Normal planning rejects this explicit replacement owner. Legacy success
        // and duplicate selection errors must both finish before that boundary.
        const results = prepareGatewaySessionStoreTargetsReadOnly({
          cfg,
          targets: [{ key, agentId: "research" }],
          projection: "full",
        });
        expect(results).toMatchObject(
          duplicate
            ? [{ ok: false, error: { message: expect.stringContaining("duplicate rows") } }]
            : [{ ok: true, value: { agentId: "main", store: { [key]: { sessionId: key } } } }],
        );
      });
    },
  );

  it.each(["single", "batch", "read-only"] as const)(
    "preserves qualified main aliases and ordinary global keys through %s reads",
    async (mode) => {
      await withGlobalSessions("work", async (cfg) => {
        // Revisit Research after Main so shared sentinels cannot adopt the previous owner.
        const requests = ["research", "main", "research"].flatMap((agentId) =>
          ["main", "work", "global"].map((suffix) => ({
            key: `agent:${agentId}:${suffix}`,
            agentId,
            canonicalKey: suffix === "global" ? `agent:${agentId}:global` : "global",
          })),
        );
        const targets =
          mode === "batch"
            ? resolveGatewaySessionStoreTargetsReadOnly({
                cfg,
                targets: requests.map(({ key }) => ({ key })),
              })
            : requests.map(({ key }) =>
                mode === "single"
                  ? resolveGatewaySessionStoreTargetWithStore({ cfg, key })
                  : loadGatewaySessionEntryReadOnly(key),
              );
        expect(
          targets.map((target) => ({
            agentId: target.agentId,
            canonicalKey: target.canonicalKey,
            sessionId: target.store[target.canonicalKey]?.sessionId,
          })),
        ).toEqual(
          requests.map(({ agentId, canonicalKey }) => ({
            agentId,
            canonicalKey,
            sessionId: `${agentId}-${canonicalKey}`,
          })),
        );
      });
    },
  );

  it.each(["single", "batch", "read-only"] as const)(
    "rejects contradictory key and fixed-store owners through %s reads",
    async (mode) => {
      await withGlobalSessions("main", async (cfg) => {
        const read = (config: OpenClawConfig, key: string, agentId?: string) => {
          setRuntimeConfigSnapshot(config, config);
          return mode === "batch"
            ? resolveGatewaySessionStoreTargetsReadOnly({
                cfg: config,
                targets: [{ key, agentId }],
              })
            : mode === "single"
              ? resolveGatewaySessionStoreTargetWithStore({ cfg: config, key, agentId })
              : loadGatewaySessionEntryReadOnly(key, { agentId });
        };
        for (const key of ["agent:main:main", "agent:main:global"]) {
          expect.soft(() => read(cfg, key, "research")).toThrow('belongs to "main"');
        }
        for (const owner of ["main", "retired"]) {
          const fixed: OpenClawConfig = {
            ...cfg,
            agents: { ...cfg.agents, defaults: { sessionStore: { agentId: owner } } },
            session: {
              ...cfg.session,
              store: cfg.session!.store!.replaceAll("{agentId}", "shared"),
            },
          };
          for (const key of ["global", "agent:research:main"]) {
            expect
              .soft(() => read(fixed, key, "research"))
              .toThrow(owner === "retired" ? 'retired agent "retired"' : 'belongs to "main"');
          }
        }
      });
    },
  );

  it("routes GitHub options and its access recheck to the qualified alias owner", async () => {
    await withGlobalSessions("main", async (cfg) => {
      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      for (const agentId of ["research", "main", "research"]) {
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: `options-${agentId}`,
            method: "sessions.github.options",
            params: { sessionKey: `agent:${agentId}:main` },
          },
          client: null,
          isWebchatConnect: () => false,
          context,
          respond,
        });
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[2]).toBeUndefined();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(respond.mock.calls[0]?.[1]).toEqual({
          personal: null,
          pendingPersonal: null,
          shared: {
            source: "system",
            accountId: `account-${agentId}`,
            login: `synthetic-${agentId}`,
          },
        });
        expect(prepareCurrentGitHubPublicationIdentity).toHaveBeenLastCalledWith(agentId);
      }
    });
  });
});

describe("exact session model projections", () => {
  it.each([
    { selection: "inherited", model: "gpt-5.5", source: "inherited" },
    { selection: "direct", model: "gpt-5.6-sol", source: "user" },
    { selection: "default", model: "gpt-5.4", source: null },
  ] as const)(
    "keeps $selection model selection aligned across list, exact rows and events",
    async ({ selection, model, source }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const cfg: OpenClawConfig = {
          agents: {
            entries: { main: {} },
            defaults: { model: { primary: "openai/gpt-5.4" } },
          },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const parentKey = "agent:main:dashboard:model-parent";
        const childKey = "agent:main:dashboard:model-child";
        await replaceSessionEntry(
          { agentId: "main", sessionKey: parentKey },
          {
            sessionId: "model-parent",
            updatedAt: 1,
            providerOverride: "openai",
            modelOverride: "gpt-5.5",
            modelOverrideSource: "user",
            modelOverrideRouteResolution: "resolved",
          },
        );
        await replaceSessionEntry(
          { agentId: "main", sessionKey: childKey },
          {
            sessionId: "model-child",
            updatedAt: 2,
            parentSessionKey: parentKey,
            ...(selection === "direct"
              ? {
                  providerOverride: "openai",
                  modelOverride: "gpt-5.6-sol",
                  modelOverrideSource: "user" as const,
                  modelOverrideRouteResolution: "resolved" as const,
                }
              : selection === "default"
                ? { modelOverrideSource: "default" as const }
                : {}),
          },
        );
        const expected = { modelProvider: "openai", model, modelOverrideSource: source };
        const context = requestContext(cfg);
        const listed = await listSessions({
          client: identifiedClient("synthetic-model-reader"),
          context,
          request: { agentId: "main", limit: 10 },
        });
        expect(listed.sessions.find((row) => row.key === childKey)).toMatchObject(expected);
        expect.soft(loadGatewaySessionRow(childKey)).toMatchObject(expected);
        expect.soft(loadGatewaySessionLifecycleSnapshot(childKey).row).toMatchObject(expected);

        const described = vi.fn();
        await sessionByKeyReadHandlers["sessions.describe"]!({
          params: { key: childKey },
          req: { type: "req", id: "model-describe", method: "sessions.describe" },
          client: null,
          context,
          isWebchatConnect: () => false,
          respond: described,
        });
        expect(described.mock.calls[0]?.[0]).toBe(true);
        expect.soft(described.mock.calls[0]?.[1]).toMatchObject({ session: expected });

        const history = vi.fn();
        await chatHistoryHandlers["chat.history"]!({
          params: { sessionKey: childKey },
          req: { type: "req", id: "model-history", method: "chat.history" },
          client: null,
          context: createDirectChatContext(),
          isWebchatConnect: () => false,
          respond: history,
        });
        expect(history.mock.calls[0]?.[0]).toBe(true);
        expect.soft(history.mock.calls[0]?.[1]).toMatchObject({ sessionInfo: expected });

        const broadcast = vi.fn();
        const eventContext = {
          ...context,
          getSessionEventSubscriberConnIds: () => new Set(["synthetic-model-viewer"]),
          broadcastToConnIds: broadcast,
        };
        try {
          emitSessionsChanged(eventContext, {
            sessionKey: childKey,
            agentId: "main",
            reason: "patch",
          });
          expect(broadcast.mock.calls[0]?.[0]).toBe("sessions.changed");
          expect.soft(broadcast.mock.calls[0]?.[1]).toMatchObject(expected);
        } finally {
          flushPendingSessionsChangedEvents(eventContext);
        }
      });
    },
  );
});

it.each([
  { selection: "inherited", layout: "separate", model: "qwen3:14b", source: "inherited" },
  { selection: "direct", layout: "separate", model: "llama3.1:8b", source: "user" },
  { selection: "default", layout: "separate", model: "llama3.1:8b", source: null },
  { selection: "inherited", layout: "shared", model: "qwen3:14b", source: "inherited" },
  { selection: "inherited", layout: "cross-agent", model: "qwen3:8b", source: "inherited" },
] as const)(
  "keeps $selection selection on the physical parent across all-agent lists ($layout)",
  async ({ selection, layout, model, source }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const shared = layout === "shared";
      const storePath = shared ? state.statePath("shared.sqlite") : undefined;
      const parentAgent = shared ? "ops" : "work";
      const cfg: OpenClawConfig = {
        session: { scope: "global", ...(storePath ? { store: storePath } : {}) },
        agents: {
          ...(shared ? { ownership: "explicit" } : {}),
          entries: { main: { default: true }, work: {}, ...(shared ? { ops: {} } : {}) },
          defaults: {
            model: { primary: "ollama/llama3.1:8b" },
            ...(shared ? { sessionStore: { agentId: "ops" } } : {}),
          },
        },
      };
      setRuntimeConfigSnapshot(cfg, cfg);
      if (storePath) {
        openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      }
      const catalog = ["llama3.1:8b", "qwen3:8b", "qwen3:14b"].map((id) => ({
        id,
        name: id,
        provider: "ollama",
        contextWindow: 32768,
      }));
      const context = createDirectChatContext({
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalog: async () => catalog,
        readPreparedGatewayModelCatalog: async () => ({ entries: catalog }),
      });
      const request = async (
        handler: GatewayRequestHandler,
        method: string,
        params: Record<string, unknown>,
      ) => {
        const respond = vi.fn();
        await handler({
          req: { type: "req", id: method, method },
          params,
          client: null,
          context,
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond.mock.calls).toHaveLength(1);
        expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0]?.[2])).toBe(true);
        return respond.mock.calls[0]?.[1];
      };
      const parentAgents = shared ? [parentAgent] : ["main", parentAgent];
      for (const agentId of parentAgents) {
        await replaceSessionEntry(
          { agentId, sessionKey: "global", ...(storePath ? { storePath } : {}) },
          { sessionId: `${agentId}-parent`, updatedAt: 1 },
        );
      }
      const foreignParent =
        layout === "cross-agent"
          ? await request(sessionCreateHandlers["sessions.create"]!, "sessions.create", {
              agentId: "main",
            })
          : undefined;
      if (foreignParent) {
        expect(foreignParent.key).toMatch(/^agent:main:dashboard:/);
      }
      const created = await request(sessionCreateHandlers["sessions.create"]!, "sessions.create", {
        agentId: "work",
        parentSessionKey: foreignParent?.key ?? (shared ? "agent:ops:main" : "global"),
      });
      expect(created.key).toMatch(/^agent:work:dashboard:/);
      const childScope = {
        agentId: "work",
        sessionKey: created.key,
        ...(storePath ? { storePath } : {}),
      };
      const unpinned = loadSessionEntry(childScope);
      expect(unpinned).toMatchObject({
        parentSessionKey: foreignParent?.key ?? "global",
        parentSessionId: foreignParent?.sessionId ?? `${parentAgent}-parent`,
      });
      for (const field of ["providerOverride", "modelOverride", "modelOverrideSource"] as const) {
        expect(unpinned?.[field]).toBeUndefined();
      }

      // The child predates these pins, so creation cannot have copied a direct selection.
      for (const agentId of parentAgents) {
        await request(sessionMutationHandlers["sessions.patch"]!, "sessions.patch", {
          key: "global",
          agentId,
          model: agentId === "main" ? "ollama/qwen3:8b" : "ollama/qwen3:14b",
        });
      }
      if (foreignParent) {
        await request(sessionMutationHandlers["sessions.patch"]!, "sessions.patch", {
          key: foreignParent.key,
          agentId: "main",
          model: "ollama/qwen3:8b",
        });
      }
      expect(loadSessionEntry(childScope)?.modelOverride).toBeUndefined();
      if (selection !== "inherited") {
        await request(sessionMutationHandlers["sessions.patch"]!, "sessions.patch", {
          key: created.key,
          agentId: "work",
          model: selection === "default" ? null : "ollama/llama3.1:8b",
        });
      }
      const combined = loadCombinedSessionStoreForGatewayCore(cfg);
      expect(combined.targetsBySessionKey.get("global")?.agentId).toBe(shared ? "ops" : "main");
      expect(combined.store.global?.modelOverride).toBe(shared ? "qwen3:14b" : "qwen3:8b");

      const expected = {
        agentId: "work",
        modelProvider: "ollama",
        model,
        modelOverrideSource: source,
      };
      const client = identifiedClient("synthetic-parent-model-reader");
      const scoped = await listSessions({
        client,
        context,
        request: { agentId: "work", limit: 20 },
      });
      expect.soft(scoped.sessions.find((row) => row.key === created.key)).toMatchObject(expected);
      if (foreignParent) {
        const searched = await listSessions({
          client,
          context,
          request: { agentId: "work", search: model, limit: 20 },
        });
        expect.soft(searched.sessions.some((row) => row.key === created.key)).toBe(true);
      }
      await expect
        .soft(Promise.resolve().then(() => loadGatewaySessionRow(created.key)))
        .resolves.toMatchObject(expected);
      await expect
        .soft(
          request(sessionByKeyReadHandlers["sessions.describe"]!, "sessions.describe", {
            key: created.key,
            agentId: "work",
          }),
        )
        .resolves.toMatchObject({ session: expected });
      await expect
        .soft(
          request(chatHistoryHandlers["chat.history"]!, "chat.history", {
            sessionKey: created.key,
            agentId: "work",
          }),
        )
        .resolves.toMatchObject({ sessionInfo: expected });
      const allAgents = await listSessions({ client, context, request: { limit: 20 } });
      expect(allAgents.sessions.find((row) => row.key === created.key)).toMatchObject(expected);

      const [batched] = resolveGatewaySessionStoreTargetsReadOnly({
        cfg,
        targets: [{ key: created.key, agentId: "work" }],
      });
      const cachedRequest = {
        cfg,
        key: created.key,
        agentId: "work",
        readOnly: true,
        exactRead: true,
        storeCache: new Map(),
      };
      resolveGatewaySessionStoreTargetWithStore(cachedRequest);
      const cached = resolveGatewaySessionStoreTargetWithStore(cachedRequest);
      for (const selected of [batched!, cached]) {
        expect(createGatewaySessionEntryReader({ cfg, ...selected })("global")?.modelOverride).toBe(
          "qwen3:14b",
        );
      }
    });
  },
);
