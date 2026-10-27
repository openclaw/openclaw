import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { AgentsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as avatarRuntime from "../../agents/identity-avatar-file-runtime.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  resolveSessionStorePathCore as resolveStorePath,
  SESSION_TOTAL_TOKENS_VERSION,
  type SessionEntry,
} from "../../config/sessions.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recordAgentProvenance } from "../../state/agent-provenance.js";
import {
  listOpenClawRegisteredAgentDatabases,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { gatewayProfile } from "../server/client-fixtures.test-support.js";
import { createSessionGoalFixture } from "../session-goal.test-support.js";
import { closeSessionSqliteDatabasesForTest } from "../session-utils.test-support.js";
import { testState } from "../test-helpers.js";
import {
  getGatewayConfigModule,
  directSessionReq,
  seedLinearSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { agentsHandlers } from "./agents.js";
import {
  identifiedClient,
  listSessions,
  profileSessionEntry,
  requestContext,
} from "./sessions-read-cache.test-support.js";
import { soloClient } from "./sessions-sharing.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

setupGatewaySessionsHandlerTestHarness();

const UNKNOWN_AGENT_ID = "ghost";
const UNKNOWN_SESSION_KEY = `agent:${UNKNOWN_AGENT_ID}:zzz`;
const THREAD_KEYS = [
  "agent:main:thread:12345678-0aaa-4000-8000-000000000001",
  "agent:main:thread:12345678-0bbb-4000-8000-000000000002",
] as const;

function sessionScope(
  sessionKey: string,
  agentId = "main",
  storePath = resolveStorePath(undefined, { agentId }),
) {
  return { agentId, sessionKey, storePath };
}

async function seedEntry(
  sessionKey: string,
  entry: Partial<SessionEntry>,
  agentId = "main",
  storePath?: string,
) {
  await replaceSessionEntry(sessionScope(sessionKey, agentId, storePath), {
    sessionId: sessionKey,
    updatedAt: 42,
    ...entry,
  });
}

async function previews(keys: string[]) {
  return (
    await directSessionReq<{
      previews: Array<{ key: string; status: string; items: unknown[] }>;
    }>("sessions.preview", { keys })
  ).payload?.previews;
}

async function expectRead(
  method: Parameters<typeof directSessionReq>[0],
  params: Record<string, unknown>,
  payload: unknown,
) {
  expect(await directSessionReq(method, params)).toMatchObject({ ok: true, payload });
}

async function expectInvalidRead(
  method: Parameters<typeof directSessionReq>[0],
  params: Record<string, unknown>,
  message?: string,
) {
  expect(await directSessionReq(method, params)).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      ...(message ? { message: expect.stringContaining(message) } : {}),
    },
  });
}

function registeredDatabases() {
  return listOpenClawRegisteredAgentDatabases({ env: { OPENCLAW_STATE_DIR: requireStateDir() } });
}

function agentDatabasePath(agentId: string) {
  return resolveOpenClawAgentSqlitePath({
    agentId,
    env: { OPENCLAW_STATE_DIR: requireStateDir() },
  });
}

async function seedReadableSession(
  scope: { agentId: string; sessionKey: string; storePath: string },
  text: string,
  sessionId = scope.sessionKey,
) {
  await replaceSessionEntry(scope, { sessionId, updatedAt: 42 });
  await seedLinearSessionTranscript({ ...scope, sessionId, contents: [text] });
}

function requireStateDir(): string {
  return expectDefined(process.env.OPENCLAW_STATE_DIR, "OPENCLAW_STATE_DIR is required");
}

async function listAgentsViaRpc(
  includeSystem = false,
  catalogContext: Partial<GatewayRequestContext> = {},
  client?: GatewayClient,
): Promise<AgentsListResult> {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const respond = vi.fn<RespondFn>();
  await agentsHandlers["agents.list"]?.({
    req: {} as never,
    params: {},
    respond,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: async () => [],
      readPreparedGatewayModelCatalog: async () => ({ entries: [] }),
      ...catalogContext,
    } as unknown as GatewayRequestContext,
    client:
      client ??
      (includeSystem
        ? {
            connect: {
              minProtocol: 1,
              maxProtocol: 1,
              client: { id: "test", version: "test", platform: "test", mode: "test" },
              caps: [GATEWAY_CLIENT_CAPS.AGENT_KIND],
            },
          }
        : null),
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]?.[1] as AgentsListResult;
}

async function listAgentIdsViaRpc(
  includeSystem = false,
  catalogContext: Partial<GatewayRequestContext> = {},
): Promise<string[]> {
  const result = await listAgentsViaRpc(includeSystem, catalogContext);
  return result.agents.map((agent) => agent.id);
}

async function setAgentsConfig(agentsConfig: Record<string, unknown> | undefined) {
  testState.agentsConfig = agentsConfig;
  const { clearConfigCache, clearRuntimeConfigSnapshot, getRuntimeConfig } =
    await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  return getRuntimeConfig();
}

test("agents.list includes system rows only when negotiated", async () => {
  fs.mkdirSync(path.join(requireStateDir(), "agents", "openclaw"), { recursive: true });
  await setAgentsConfig(undefined);
  expect(await listAgentIdsViaRpc()).toEqual(["main"]);
  const result = await listAgentsViaRpc(true);
  expect(result.agents.map((agent) => agent.id)).toEqual(["main", "openclaw"]);
});

function avatarRosterConfig(agents: string[]): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: {
        ops: { identity: { name: "Operations" } },
        research: { identity: { name: "Research", avatar: "avatar.png" } },
      },
    },
    gateway: {
      roles: {
        definitions: {
          reader: { agents, scopes: ["operator.read"], sessions: { others: "none" } },
        },
      },
    },
  };
}

function avatarRosterClient(): GatewayClient {
  const client = soloClient();
  const profileId = "reader-profile";
  client.connect.scopes = ["operator.read"];
  client.preparedSessionProfile = { profileId, aliases: new Set([profileId]), role: "reader" };
  client.authenticatedUserProfile = gatewayProfile(profileId, "Reader");
  return client;
}

test.each(["hidden", "revoked"] as const)(
  "agents.list respects avatar-time visibility (%s)",
  async (visibility) => {
    let config = avatarRosterConfig(visibility === "hidden" ? ["ops"] : ["ops", "research"]);
    if (visibility === "revoked") {
      config.agents!.entries!.ops!.identity!.avatar = "ops.png";
    }
    const entered = createDeferred();
    const release = createDeferred();
    vi.spyOn(avatarRuntime, "prepareLocalAgentAvatar").mockImplementation(async (input) => {
      if (visibility === "hidden" || input.source === "ops.png") {
        entered.resolve();
        await release.promise;
      }
      return { ok: false, reason: "missing" };
    });
    const response = listAgentsViaRpc(
      false,
      { getRuntimeConfig: () => config },
      avatarRosterClient(),
    );
    try {
      if (visibility === "hidden") {
        expect(
          await Promise.race([
            response.then(() => "response"),
            entered.promise.then(() => "hidden-avatar"),
          ]),
        ).toBe("response");
      } else {
        await entered.promise;
        config = avatarRosterConfig(["research"]);
      }
    } finally {
      release.resolve();
      await response;
    }
    const result = await response;
    expect(result.agents.map(({ id }) => id)).toEqual(
      visibility === "hidden" ? ["ops"] : ["research"],
    );
    if (visibility === "revoked") {
      expect(result).toMatchObject({
        defaultId: "ops",
        ownership: "explicit",
        selectionRequired: true,
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "research", identity: { name: "Research", avatarUrl: expect.any(String) } }],
      });
    }
  },
);

test("agents.list starts scalar reads together and tolerates unavailable model facts", async () => {
  await setAgentsConfig({ ownership: "explicit", entries: { ops: {}, research: {} } });
  const firstStarted = createDeferred();
  const released = createDeferred();
  const started: Array<string | undefined> = [];
  const result = listAgentIdsViaRpc(false, {
    readPreparedGatewayModelCatalog: async (params = {}) => {
      const { agentId } = params;
      started.push(agentId);
      firstStarted.resolve();
      await released.promise;
      throw new Error("prepared model catalog requires an explicit owner");
    },
  });
  try {
    await firstStarted.promise;
    expect(started).toEqual(["ops", "research"]);
  } finally {
    released.resolve();
    await expect(result).resolves.toEqual(["ops", "research"]);
  }
});

test("agents.list includes durable provenance only for matching roster rows", async () => {
  await setAgentsConfig({ ownership: "explicit", entries: { ops: {}, research: {} } });
  await recordAgentProvenance(
    "research",
    { createdVia: "agent", creatorAgentId: "ops" },
    { nowMs: 42 },
  );

  const result = await listAgentsViaRpc();

  expect(result.agents.map((agent) => agent.id)).toEqual(["ops", "research"]);
  for (const field of ["createdVia", "creatorAgentId", "createdAt"]) {
    expect(result.agents[0]).not.toHaveProperty(field);
  }
  expect(result.agents[1]).toMatchObject({
    createdVia: "agent",
    creatorAgentId: "ops",
    createdAt: 42,
  });
});

beforeEach(async () => {
  testState.agentConfig = undefined;
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  await setAgentsConfig(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  testState.agentConfig = undefined;
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  await closeSessionSqliteDatabasesForTest();
});

async function configureFixedSessionStore(label = "default"): Promise<string> {
  const storePath = path.join(requireStateDir(), `shared-sessions-${label}`, "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, "{}\n", "utf8");
  testState.sessionStorePath = storePath;
  await setAgentsConfig({ entries: { main: {} } });
  return storePath;
}

test("sessions.resolve preserves presentation facts on unique and ambiguous wire results", async () => {
  const [firstKey, secondKey] = THREAD_KEYS;
  const rows = [
    { key: firstKey, agentId: "main", displayName: "Deploy monitor", boardFace: "dashboard" },
    { key: secondKey, agentId: "main", displayName: "Release monitor", boardFace: "chat" },
  ] as const;
  const seed = async (index: 0 | 1) => {
    const { key, agentId, ...presentation } = rows[index];
    await seedEntry(
      key,
      {
        sessionId: index ? "second-session" : "first-session",
        updatedAt: 2 - index,
        ...presentation,
      },
      agentId,
    );
  };
  await seed(0);

  const unique = await directSessionReq("sessions.resolve", {
    shortId: "12345678",
    agentId: "main",
  });
  expect(unique).toMatchObject({ ok: true, payload: { ok: true, ...rows[0] } });
  for (const reference of [
    { key: firstKey },
    { key: "agent:main:deploy-monitor", slug: "deploy-monitor" },
  ]) {
    expect(await directSessionReq("sessions.resolve", { reference, agentId: "main" })).toEqual(
      unique,
    );
  }

  await seed(1);
  await expectRead(
    "sessions.resolve",
    { shortId: "12345678", agentId: "main" },
    { ok: false, candidates: rows },
  );
});

test("sessions.resolve short IDs retain archived child-owner selection", async () => {
  const [firstKey, secondKey] = THREAD_KEYS;
  const now = Date.now();
  for (const [sessionKey, spawnedBy, updatedAt] of [
    [firstKey, "agent:main:controller", now - 1],
    [secondKey, "agent:main:other-controller", now],
  ] as const) {
    await seedEntry(sessionKey, { updatedAt, archivedAt: now, spawnedBy });
  }

  for (const [spawnedBy, expectedKey] of [
    ["agent:main:controller", firstKey],
    ["agent:main:other-controller", secondKey],
  ] as const) {
    await expectRead(
      "sessions.resolve",
      {
        shortId: "12345678",
        slugHint: "stale-title",
        agentId: "main",
        spawnedBy,
      },
      { ok: true, key: expectedKey, agentId: "main" },
    );
  }
});

test("unknown-agent session reads return missing results without provisioning an agent", async () => {
  await expectRead("sessions.describe", { key: UNKNOWN_SESSION_KEY }, { session: null });
  await expectRead("sessions.get", { key: UNKNOWN_SESSION_KEY }, { messages: [] });

  expect(await previews([UNKNOWN_SESSION_KEY])).toEqual([
    { key: UNKNOWN_SESSION_KEY, status: "missing", items: [] },
  ]);

  await expectRead(
    "sessions.search",
    { query: "ghost", sessionKeys: [UNKNOWN_SESSION_KEY] },
    { results: [] },
  );

  expect(fs.existsSync(path.join(requireStateDir(), "agents", UNKNOWN_AGENT_ID))).toBe(false);
  expect(fs.existsSync(agentDatabasePath(UNKNOWN_AGENT_ID))).toBe(false);
  expect(registeredDatabases().map((entry) => entry.agentId)).not.toContain(UNKNOWN_AGENT_ID);
  expect(await listAgentIdsViaRpc()).toEqual(["main"]);
});

test("bare ownerless reads fail closed without blocking scoped preview siblings", async () => {
  await setAgentsConfig({ ownership: "explicit", entries: { ops: {}, research: {} } });
  const sessionKey = "agent:ops:preview-valid";
  await seedReadableSession(sessionScope(sessionKey, "ops"), "scoped preview remains readable");

  await expectInvalidRead("sessions.describe", { key: "global" }, "has no explicit owner");
  await expectInvalidRead(
    "sessions.preview",
    { keys: ["global", sessionKey] },
    "has no explicit owner",
  );
});

test.each([
  { name: "unknown first", keys: [UNKNOWN_SESSION_KEY, "agent:main:preview-valid"] },
  { name: "valid first", keys: ["agent:main:preview-valid", UNKNOWN_SESSION_KEY] },
])(
  "sessions.preview keeps fixed-store results agent-distinct with $name lookup order",
  async ({ keys }) => {
    const storePath = await configureFixedSessionStore("preview-order");
    const validSessionKey = "agent:main:preview-valid";
    await seedReadableSession(
      sessionScope(validSessionKey, "main", storePath),
      "fixed store preview",
    );

    const preview = await previews(keys);

    expect(preview).toEqual(
      keys.map((key) =>
        key === UNKNOWN_SESSION_KEY
          ? { key, status: "missing", items: [] }
          : { key, status: "ok", items: expect.any(Array) },
      ),
    );
    expect(preview?.find((entry) => entry.key === validSessionKey)?.items).not.toEqual([]);
  },
);

test("sessions.search accepts an ACP allowlist owner absent from the agent roster", async () => {
  const agentId = "codex";
  const sessionKey = `agent:${agentId}:acp:search-owner`;
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  const cfg = await setAgentsConfig({ entries: { main: {} } });
  cfg.acp = { allowedAgents: [agentId] };
  await seedReadableSession(
    sessionScope(sessionKey, agentId, storePath),
    "ACP owner search needle",
  );
  await expectRead(
    "sessions.search",
    { agentId, query: "ACP owner search needle", sessionKeys: [sessionKey] },
    { results: [expect.objectContaining({ sessionKey })] },
  );
  await expectInvalidRead("sessions.search", {
    agentId,
    query: "ACP owner search needle",
    sessionKeys: [`agent:claude:acp:search-owner`],
  });
  expect(await listAgentIdsViaRpc()).toEqual(["main"]);
});

test("searches rich displayed fields before selecting a page across visible agent stores", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config: OpenClawConfig = {
      agents: {
        entries: {
          main: {},
          work: { identity: { name: "Orchid Navigator" } },
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const client = identifiedClient("owner@example.com");
    const context = requestContext(config);
    const list = (request: Parameters<typeof listSessions>[0]["request"]) =>
      listSessions({ client, context, request });
    const put = async (agentId: string, name: string, entry: Partial<SessionEntry>) => {
      await upsertSessionEntryCore(
        { agentId, sessionKey: `agent:${agentId}:${name}` },
        {
          ...profileSessionEntry(name, 1, "owner@example.com"),
          ...entry,
        },
      );
    };
    await put("work", "target", {
      label: "Quasar label",
      category: "Nebula category",
      displayName: "Stored comet",
      agentHarnessId: "custom-harness",
      modelSelectionLocked: true,
      status: "done",
      goal: createSessionGoalFixture("goal-target", "Map distant galaxies", {
        tokensUsed: 12000,
        tokenBudget: 50000,
        lastStatusNote: "Telescope calibrated",
      }),
    });
    await put("work", "hidden", {
      label: "Quasar label",
      visibility: "draft",
      createdActor: { type: "human", source: "profile", id: "restricted-owner@example.com" },
    });
    await put("work", "archived-target", { label: "Vault Orchid", archivedAt: 1 });
    for (let index = 0; index < 55; index++) {
      await put("main", `filler-${index}`, {});
    }
    const first = await list({ limit: 50 });
    expect(first.sessions.map((row) => row.key)).not.toContain("agent:work:target");
    for (const search of [
      "Quasar label",
      "Nebula category",
      "Stored comet",
      "done",
      "Map distant galaxies",
      "Pursuing goal (12k/50k)",
      "Telescope calibrated",
      "Orchid Navigator",
      "custom-harness",
    ]) {
      const result = await list({ search, limit: 50 });
      expect
        .soft({ keys: result.sessions.map((row) => row.key), total: result.totalCount }, search)
        .toEqual({ keys: ["agent:work:target"], total: 1 });
      expect(JSON.stringify(result)).not.toContain("restricted-owner");
    }
    expect((await list({ search: "Orchid", agentId: "main" })).sessions).toEqual([]);
    expect(
      (await list({ search: "Orchid", archived: true })).sessions.map((row) => row.key),
    ).toEqual(["agent:work:archived-target"]);
    expect((await list({ search: "Orchid", archived: "all" })).totalCount).toBe(2);
    const targetScope = { agentId: "work", sessionKey: "agent:work:target" };
    const target = loadSessionEntry(targetScope)!;
    await replaceSessionEntry(targetScope, {
      ...target,
      totalTokens: 50000,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      goal: { ...target.goal!, tokenStartFresh: true },
    });
    const limited = await list({ search: "Goal unmet (50k/50k)" });
    expect(limited.sessions).toMatchObject([
      { key: targetScope.sessionKey, goal: { status: "budget_limited", tokensUsed: 50000 } },
    ]);
    const idle = await list({ search: "idle", limit: 50 });
    expect(idle).toMatchObject({ count: 50, totalCount: 56, nextOffset: 50 });
    const later = await list({ search: "idle", limit: 50, offset: 50 });
    expect(later).toMatchObject({ count: 6, totalCount: 56, nextOffset: null });
  });
});
