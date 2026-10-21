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
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { useUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
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
    authorizeScopedGatewayHttpRequestOrReply: async () => ({
      cfg: runtime.cfg,
      requestAuth: requestAuth(),
      operatorScopes: ["operator.admin"],
    }),
    checkGatewayHttpRequestAuth: async () => ({ ok: true, requestAuth: requestAuth() }),
    authorizeGatewayHttpRequestOrReply: async () => requestAuth(),
    authorizeControlUiSessionOwnerReadRequestOrReply: async () => ({
      ...requestAuth(),
      canReadSession: () => true,
    }),
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
const prepareProfiles = useUserProfileCatalogForTest();
const defaultConfig = runtime.cfg;
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
    for (const handler of [
      handleSessionHistoryHttpRequest,
      handleSessionKillHttpRequest,
      handleChannelAvatarHttpRequest,
    ]) {
      if (await handler(req, res, options)) {
        return;
      }
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
  location = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  portClaim = await acquireTestPortBlock({ offsets: [0] });
  await new Promise<void>((resolve) => {
    server.listen(portClaim.port, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${portClaim.port}`;
});
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  runtime.current = true;
  runtime.beforeMedia = runtime.beforeHook = undefined;
  runtime.execute.mockClear();
  runtime.kill.mockClear();
});
afterEach(() => {
  runtime.cfg = defaultConfig;
  vi.restoreAllMocks();
});
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
  const entry: SessionEntry = {
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
  };
  const message = { role: "assistant", content: "Private actor history", timestamp: 1 };
  const transcriptEvents = [
    { type: "session", id, version: 3, cwd: "/synthetic" },
    { type: "message", id: `${id}-reply`, parentId: null, message },
  ];
  const created = await withSessionActorStorage(
    { agentId: "main", sessionKey, storePath: location.path, env },
    { create: true, authority, lifetime },
    ({ actor }) =>
      actor.storage.mutate(
        { type: "session.entry.create", input: { entry, transcriptEvents } },
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

function pauseGate() {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  return {
    pause: async () => {
      entered.resolve();
      await resume.promise;
    },
    during: async <T>(pending: Promise<T>, change: () => void | Promise<void>) => {
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "request did not enter its wait");
        await change();
      } finally {
        resume.resolve();
      }
      return pending;
    },
  };
}

function observeHostSql() {
  const host = observeHostDataSql();
  return { ...host, [Symbol.dispose]: host.restore };
}

it.each([
  ["application/json", false],
  ["text/event-stream", false],
  ["application/json", true],
  ["text/event-stream", true],
] as const)("serves memory history as %s, revoked=%s", async (accept, revoked) => {
  const key = await seed();
  using host = revoked ? undefined : observeHostSql();
  const gate = pauseGate();
  if (revoked) {
    const read = historyState.readSessionHistorySnapshotAsync;
    vi.spyOn(historyState, "readSessionHistorySnapshotAsync").mockImplementation(
      async (...args) => {
        const result = await read(...args);
        await gate.pause();
        return result;
      },
    );
  }
  const pending = fetch(historyUrl(revoked ? key : key.toUpperCase()), { headers: { accept } });
  const response = await (revoked
    ? gate.during(pending, () => {
        runtime.current = false;
      })
    : pending);
  expect(response.status).toBe(revoked ? 404 : 200);
  let text: string;
  if (!revoked && accept === "text/event-stream") {
    const reader = response.body!.getReader();
    try {
      text = JSON.stringify(await readSseEvent(reader, { buffer: "" }));
    } finally {
      await reader.cancel();
    }
  } else {
    text = revoked ? await response.text() : JSON.stringify(await response.json());
  }
  expect(text.includes("Private actor history")).toBe(!revoked);
  if (host) {
    await lastHandled;
    expect(host.queries).toEqual([]);
  }
});

it("checks the captured avatar source after its media wait", async () => {
  const key = await seed();
  const gate = pauseGate();
  runtime.beforeMedia = gate.pause;
  const response = fetch(`${baseUrl}${buildControlUiChannelAvatarUrl("", key, "synthetic")}`);
  const denied = await gate.during(response, () =>
    replaceMemoryEntry(key, {
      sessionId: "replacement",
      updatedAt: 2,
      incognito: true,
      lifecycleRevision: "replacement",
    }),
  );
  expect(denied.status).toBe(403);
});

it("uses the unbound memory source for admin kill without host SQL", async () => {
  const key = await seed();
  using host = observeHostSql();
  const response = await fetch(`${baseUrl}/sessions/${encodeURIComponent(key)}/kill`, {
    method: "POST",
  });
  expect(await response.json()).toEqual({ ok: true, killed: true });
  expect(runtime.kill).toHaveBeenCalledOnce();
  expect(host.queries).toEqual([]);
});

it.each(["session_status", "sessions_send"] as const)(
  "revalidates %s after hooks without double execution",
  async (name) => {
    const nested = name === "sessions_send";
    const key = await seed();
    const target = nested ? await seed() : key;
    if (nested) {
      await prepareProfiles({ env });
      const admin = {
        agents: ["main"],
        scopes: ["operator.admin" as const],
        sessions: { others: "write" as const },
      };
      runtime.cfg = {
        ...defaultConfig,
        gateway: { roles: { default: "admin", definitions: { admin } } },
      };
    }
    const operator = nested ? ensureProfileForEmail("incognito-operator@example.test") : undefined;
    using _ = nested
      ? { [Symbol.dispose]: (await prepareUserProfileCatalog()).release }
      : undefined;
    const profile = operator && {
      profileId: operator.id,
      displayName: operator.displayName,
      hasAvatar: false,
      updatedAt: operator.updatedAt,
    };
    const invoke = () =>
      invokeGatewayTool({
        cfg: runtime.cfg,
        input: {
          name,
          sessionKey: key,
          ...(nested ? { args: { sessionKey: target, message: "Synthetic nested request" } } : {}),
        },
        toolCallIdPrefix: nested ? "rpc" : "http",
        authenticatedUserProfile: profile,
        senderIsOwner: true,
      });
    if (profile) {
      runtime.execute.mockImplementationOnce(async () => {
        const inherited = readOperatorToolGatewayAuthority();
        expect(inherited?.authenticatedUserProfile?.profileId).toBe(profile.profileId);
        inherited?.assertCurrent?.();
        return { content: [{ type: "text", text: "Nested receipt" }] };
      });
    }
    using host = nested ? undefined : observeHostSql();
    expect(await invoke()).toMatchObject(nested ? { ok: true, status: 200 } : { ok: true });
    const gate = pauseGate();
    runtime.beforeHook = gate.pause;
    const denied = await gate.during(invoke(), async () => {
      if (nested) {
        await replaceMemoryEntry(target, {
          sessionId: "nested-replacement",
          updatedAt: 2,
          incognito: true,
        });
      } else {
        const entry = memorySessionActorOwners.read(location)?.readSession(key, authority)?.entry;
        assert(entry);
        await replaceMemoryEntry(key, { ...entry, permissionMode: "read-only" });
      }
    });
    expect(denied).toMatchObject(nested ? { ok: false } : { ok: false, status: 403 });
    expect(runtime.execute).toHaveBeenCalledOnce();
    if (host) {
      expect(host.queries).toEqual([]);
    }
  },
);
