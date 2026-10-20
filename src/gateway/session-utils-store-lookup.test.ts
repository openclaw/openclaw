import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.native.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareCurrentGitHubPublicationOptionsIdentity } from "./github-publication-availability.js";
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
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  resolveGatewaySessionStoreTargetWithStoreAsync,
  withGatewaySessionStoreTarget,
} from "./session-utils-store-lookup.js";
import { withQualifiedGatewaySessionStoreTarget } from "./session-utils-store-retained.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { withStateDirEnv } from "./session-utils.test-support.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

afterEach(() => memorySessionActorOwners.reset());

vi.mock("./github-publication-availability.js", async () => {
  const actual = await vi.importActual<typeof import("./github-publication-availability.js")>(
    "./github-publication-availability.js",
  );
  return {
    ...actual,
    prepareCurrentGitHubPublicationOptionsIdentity: vi.fn(async (agentId: string) => ({
      source: "system",
      account: { accountId: `account-${agentId}`, login: `synthetic-${agentId}` },
    })),
  };
});

afterEach(() => resetConfigRuntimeState());

function seedEntry(
  key: string,
  sessionId: string,
  fields: Partial<SessionEntry> = {},
  agentId = "main",
) {
  return replaceSessionEntry({ agentId, sessionKey: key }, { sessionId, updatedAt: 1, ...fields });
}

const handlers = {
  ...sessionCreateHandlers,
  ...sessionMutationHandlers,
  ...sessionByKeyReadHandlers,
  ...chatHistoryHandlers,
};

async function request(
  context: GatewayRequestContext,
  method: string,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  await handlers[method]!({
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
}

async function expectModelViews(
  context: GatewayRequestContext,
  key: string,
  agentId: string,
  expected: Partial<GatewaySessionRow>,
  historyContext = context,
) {
  const row = getSessionRowProjection(context)?.snapshot({ key, agentId }).row;
  const described = await request(context, "sessions.describe", { key, agentId });
  const history = await request(historyContext, "chat.history", { sessionKey: key, agentId });
  expect.soft({ row, described, history }).toMatchObject({
    row: expected,
    described: { session: expected },
    history: { sessionInfo: expected },
  });
}

function configureStores(
  stateDir: string,
  agentIds: string[],
  session: OpenClawConfig["session"] = {},
) {
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
    session: {
      store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      ...session,
    },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  return cfg;
}

async function withGlobalSessions(mainKey: string, run: (cfg: OpenClawConfig) => Promise<void>) {
  await withStateDirEnv("gateway-global-lookup-", async ({ stateDir }) => {
    const cfg = configureStores(stateDir, ["main", "research"], { scope: "global", mainKey });
    for (const agentId of ["main", "research"]) {
      for (const sessionKey of ["global", `agent:${agentId}:global`]) {
        await seedEntry(sessionKey, `${agentId}-${sessionKey}`, {}, agentId);
      }
    }
    await run(cfg);
  });
}

describe("global session lookup ownership", () => {
  it("rejects an unreadable canonical candidate instead of returning its alias", async () => {
    await withGlobalSessions("main", async (cfg) => {
      const alias = "agent:main:main";
      await seedEntry(alias, "retained-alias");
      await resolveGatewaySessionStoreTargetWithStoreAsync({ cfg, key: "agent:main:global" });
      await runOpenClawAgentWriteAdmission({ agentId: "main" }, () => {
        openOpenClawAgentDatabase({ agentId: "main" })
          .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run("{", "global");
      });

      await expect(
        resolveGatewaySessionStoreTargetInWorker({
          cfg,
          key: alias,
          projection: "list",
          exactRead: true,
          readOnly: false,
        }),
      ).rejects.toThrow(/persisted row.*global/u);
    });
  });

  it("does not create a database for a retired scalar owner", async () => {
    await withStateDirEnv("gateway-scalar-store-admission-", async ({ stateDir }) => {
      const cfg = configureStores(stateDir, ["main"]);
      const key = "agent:retired:dashboard:new-session";
      expect(
        await resolveGatewaySessionStoreTargetInWorker({
          cfg,
          key,
          projection: "list",
          exactRead: true,
          readOnly: false,
        }),
      ).toMatchObject({
        agentId: "retired",
        canonicalKey: key,
        storeKeys: [key],
        storePath: path.join(stateDir, "agents", "retired", "sessions", "sessions.json"),
      });
      expect(existsSync(resolveOpenClawAgentSqlitePath({ agentId: "retired" }))).toBe(false);
    });
  });

  it("preserves exact lookup failures without retrying an alias", async () => {
    await withGlobalSessions("main", async (cfg) => {
      const failure = new Error("metadata unavailable", { cause: new Error("SQLITE_IOERR") });
      const failingPreparedRead = vi.fn(() => {
        throw failure;
      });
      await expect(
        resolveGatewaySessionStoreTargetWithStoreAsync({
          cfg,
          key: "agent:main:main",
          exactRead: true,
          readStore: failingPreparedRead,
        }),
      ).rejects.toThrow(failure);
      expect(failingPreparedRead).toHaveBeenCalledOnce();
    });
  });

  it.each([false, true])(
    "does not plan a replacement after a deleted-main match or selection error (duplicate: %s)",
    async (duplicate) => {
      await withStateDirEnv("gateway-prepared-legacy-owner-", async ({ stateDir }) => {
        const cfg = configureStores(stateDir, ["research"]);
        const key = "agent:main:retained";
        for (const sessionKey of duplicate ? [key, "agent:main:main"] : [key]) {
          await seedEntry(sessionKey, sessionKey);
        }
        // Normal planning rejects this explicit replacement owner. Legacy success
        // and duplicate selection errors must both finish before that boundary.
        const resolve = async () =>
          await resolveGatewaySessionStoreTargetWithStoreAsync({
            cfg,
            key,
            agentId: "research",
            exactRead: true,
            readOnly: true,
            projection: "full",
          });
        if (duplicate) {
          await expect(resolve()).rejects.toThrow("duplicate rows");
        } else {
          expect(await resolve()).toMatchObject({
            agentId: "main",
            store: { [key]: { sessionId: key } },
          });
        }
      });
    },
  );

  it("rejects contradictory key and fixed-store owners", async () => {
    await withGlobalSessions("main", async (cfg) => {
      const read = async (config: OpenClawConfig, key: string, agentId?: string) => {
        setRuntimeConfigSnapshot(config, config);
        return await resolveGatewaySessionStoreTargetWithStoreAsync({ cfg: config, key, agentId });
      };
      for (const key of ["agent:main:main", "agent:main:global"]) {
        await expect.soft(read(cfg, key, "research")).rejects.toThrow('belongs to "main"');
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
          await expect
            .soft(read(fixed, key, "research"))
            .rejects.toThrow(owner === "retired" ? 'retired agent "retired"' : 'belongs to "main"');
        }
      }
    });
  });

  it("routes GitHub options and its access recheck to the qualified alias owner", async () => {
    await withGlobalSessions("main", async (cfg) => {
      const latestShared = vi.fn<
        NonNullable<GatewayRequestContext["githubPublicationService"]>["latestShared"]
      >(async () => null);
      const context = {
        getRuntimeConfig: () => cfg,
        githubPublicationService: { latestShared },
      } as unknown as GatewayRequestContext;
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
          latestShared: null,
          shared: {
            source: "system",
            accountId: `account-${agentId}`,
            login: `synthetic-${agentId}`,
          },
        });
        expect(prepareCurrentGitHubPublicationOptionsIdentity).toHaveBeenLastCalledWith(
          agentId,
          expect.any(Function),
        );
        expect(latestShared).toHaveBeenLastCalledWith(
          expect.objectContaining({
            agentId,
            sessionKey: "global",
            sessionId: agentId + "-global",
          }),
          undefined,
          expect.any(Function),
          expect.any(Function),
        );
      }
    });
  });
});

describe("retained exact row publications", () => {
  it.each(["lookup", "qualified"] as const)(
    "keeps %s rows through non-row events but fences members, aliases and topology",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {}, research: {} } },
          session: { scope: "global" },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const key = "global";
        await seedEntry(key, "retained-row");
        await seedEntry(key, "unrelated-row", {}, "research");
        const unrelatedDatabase = openOpenClawAgentDatabase({ agentId: "research" });
        const selected = await withGatewaySessionStoreTarget(
          { cfg, key: "main", agentId: "main" },
          (target) => target,
        );
        const scope = { agentId: "main", sessionKey: key, storePath: selected.storePath };
        addSessionMember(scope, { identityId: "revoked-member", addedBy: "owner" });
        const read = (consume: (assertCurrent: () => void) => void) =>
          mode === "lookup"
            ? withGatewaySessionStoreTarget(
                { cfg, key: "main", agentId: "main", includeMembership: true },
                (_target, _members, assert) => consume(assert),
              )
            : withQualifiedGatewaySessionStoreTarget({
                target: {
                  agentId: selected.agentId,
                  canonicalKey: selected.canonicalKey,
                  requestedKey: "main",
                  storeKey: key,
                  storeKeys: selected.storeKeys,
                  storePath: selected.storePath,
                  readSource: selected.capturedReadSource,
                  keyFormat: "agent-qualified",
                },
                logicalStorePath: selected.storePath,
                includeMembership: true,
                consume: (_target, _members, assert) => consume(assert),
              });
        await read((assertCurrent) => {
          for (const publicationScope of [
            "agent-runs",
            "subagent-runs",
            "profiles",
            "catalog",
            "config",
            "config-presentation",
            "config-profiles",
            "runtime",
            "acp",
            "worker-placements",
            "worker-environments",
          ]) {
            sessionChanges.emit({ all: true, scope: publicationScope });
            assertCurrent();
          }
          sessionChanges.emit({ sessionKey: key, agentId: "main" });
          sessionChanges.emit({ sessionKey: key, scope: "runtime" });
          sessionChanges.emit({ sessionKey: key, scope: "automation" });
          sessionChanges.emit({ all: true, scope: { agentId: "other" } });
          sessionChanges.emit({
            sessionKey: "agent:main:other",
            storePath: selected.storePath,
          });
          assertCurrent();
        });
        await read((assertCurrent) => {
          addSessionMember(
            { agentId: "research", sessionKey: key },
            { identityId: "unrelated-member", addedBy: "owner" },
          );
          sessionChanges.emit({
            all: true,
            scope: { agentId: "research", storePath: unrelatedDatabase.path },
          });
          expect(assertCurrent, "unrelated physical store publication").not.toThrow();
        });
        await read((assertCurrent) => {
          expect(removeSessionMember(scope, "revoked-member")?.identityId).toBe("revoked-member");
          expect(assertCurrent).toThrow("Session sharing facts changed during read");
        });
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const aliasDirectory = path.join(
          path.dirname(path.dirname(database.path)),
          "membership-alias",
        );
        symlinkSync(path.dirname(database.path), aliasDirectory, "junction");
        const aliasPath = path.join(aliasDirectory, path.basename(database.path));
        openOpenClawAgentDatabase({ agentId: "main", path: aliasPath });
        await read((assertCurrent) => {
          addSessionMember(
            { agentId: "main", sessionKey: key, storePath: aliasPath },
            { identityId: "aliased-member", addedBy: "owner" },
          );
          expect(assertCurrent).toThrow("Session sharing facts changed during read");
        });
        const publications: SessionRowChange[] = [
          { all: true, scope: "stores" },
          { all: true, scope: { agentId: "main", storePath: selected.storePath } },
          // Both the canonical row and its request aliases remain publication dependencies.
          { sessionKey: "main", storePath: selected.storePath, facts: { kind: "removed" } },
        ];
        for (const publication of publications) {
          await read((assertCurrent) => {
            assertCurrent();
            sessionChanges.emit(publication);
            expect(assertCurrent).toThrow("Session sharing facts changed during read");
          });
        }
      });
    },
  );

  it("reads current incognito snapshots without SQL and rejects released consumers and closed owners", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const key = "agent:main:dashboard:incognito-retained";
      const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
      await withGatewaySessionStoreTarget(
        { cfg, key, includeMembership: true },
        (target, members, assertCurrent) => {
          expect(target.store[key]).toBeUndefined();
          expect(members.get(key)).toEqual([]);
          expect(assertCurrent).not.toThrow();
        },
      );
      await replaceSessionEntry(
        { agentId: "main", sessionKey: key, storePath },
        { sessionId: "incognito-retained", updatedAt: 1, incognito: true },
      );
      let retained: (() => void) | undefined;
      await withGatewaySessionStoreTarget(
        { cfg, key, includeMembership: true },
        (target, _members, assertCurrent) => {
          retained = assertCurrent;
          expect(target.store[key]?.sessionId).toBe("incognito-retained");
          const sql = observeHostDataSql();
          try {
            for (let i = 0; i < 3; i++) {
              assertCurrent();
            }
            expect(sql.queries).toEqual([]);
            sessionChanges.emit({ all: true, scope: "stores" });
            sessionChanges.emit({
              all: true,
              scope: { agentId: "main", storePath: "durable.sqlite", topology: true },
            });
            sessionChanges.emit({ all: true, scope: "agent-runs" });
            sessionChanges.emit({ all: true, scope: "profiles" });
            assertCurrent();
            expect(sql.queries).toEqual([]);
          } finally {
            sql.restore();
          }
        },
      );
      expect(retained).toBeTypeOf("function");
      expect(retained).toThrow("Incognito session source is no longer retained");
      await replaceSessionEntry(
        { agentId: "main", sessionKey: key, storePath },
        { sessionId: "incognito-retained", updatedAt: 2, incognito: true, label: "Current" },
      );
      await withGatewaySessionStoreTarget({ cfg, key }, (target, _members, assertCurrent) => {
        expect(target.store[key]?.label).toBe("Current");
        memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
        expect(assertCurrent).toThrow("closed");
      });
    });
  });
});

it("keeps inherited model selection aligned across list, exact rows and events", async () => {
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
    await seedEntry(parentKey, "model-parent", {
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    });
    await seedEntry(childKey, "model-child", {
      updatedAt: 2,
      parentSessionKey: parentKey,
    });
    const expected: Partial<GatewaySessionRow> = {
      modelProvider: "openai",
      model: "gpt-5.5",
      modelOverrideSource: "inherited",
    };
    const context = requestContext(cfg);
    const listed = await listSessions({
      client: identifiedClient("synthetic-model-reader"),
      context,
      request: { agentId: "main", limit: 10 },
    });
    expect(listed.sessions.find((row) => row.key === childKey)).toMatchObject(expected);
    await expectModelViews(
      context,
      childKey,
      "main",
      expected,
      createDirectChatContext({
        sessionRowProjectionOwner: context.sessionRowProjectionOwner,
      }),
    );

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
      await flushPendingSessionsChangedEvents(eventContext);
      expect(broadcast.mock.calls[0]?.[0]).toBe("sessions.changed");
      expect.soft(broadcast.mock.calls[0]?.[1]).toMatchObject({ session: expected });
    } finally {
      await flushPendingSessionsChangedEvents(eventContext);
    }
  });
});

it.each([
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
          entries: { main: {}, work: {}, ...(shared ? { ops: {} } : {}) },
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
      const invoke = (method: string, params: Record<string, unknown>) =>
        request(context, method, params);
      const parentAgents = shared ? [parentAgent] : ["main", parentAgent];
      for (const agentId of parentAgents) {
        await replaceSessionEntry(
          { agentId, sessionKey: "global", ...(storePath ? { storePath } : {}) },
          { sessionId: `${agentId}-parent`, updatedAt: 1 },
        );
      }
      const foreignParent =
        layout === "cross-agent"
          ? await invoke("sessions.create", {
              agentId: "main",
            })
          : undefined;
      if (foreignParent) {
        expect(foreignParent.key).toMatch(/^agent:main:dashboard:/);
      }
      const created = await invoke("sessions.create", {
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
        await invoke("sessions.patch", {
          key: "global",
          agentId,
          model: agentId === "main" ? "ollama/qwen3:8b" : "ollama/qwen3:14b",
        });
      }
      if (foreignParent) {
        await invoke("sessions.patch", {
          key: foreignParent.key,
          agentId: "main",
          model: "ollama/qwen3:8b",
        });
      }
      expect(loadSessionEntry(childScope)?.modelOverride).toBeUndefined();
      if (selection !== "inherited") {
        await invoke("sessions.patch", {
          key: created.key,
          agentId: "work",
          model: null,
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
      await expectModelViews(context, created.key, "work", expected);
      const allAgents = await listSessions({ client, context, request: { limit: 20 } });
      expect(allAgents.sessions.find((row) => row.key === created.key)).toMatchObject(expected);
    });
  },
);
