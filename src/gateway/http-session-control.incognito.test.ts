import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { withIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
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
  cfg: { agents: { entries: { main: {}, native: {} } } } as OpenClawConfig,
  current: true,
  beforeAdmission: undefined as (() => Promise<void>) | undefined,
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
      await runtime.beforeAdmission?.();
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
const authority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
let baseUrl: string;
let portClaim: TestPortClaim;
let bound = true;
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
  lastHandled = (bound ? withIncognitoSessionBinding({ actor }, handle) : handle()).catch(() => {
    if (!res.headersSent) {
      res.writeHead(403);
    }
    res.end();
  });
});
beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("http-incognito-authority-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
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
  bound = true;
  runtime.current = true;
  runtime.beforeAdmission =
    runtime.beforeAuth =
    runtime.beforeMedia =
    runtime.beforeHook =
      undefined;
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
  await actor?.close();
  await closeOpenClawAgentDatabasesAsync();
  vi.unstubAllEnvs();
});
async function seed() {
  const id = `http-${++sequence}`;
  const sessionKey = `agent:main:dashboard:incognito-${id}`;
  await actor.sessions.create(authority, {
    sessionKey,
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
  });
  await actor.sessions.transcript(authority, {
    type: "session.message.append",
    input: {
      sessionKey,
      sessionId: id,
      fence: { expectedLifecycleRevision: "initial" },
      message: { role: "assistant", content: "Private actor history", timestamp: 1 },
    },
  });
  return sessionKey;
}
const historyUrl = (key: string) => `${baseUrl}/sessions/${encodeURIComponent(key)}/history`;

it.each(["application/json", "text/event-stream"])(
  "serves bound %s history without host SQL and joins the stream consumer",
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

it("keeps native incognito history host-owned when no binding was supplied", async () => {
  bound = false;
  const key = "agent:native:dashboard:incognito-unbound";
  replaceSessionEntrySync(
    { agentId: "native", sessionKey: key },
    { sessionId: "native-http", updatedAt: 1, incognito: true },
  );
  const before = captureOpenClawAgentDatabaseExecution.listIncognito(env);
  const response = await fetch(historyUrl(key));
  expect(response.status).toBe(200);
  expect((await response.json()).sessionKey).toBe(key);
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual(before);
});

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
    await withIncognitoSessionBinding({ actor }, () =>
      replaceSessionEntry(
        { agentId: "main", sessionKey: key, env },
        {
          sessionId: "replacement",
          updatedAt: 2,
          incognito: true,
          lifecycleRevision: "replacement",
        },
      ),
    );
  } finally {
    resume.resolve();
  }
  expect((await response).status).toBe(403);
});

it("uses the bound source for admin kill without host SQL", async () => {
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

it("revalidates tool policy after hooks while preserving bound tool execution", async () => {
  const key = await seed();
  const invoke = () =>
    withIncognitoSessionBinding({ actor }, () =>
      invokeGatewayTool({
        cfg: runtime.cfg,
        input: { name: "session_status", sessionKey: key },
        toolCallIdPrefix: "http",
        senderIsOwner: true,
      }),
    );
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
      const entry = (await actor.sessions.read(authority, { sessionKey: key })).entry!;
      await withIncognitoSessionBinding({ actor }, () =>
        replaceSessionEntry(
          { agentId: "main", sessionKey: key, env },
          { ...entry, permissionMode: "read-only" },
        ),
      );
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

it("carries configured-role authority into bound nested sessions_send and refuses a replaced target", async () => {
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
    withIncognitoSessionBinding({ actor }, () =>
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
      }),
    );
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
      await withIncognitoSessionBinding({ actor }, () =>
        replaceSessionEntry(
          { agentId: "main", sessionKey: nestedKey, env },
          { sessionId: "nested-replacement", updatedAt: 2, incognito: true },
        ),
      );
    } finally {
      resume.resolve();
    }
    expect((await pending).ok).toBe(false);
    expect(runtime.execute).toHaveBeenCalledOnce();
  } finally {
    runtime.cfg = initialConfig;
  }
});

it("retains the session generation selected before HTTP authentication yields", async () => {
  const key = await seed();
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  runtime.beforeAdmission = async () => {
    entered.resolve();
    await resume.promise;
  };
  const response = fetch(historyUrl(key));
  await awaitGateBeforeSettlement(entered.promise, response, "HTTP authentication did not yield");
  try {
    await withIncognitoSessionBinding({ actor }, () =>
      replaceSessionEntry(
        { agentId: "main", sessionKey: key, env },
        { sessionId: "auth-replacement", updatedAt: 2, incognito: true },
      ),
    );
  } finally {
    resume.resolve();
  }
  const denied = await response;
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("Private actor history");
});
