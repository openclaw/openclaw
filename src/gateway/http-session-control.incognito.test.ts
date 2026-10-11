import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { handleChannelAvatarHttpRequest } from "./channel-avatar-http.js";
import { buildControlUiChannelAvatarUrl } from "./control-ui-contract.js";
import { readOperatorToolGatewayAuthority } from "./operator-tool-gateway-authority.js";
import { readSseEvent } from "./session-history-fixtures.test-support.js";
import * as historyState from "./session-history-state.js";
import { handleSessionKillHttpRequest } from "./session-kill-http.js";
import { handleSessionHistoryHttpRequest } from "./sessions-history-http.js";
import { invokeGatewayTool } from "./tools-invoke-shared.js";

const runtime = vi.hoisted(() => ({
  cfg: { agents: { entries: { main: {} } } } as OpenClawConfig,
  current: true,
  beforeAuth: undefined as (() => Promise<void>) | undefined,
  beforeMedia: undefined as (() => Promise<void>) | undefined,
  beforeHook: undefined as (() => Promise<void>) | undefined,
  execute: vi.fn(async () => ({ content: [{ type: "text", text: "Tool receipt" }] })),
  kill: vi.fn(async (_input: unknown, authority: { assertCurrent(): void }) => {
    authority.assertCurrent();
    return { found: true, killed: true };
  }),
}));
vi.mock("../config/io.js", async (original) => ({
  ...(await original<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => runtime.cfg,
}));
vi.mock("./http-utils.js", async (original) => {
  const actual = await original<typeof import("./http-utils.js")>();
  const requestAuth = () => ({
    authMethod: "token" as const,
    operatorScopes: ["operator.admin"],
    hasCurrentClientAuthority: () => runtime.current,
    assertCurrent() {
      if (!runtime.current) {
        throw new Error("Request revoked");
      }
    },
  });
  return {
    ...actual,
    authorizeScopedGatewayHttpRequestOrReply: async () => {
      return { cfg: runtime.cfg, requestAuth: requestAuth(), operatorScopes: ["operator.admin"] };
    },
    checkGatewayHttpRequestAuth: async () => {
      await runtime.beforeAuth?.();
      return { ok: true, requestAuth: requestAuth() };
    },
    authorizeGatewayHttpRequestOrReply: async () => requestAuth(),
    authorizeControlUiSessionOwnerReadRequestOrReply: async () => requestAuth(),
    resolveTrustedHttpOperatorScopes: () => ["operator.admin"],
    resolveSharedSecretHttpOperatorScopes: () => ["operator.admin"],
  };
});
vi.mock("../media/media-reference.js", async (original) => ({
  ...(await original<typeof import("../media/media-reference.js")>()),
  resolveInboundMediaReference: async () => ({ id: "synthetic-avatar.png" }),
}));
vi.mock("../media/store.js", async (original) => ({
  ...(await original<typeof import("../media/store.js")>()),
  readMediaBuffer: async () => {
    await runtime.beforeMedia?.();
    return {
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
        "base64",
      ),
    };
  },
}));
vi.mock("../agents/subagents/registry/subagent-control.js", async (original) => ({
  ...(await original<typeof import("../agents/subagents/registry/subagent-control.js")>()),
  killSubagentRunAdmin: runtime.kill,
}));
vi.mock("./tool-resolution.js", async (original) => ({
  ...(await original<typeof import("./tool-resolution.js")>()),
  resolveGatewayScopedTools: async () => ({
    agentId: "main",
    workspaceDir: "/synthetic",
    tools: ["session_status", "sessions_send"].map((name) => ({
      name,
      parameters: { type: "object", properties: {} },
      execute: runtime.execute,
    })),
  }),
}));
vi.mock("../agents/agent-tools.before-tool-call.js", async (original) => ({
  ...(await original<typeof import("../agents/agent-tools.before-tool-call.js")>()),
  runBeforeToolCallHook: async ({ params }: { params: Record<string, unknown> }) => {
    await runtime.beforeHook?.();
    return { blocked: false, params };
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
let location: { agentId: string; path: string };
let env: NodeJS.ProcessEnv;
let baseUrl: string;
let portClaim: TestPortClaim;
let sequence = 0;
let lastHandled = Promise.resolve();
const server = createServer((req, res) => {
  const handle = async () => {
    const options = {
      cfg: runtime.cfg,
      auth: { mode: "token" as const, token: "synthetic", allowTailscale: false },
    };
    if (await handleSessionHistoryHttpRequest(req, res, options)) {
      return;
    }
    if (await handleSessionKillHttpRequest(req, res, options)) {
      return;
    }
    if (await handleChannelAvatarHttpRequest(req, res, options)) {
      return;
    }
    res.writeHead(404).end();
  };
  lastHandled = handle().catch(() => {
    if (!res.headersSent) {
      res.writeHead(403);
    }
    res.end();
  });
});
beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("http-incognito-authority-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  location = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  portClaim = await acquireTestPortBlock({ offsets: [0] });
  await new Promise<void>((resolve) => {
    server.listen(portClaim.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  runtime.current = true;
  runtime.beforeAuth = runtime.beforeMedia = runtime.beforeHook = undefined;
  runtime.execute.mockClear();
  runtime.kill.mockClear();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await lastHandled;
  await portClaim?.release();
  memorySessionActorOwners.closeDatabase(location);
  await closeOpenClawAgentDatabasesAsync();
  vi.unstubAllEnvs();
});
async function seed() {
  const id = `http-${++sequence}`;
  const sessionKey = `agent:main:dashboard:incognito-${id}`;
  const created = await withSessionActorStorage(
    { agentId: "main", sessionKey, storePath: location.path, env },
    { create: true, authority, lifetime },
    ({ actor }) =>
      actor.storage.mutate(
        {
          type: "session.entry.create",
          input: {
            entry: {
              sessionId: id,
              updatedAt: 1,
              incognito: true,
              lifecycleRevision: "initial",
              delivery: {
                kind: "external",
                route: { channel: "discord", target: { to: "synthetic" } },
                context: { channel: "discord", to: "synthetic" },
                origin: { provider: "discord", to: "synthetic", avatar: `/synthetic/${id}.png` },
              },
            },
            transcriptEvents: [
              { type: "session", id, version: 3, cwd: "/synthetic" },
              {
                type: "message",
                id: `${id}-reply`,
                parentId: null,
                message: { role: "assistant", content: "Private actor history", timestamp: 1 },
              },
            ],
          },
        },
        authority,
      ),
  );
  expect(created?.kind).toBe("committed");
  return sessionKey;
}

async function replaceMemoryEntry(sessionKey: string, entry: SessionEntry) {
  const scope = { agentId: "main", sessionKey, storePath: location.path, env };
  const replaced = await withSessionActorStorage(scope, { authority, lifetime }, () =>
    replaceSessionEntry(scope, entry),
  );
  expect(replaced).toBeTruthy();
}
const historyUrl = (key: string) => `${baseUrl}/sessions/${encodeURIComponent(key)}/history`;

it.each(["application/json", "text/event-stream"])(
  "serves unbound memory %s history without host SQL and joins the stream consumer",
  async (accept) => {
    const key = await seed();
    const host = observeHostDataSql();
    try {
      const response = await fetch(historyUrl(key.toUpperCase()), { headers: { accept } });
      expect(response.status).toBe(200);
      if (accept === "application/json") {
        expect(JSON.stringify(await response.json())).toContain("Private actor history");
      } else {
        const reader = response.body!.getReader();
        expect(JSON.stringify(await readSseEvent(reader, { buffer: "" }))).toContain(
          "Private actor history",
        );
        await reader.cancel();
      }
      await lastHandled;
      expect(host.queries).toEqual([]);
    } finally {
      host.restore();
    }
  },
);

it.each(["application/json", "text/event-stream"])(
  "withholds %s history after auth revocation during its read",
  async (accept) => {
    const key = await seed();
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const read = historyState.readSessionHistorySnapshotAsync;
    vi.spyOn(historyState, "readSessionHistorySnapshotAsync").mockImplementation(
      async (...args) => {
        const result = await read(...args);
        entered.resolve();
        await resume.promise;
        return result;
      },
    );
    const response = fetch(historyUrl(key), { headers: { accept } });
    await awaitGateBeforeSettlement(entered.promise, response, "history did not enter its read");
    runtime.current = false;
    resume.resolve();
    const denied = await response;
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("Private actor history");
  },
);

it("checks the captured avatar source after its media wait", async () => {
  const key = await seed();
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  runtime.beforeMedia = async () => {
    entered.resolve();
    await resume.promise;
  };
  const response = fetch(`${baseUrl}${buildControlUiChannelAvatarUrl("", key, "synthetic")}`);
  await awaitGateBeforeSettlement(entered.promise, response, "avatar did not enter media read");
  try {
    await replaceMemoryEntry(key, {
      sessionId: "replacement",
      updatedAt: 2,
      incognito: true,
      lifecycleRevision: "replacement",
    });
  } finally {
    resume.resolve();
  }
  expect((await response).status).toBe(403);
});

it("uses the unbound memory source for admin kill without host SQL", async () => {
  const key = await seed();
  const host = observeHostDataSql();
  try {
    const response = await fetch(`${baseUrl}/sessions/${encodeURIComponent(key)}/kill`, {
      method: "POST",
    });
    expect(await response.json()).toEqual({ ok: true, killed: true });
    expect(runtime.kill).toHaveBeenCalledOnce();
    expect(host.queries).toEqual([]);
  } finally {
    host.restore();
  }
});

it("revalidates tool policy after hooks while preserving unbound memory tool execution", async () => {
  const key = await seed();
  const invoke = () =>
    invokeGatewayTool({
      cfg: runtime.cfg,
      input: { name: "session_status", sessionKey: key },
      toolCallIdPrefix: "http",
      senderIsOwner: true,
    });
  const host = observeHostDataSql();
  try {
    expect((await invoke()).ok).toBe(true);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    runtime.beforeHook = async () => {
      entered.resolve();
      await resume.promise;
    };
    const pending = invoke();
    await awaitGateBeforeSettlement(entered.promise, pending, "tool hook did not run");
    try {
      const entry = memorySessionActorOwners.read(location)?.readSession(key, authority)?.entry;
      assert(entry);
      await replaceMemoryEntry(key, { ...entry, permissionMode: "read-only" });
    } finally {
      resume.resolve();
    }
    expect(await pending).toMatchObject({ ok: false, status: 403 });
    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(host.queries).toEqual([]);
  } finally {
    host.restore();
  }
});

it("carries configured-role authority into unbound memory sessions_send and refuses a replaced target", async () => {
  const sourceKey = await seed();
  const nestedKey = await seed();
  const initialConfig = runtime.cfg;
  runtime.cfg = {
    ...initialConfig,
    gateway: {
      roles: {
        default: "admin",
        definitions: {
          admin: { agents: ["main"], scopes: ["operator.admin"], sessions: { others: "write" } },
        },
      },
    },
  };
  const operator = ensureProfileForEmail("incognito-operator@example.test");
  const profile = {
    profileId: operator.id,
    displayName: operator.displayName,
    hasAvatar: false,
    updatedAt: operator.updatedAt,
  };
  const invoke = () =>
    invokeGatewayTool({
      cfg: runtime.cfg,
      input: {
        name: "sessions_send",
        sessionKey: sourceKey,
        args: { sessionKey: nestedKey, message: "Synthetic nested request" },
      },
      toolCallIdPrefix: "rpc",
      authenticatedUserProfile: profile,
      senderIsOwner: true,
    });
  runtime.execute.mockImplementationOnce(async () => {
    const inherited = readOperatorToolGatewayAuthority();
    expect(inherited?.authenticatedUserProfile?.profileId).toBe(profile.profileId);
    inherited?.assertCurrent?.();
    return { content: [{ type: "text", text: "Nested receipt" }] };
  });
  try {
    expect(await invoke()).toMatchObject({ ok: true, status: 200 });
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    runtime.beforeHook = async () => {
      entered.resolve();
      await resume.promise;
    };
    const pending = invoke();
    await awaitGateBeforeSettlement(entered.promise, pending, "nested hook did not run");
    try {
      await replaceMemoryEntry(nestedKey, {
        sessionId: "nested-replacement",
        updatedAt: 2,
        incognito: true,
      });
    } finally {
      resume.resolve();
    }
    expect((await pending).ok).toBe(false);
    expect(runtime.execute).toHaveBeenCalledOnce();
  } finally {
    runtime.cfg = initialConfig;
  }
});
