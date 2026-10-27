import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { runBeforeToolCallHook as runBeforeToolCallHookType } from "../agents/agent-tools.before-tool-call.js";
import type { OpenClawToolsOptions } from "../agents/openclaw-tools.types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
} from "./terminal/session-manager.test-helpers.js";
import {
  createToolsInvokeHttpTestServer,
  createToolsInvokeSessionSpawnFixture,
  expectOkInvokeResponse,
  registerToolsInvokeSpawnWorkspaceTests,
  withToolsInvokeTestState,
} from "./tools-invoke-http.test-support.js";
import {
  registerToolsInvokeUploadTests,
  registerToolsInvokeErrorTests,
} from "./tools-invoke.policy.test-support.js";

const hookMocks = vi.hoisted(() => ({
  gatewayPolicyExecute: vi.fn<AnyAgentTool["execute"]>(async () => ({
    content: [],
    details: { completed: true },
  })),
  uploadToolExecute: vi.fn<AnyAgentTool["execute"]>(async () => ({
    ok: true,
    content: [],
    details: {},
  })),
  resolveToolLoopDetectionConfig: vi.fn(() => ({ warnAt: 3 })),
  runBeforeToolCallHook: vi.fn<typeof runBeforeToolCallHookType>(async (args) => ({
    blocked: false,
    params: args.params,
  })),
}));

const sessionEntries = vi.hoisted(() => new Map<string, Record<string, unknown>>());

let cfg: Record<string, unknown> = {};
let lastCreateOpenClawToolsContext: OpenClawToolsOptions | undefined;

// Perf: keep this suite pure unit. Mock heavyweight config/session modules.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    loadExactSessionEntryReadOnly: (params: { sessionKey: string }) => {
      const entry = sessionEntries.get(params.sessionKey);
      return entry ? { sessionKey: params.sessionKey, entry } : undefined;
    },
    loadExactSessionEntryCandidates: (params: { sessionKeys: readonly string[] }) =>
      params.sessionKeys.flatMap((sessionKey) => {
        const entry = sessionEntries.get(sessionKey);
        return entry ? [{ sessionKey, entry }] : [];
      }),
    resolveSessionEntryAccessTarget: (params: { sessionKey: string }) => ({
      entry: sessionEntries.get(params.sessionKey),
    }),
  };
});

vi.mock("./session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string }) => ({
    entry: sessionEntries.get(params.key),
  }),
}));

vi.mock("../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-entry-read-runtime.js")>()),
  withSessionEntriesFromStoreInWorker: async (
    input: { sessionKeys?: readonly string[]; selection?: { sessionId: string } },
    consume: (read: {
      result: { entries: Array<{ sessionKey: string; entry: Record<string, unknown> }> };
      assertCurrent: () => void;
    }) => unknown,
  ) =>
    consume({
      result: {
        entries: [...sessionEntries].flatMap(([sessionKey, entry]) =>
          input.sessionKeys?.includes(sessionKey) ||
          (input.selection && entry.sessionId === input.selection.sessionId)
            ? [{ sessionKey, entry }]
            : [],
        ),
      },
      assertCurrent: () => {},
    }),
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../logger.js", () => ({
  logWarn: () => {},
}));

vi.mock("../plugins/config-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/config-state.js")>();
  return {
    ...actual,
    isTestDefaultMemorySlotDisabled: () => false,
  };
});

// mock-isolation: Exercise invocation policy without loading unrelated tool implementations.
vi.mock("../agents/openclaw-tools.js", async () => {
  const { createTerminalTool } = await import("../agents/tools/terminal-tool.js");
  const { createUploadToolFixtures, createClientUploadToolFixture } =
    await import("./tools-invoke.policy.test-support.js");
  const { resolveOpenClawPluginToolInputs } =
    await import("../agents/openclaw-tools.plugin-context.js");
  const toolInputError = (message: string) => {
    const err = new Error(message);
    err.name = "ToolInputError";
    return err;
  };
  const toolAuthorizationError = (message: string) => {
    const err = new Error(message) as Error & { status?: number };
    err.name = "ToolAuthorizationError";
    err.status = 403;
    return err;
  };

  function fixtureTool<T>(name: string, execute: () => Promise<T>) {
    return {
      name,
      parameters: { type: "object", properties: {} },
      execute,
    };
  }
  const successfulTool = (name: string, result: string) =>
    fixtureTool(name, async () => ({ ok: true, result }));

  const tools = [
    ...createUploadToolFixtures(hookMocks.uploadToolExecute),
    fixtureTool("session_status", async () => ({ ok: true })),
    {
      name: "agents_list",
      parameters: { type: "object", properties: { action: { type: "string" } } },
      execute: async () => ({ ok: true, result: [] }),
    },
    fixtureTool("sessions_send", async () => ({ ok: true })),
    fixtureTool("gateway", async () => {
      throw toolInputError("invalid args");
    }),
    {
      name: "policy_action",
      label: "Policy action",
      description: "Gateway policy fixture",
      parameters: {
        type: "object",
        properties: { action: { type: "string", enum: ["read", "write"] } },
      },
      execute: hookMocks.gatewayPolicyExecute,
    },
    successfulTool("automations", "automations"),
    successfulTool("exec", "exec"),
    successfulTool("apply_patch", "apply_patch"),
    successfulTool("nodes", "nodes"),
    successfulTool("write_scoped_test", "write-scoped"),
    {
      name: "tools_invoke_test",
      parameters: {
        type: "object",
        properties: { mode: { type: "string" } },
        required: ["mode"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, args: unknown) => {
        const mode = (args as { mode?: unknown })?.mode;
        if (mode === "input") {
          throw toolInputError("mode invalid");
        }
        if (mode === "auth") {
          throw toolAuthorizationError("mode forbidden");
        }
        if (mode === "crash") {
          throw new Error("boom");
        }
        return { ok: true };
      },
    },
  ];

  return {
    createOpenClawToolsAsync: async (ctx: OpenClawToolsOptions) => {
      lastCreateOpenClawToolsContext = ctx;
      return [
        await createToolsInvokeSessionSpawnFixture(ctx),
        ...tools,
        ...(ctx.disablePluginTools
          ? []
          : [
              createClientUploadToolFixture(
                resolveOpenClawPluginToolInputs({ options: ctx }).context,
              ),
            ]),
        createTerminalTool({
          agentId: ctx.requesterAgentIdOverride ?? "main",
          agentSessionKey: ctx.agentSessionKey,
          sessionId: ctx.sessionId,
          config: ctx.config,
          execSession: ctx.execSession ?? {},
        }),
      ];
    },
  };
});

vi.mock("../agents/agent-tools.js", () => ({
  resolveToolLoopDetectionConfig: hookMocks.resolveToolLoopDetectionConfig,
}));

vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: hookMocks.runBeforeToolCallHook,
}));

const { runBeforeToolCallHook: actualRunBeforeToolCallHook } =
  await vi.importActual<typeof import("../agents/agent-tools.before-tool-call.js")>(
    "../agents/agent-tools.before-tool-call.js",
  );

const { authorizeHttpGatewayConnect } = await import("./auth.js");
const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");
const { toolsInvokeHandlers } = await import("./server-methods/tools-invoke.js");

let sharedPort = 0;
const server = createToolsInvokeHttpTestServer({
  handleToolsInvoke: handleToolsInvokeHttpRequest,
});

beforeAll(async () => {
  sharedPort = await server.listen();
});

afterAll(() => server.close());

beforeEach(() => {
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PASSWORD;
  cfg = {};
  server.resetContext();
  lastCreateOpenClawToolsContext = undefined;
  hookMocks.uploadToolExecute.mockClear();
  hookMocks.gatewayPolicyExecute.mockClear();
  sessionEntries.clear();
  hookMocks.resolveToolLoopDetectionConfig.mockReset();
  hookMocks.runBeforeToolCallHook.mockReset();
  vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({ ok: true });
});

const gatewayAuthHeaders = () => ({ "x-openclaw-scopes": "operator.write" });
const gatewayAdminHeaders = () => ({ "x-openclaw-scopes": "operator.admin" });
const authenticateOnce = (method: "trusted-proxy" | "token") =>
  vi.mocked(authorizeHttpGatewayConnect).mockResolvedValueOnce({ ok: true, method });

const postToolsInvoke = async (body: Record<string, unknown>, headers: Record<string, string>) =>
  await fetch(`http://127.0.0.1:${sharedPort}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const invokeTool = async (params: {
  tool: string;
  args?: Record<string, unknown>;
  action?: string;
  headers?: Record<string, string>;
  sessionKey?: string;
}) => {
  const body = {
    tool: params.tool,
    args: params.args ?? {},
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.action ? { action: params.action } : {}),
  };
  return await postToolsInvoke(body, params.headers ?? gatewayAuthHeaders());
};
const invokeToolAuthed = invokeTool;

const invokeAgentsListAuthed = async (params: { sessionKey?: string } = {}) =>
  invokeTool({ tool: "agents_list", action: "json", ...params });

const firstHookCallArg = () =>
  expectDefined(hookMocks.runBeforeToolCallHook.mock.calls[0], "before-tool-call hook")[0];

const invokeToolsRpc = async (
  params: Record<string, unknown>,
  scopes = ["operator.write"],
  clientInfo?: { id: string; mode: string },
  caps?: string[],
  authenticatedUserProfile?: {
    profileId: string;
    displayName: string | null;
    hasAvatar: boolean;
    updatedAt: number;
  },
  internal?: { operatorRoleActor?: { kind: "system" } | { kind: "operator"; profileId: string } },
) => {
  const respond = vi.fn();
  await expectDefined(
    toolsInvokeHandlers["tools.invoke"],
    'toolsInvokeHandlers["tools.invoke"] test invariant',
  )({
    params,
    respond,
    context: { getRuntimeConfig: () => cfg } as never,
    client: {
      ...(authenticatedUserProfile ? { authenticatedUserProfile } : {}),
      ...(internal ? { internal } : {}),
      connect: {
        role: "operator",
        scopes,
        ...(clientInfo ? { client: clientInfo } : {}),
        ...(caps ? { caps } : {}),
      },
    } as never,
    req: { type: "req", id: "req-rpc-1", method: "tools.invoke" },
    isWebchatConnect: () => false,
  });
  return respond.mock.calls[0] as
    | [boolean, { ok?: boolean; toolName?: string; output?: unknown; error?: unknown }?, unknown?]
    | undefined;
};

const setMainAllowedTools = (params: { allow: string[]; gatewayAllow?: string[] }) => {
  cfg = {
    ...cfg,
    agents: { entries: { main: { tools: { allow: params.allow } } } },
    ...(params.gatewayAllow ? { gateway: { tools: { allow: params.gatewayAllow } } } : {}),
  };
};
const allowAgentsListForMain = () => setMainAllowedTools({ allow: ["agents_list"] });
const profileAuth = (profile: { id: string; displayName: string | null; updatedAt: number }) => ({
  profileId: profile.id,
  displayName: profile.displayName,
  hasAvatar: false,
  updatedAt: profile.updatedAt,
});
const guestRole = (agents: string[] | "*", others: "view" | "none" = "view") => ({
  default: "guest",
  definitions: { guest: { agents, scopes: ["operator.write"], sessions: { others } } },
});
const withProfiles = <T>(label: string, run: () => Promise<T>) =>
  withToolsInvokeTestState({ label: `tools-invoke-${label}`, prepareProfileCatalog: true }, run);
const setRoleTools = (tool: string, agents: string[] | "*", gatewayAllow = true) => {
  cfg = {
    agents: { entries: { main: { tools: { allow: [tool] } } } },
    gateway: { ...(gatewayAllow ? { tools: { allow: [tool] } } : {}), roles: guestRole(agents) },
  };
};
const sharedSession = async (sessionKey: string, sessionId: string, ownerId: string) => {
  const entry = {
    sessionId,
    updatedAt: 1,
    visibility: "shared" as const,
    createdActor: { type: "human" as const, source: "profile" as const, id: ownerId },
  };
  await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
  sessionEntries.set(sessionKey, entry);
};

describe("POST /tools/invoke", () => {
  registerToolsInvokeSpawnWorkspaceTests({
    sessionEntries,
    setConfig: (config) => {
      cfg = config;
    },
    invoke: invokeToolAuthed,
  });
  registerToolsInvokeUploadTests({
    getConfig: () => cfg,
    setConfig: (config) => {
      cfg = config;
    },
    setMethodRegistry: server.setMethodRegistry,
    hookMocks,
    postAdmin: (body) => postToolsInvoke(body, gatewayAdminHeaders()),
    invokeToolsRpc,
    setMainAllowedTools,
    invokeToolAuthed,
    expectOkInvokeResponse,
  });

  it("does not record Gateway tools.invoke calls in agent tool-loop history", async () => {
    setMainAllowedTools({ allow: ["session_status"], gatewayAllow: ["session_status"] });
    const enabledLoopDetection = { enabled: true, warnAt: 3 };
    hookMocks.runBeforeToolCallHook.mockImplementation(actualRunBeforeToolCallHook);

    for (let index = 0; index < 10; index += 1) {
      const response = await invokeTool({ tool: "session_status", sessionKey: "main" });
      expect(response.status).toBe(200);
    }
    for (let index = 0; index < 10; index += 1) {
      const call = await invokeToolsRpc({
        name: "session_status",
        args: {},
        sessionKey: "main",
        idempotencyKey: `issue-186022-${index}`,
      });
      expect(call?.[0]).toBe(true);
    }

    const sessionKey = "agent:main:main";
    expect(hookMocks.resolveToolLoopDetectionConfig).not.toHaveBeenCalled();
    expect(getDiagnosticSessionState({ sessionKey }).toolCallHistory ?? []).toHaveLength(0);

    await actualRunBeforeToolCallHook({
      toolName: "session_status",
      params: {},
      toolCallId: "agent-run-tool-call",
      ctx: {
        agentId: "main",
        config: cfg as never,
        sessionKey,
        runId: "agent-run-1",
        loopDetection: enabledLoopDetection,
      },
    });
    expect(getDiagnosticSessionState({ sessionKey }).toolCallHistory).toEqual([
      expect.objectContaining({ toolName: "session_status", runId: "agent-run-1" }),
    ]);
  });

  it("enforces action policy for administrator tool calls after hook rewrites", async () => {
    cfg = {
      tools: { gatewayPolicy: { allow: ["policy_action"], actions: { policy_action: ["read"] } } },
    };
    const invoke = (action: string) =>
      invokeTool({ headers: gatewayAdminHeaders(), tool: "policy_action", action });
    const allowed = await invoke("read");
    expect(allowed.status).toBe(200);
    expect(hookMocks.gatewayPolicyExecute).toHaveBeenCalledTimes(1);
    const denied = await invoke("write");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { message: expect.stringContaining("Gateway tool policy denies") },
    });
    hookMocks.runBeforeToolCallHook.mockImplementationOnce(async () => ({
      blocked: false,
      params: { action: "write" },
    }));
    const rewritten = await invoke("read");
    expect(rewritten.status).toBe(403);
    expect(hookMocks.gatewayPolicyExecute).toHaveBeenCalledTimes(1);
  });

  it("blocks an operator-triggered session spawn targeting an agent outside the role", async () => {
    await withProfiles("operator-role", async () => {
      const profile = ensureProfileForEmail("operator@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      setRoleTools("sessions_spawn", ["main", "guest-agent"]);

      const call = await invokeToolsRpc(
        {
          name: "sessions_spawn",
          args: { agentId: "restricted-agent" },
          sessionKey: "main",
        },
        ["operator.write"],
        undefined,
        undefined,
        profileAuth(profile),
      );

      expect(call?.[1]).toMatchObject({
        ok: false,
        toolName: "sessions_spawn",
        error: {
          code: "forbidden",
          message: expect.stringContaining('cannot create sessions for agent "restricted-agent"'),
        },
      });
      expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
    });
  });

  it("preserves system authority for sessions_spawn with owner profile", async () => {
    const toolName = "sessions_spawn";
    await withProfiles("system-authority", async () => {
      const owner = ensureGatewayOwnerProfile("Gateway Owner");
      const sessionKey = "agent:main:sysauth-primary";
      await sharedSession(sessionKey, "sysauth-primary-session", owner.id);
      setRoleTools(toolName, ["guest-agent"]);

      const call = await invokeToolsRpc(
        { name: toolName, args: { agentId: "restricted-agent" }, sessionKey },
        ["operator.write"],
        undefined,
        undefined,
        profileAuth(owner),
        { operatorRoleActor: { kind: "system" } },
      );

      expect(call?.[1]).toMatchObject({ ok: true, toolName });
    });
  });

  it("rejects a nested sessions_send target that the operator cannot mutate", async () => {
    await withProfiles("foreign-session", async () => {
      const owner = ensureProfileForEmail("owner@example.test");
      const guest = ensureProfileForEmail("guest@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const foreignKey = "agent:main:foreign";
      await sharedSession(foreignKey, "foreign-session", owner.id);
      setRoleTools("sessions_send", "*");

      const call = await invokeToolsRpc(
        {
          name: "sessions_send",
          args: { sessionKey: foreignKey, message: "hi" },
          sessionKey: "main",
        },
        ["operator.write"],
        undefined,
        undefined,
        profileAuth(guest),
      );

      expect(call?.[1]).toMatchObject({
        ok: false,
        toolName: "sessions_send",
        error: { code: "forbidden", message: expect.stringContaining("session is shared") },
      });
      expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
    });
  });

  it("rejects HTTP tool execution against another operator's primary session", async () => {
    await withProfiles("foreign-primary-session", async () => {
      const owner = ensureProfileForEmail("owner@example.test");
      ensureProfileForEmail("guest@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const sessionKey = "agent:main:foreign-primary";
      await sharedSession(sessionKey, "foreign-primary-session", owner.id);
      setRoleTools("agents_list", "*", false);
      vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
        ok: true,
        method: "trusted-proxy",
        user: "guest@example.test",
      });

      const response = await invokeToolAuthed({ tool: "agents_list", sessionKey });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: {
          type: "tool_call_blocked",
          message: expect.stringContaining("session is shared"),
        },
      });
      expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
      expect(lastCreateOpenClawToolsContext).toBeUndefined();
    });
  });

  it.each([false, true])(
    "rejects harness session before tool resolution (persisted=%s)",
    async (persisted) => {
      allowAgentsListForMain();
      const sessionKey = "agent:main:harness:codex:supervision:native-thread";
      if (persisted) {
        sessionEntries.set(sessionKey, {
          sessionId: "locked-session",
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        });
      }
      const res = await invokeAgentsListAuthed({ sessionKey });
      expect(res.status).toBe(400);
      if (!persisted) {
        expect(await res.json()).toMatchObject({
          ok: false,
          error: { type: "invalid_request", message: expect.stringContaining("reserved") },
        });
      }
      expect(lastCreateOpenClawToolsContext).toBeUndefined();
    },
  );

  it("supports tools.alsoAllow in profile and implicit modes", async () => {
    for (const profile of ["minimal", undefined]) {
      cfg = {
        ...cfg,
        agents: { entries: { main: {} } },
        tools: { ...(profile ? { profile } : {}), alsoAllow: ["agents_list"] },
      };
      await expectOkInvokeResponse(await invokeAgentsListAuthed({ sessionKey: "main" }));
    }
  });

  it("propagates owner-only HTTP denies into spawned session inheritance", async () => {
    setMainAllowedTools({
      allow: ["sessions_spawn", "cron", "gateway", "nodes"],
      gatewayAllow: ["sessions_spawn", "cron", "gateway", "nodes"],
    });
    const body = await expectOkInvokeResponse(
      await invokeToolAuthed({ tool: "sessions_spawn", sessionKey: "main" }),
    );
    expect(body.result?.inheritedToolDenylist).toEqual(
      expect.arrayContaining(["automations", "gateway", "nodes"]),
    );
  });

  it("keeps owner-only tools unavailable to non-owner HTTP callers despite gateway.tools.allow", async () => {
    setMainAllowedTools({
      allow: ["cron", "gateway", "nodes"],
      gatewayAllow: ["cron", "gateway", "nodes"],
    });

    for (const tool of ["cron", "gateway", "nodes"]) {
      const res = await invokeToolAuthed({ tool, sessionKey: "main" });
      expect(res.status, tool).toBe(404);
      expect(await res.json(), tool).toMatchObject({ ok: false, error: { type: "not_found" } });
    }
  });

  it("uses the configured main session key when sessionKey is missing or main", async () => {
    cfg = {
      ...cfg,
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: {
          main: { tools: { deny: ["agents_list"] } },
          ops: { tools: { allow: ["agents_list"] } },
        },
      },
      session: { mainKey: "primary" },
    };

    expect((await invokeAgentsListAuthed()).status).toBe(200);
    expect((await invokeAgentsListAuthed({ sessionKey: "main" })).status).toBe(200);
  });

  registerToolsInvokeErrorTests({
    setMainAllowedTools,
    invokeToolAuthed,
  });

  it("requires operator.write scope for HTTP tool invocation", async () => {
    allowAgentsListForMain();
    authenticateOnce("trusted-proxy");

    const res = await invokeTool({
      headers: { "x-openclaw-scopes": "" },
      tool: "agents_list",
      sessionKey: "main",
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { type: "forbidden", message: "missing scope: operator.write" },
    });
    expect(lastCreateOpenClawToolsContext).toBeUndefined();
  });

  it("treats shared-secret bearer auth as full operator access on /tools/invoke", async () => {
    allowAgentsListForMain();
    authenticateOnce("token");

    const res = await invokeTool({
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      tool: "agents_list",
      action: "json",
      sessionKey: "main",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result).toEqual({ ok: true, result: [] });

    setMainAllowedTools({ allow: ["write_scoped_test"] });
    authenticateOnce("token");

    const writeScopedRes = await invokeTool({
      headers: {
        authorization: "Bearer secret",
        "x-openclaw-scopes": "operator.approvals",
      },
      tool: "write_scoped_test",
      sessionKey: "main",
    });

    const writeScopedBody = await expectOkInvokeResponse(writeScopedRes);
    expect(writeScopedBody.result).toEqual({ ok: true, result: "write-scoped" });
    expect(lastCreateOpenClawToolsContext?.senderIsOwner).toBe(true);

    await withProfiles("shared-secret-role-owner", async () => {
      const owner = ensureProfileForEmail("role-owner@example.test");
      const sessionKey = "agent:main:shared-secret-owner-session";
      await sharedSession(sessionKey, "shared-secret-owner-session", owner.id);
      cfg = { ...cfg, gateway: { roles: guestRole(["guest-agent"], "none") } };
      authenticateOnce("token");

      const roleConfiguredOwnerResponse = await invokeTool({
        headers: { authorization: "Bearer secret" },
        tool: "write_scoped_test",
        sessionKey,
      });

      await expectOkInvokeResponse(roleConfiguredOwnerResponse);
    });
  });

  it("derives sender owner identity from HTTP auth instead of caller headers", async () => {
    setMainAllowedTools({ allow: ["session_status"] });

    for (const [headers, owner] of [
      [{ ...gatewayAuthHeaders(), "x-openclaw-sender-is-owner": "true" }, false],
      [gatewayAdminHeaders(), true],
    ] as const) {
      const res = await invokeTool({ headers, tool: "session_status", sessionKey: "main" });
      expect(res.status).toBe(200);
      expect(lastCreateOpenClawToolsContext?.senderIsOwner).toBe(owner);
    }
  });

  it("extends the HTTP deny list to high-risk execution and file tools", async () => {
    setMainAllowedTools({ allow: ["exec", "apply_patch", "nodes"] });

    for (const tool of ["exec", "apply_patch", "nodes"]) {
      expect((await invokeToolAuthed({ tool, sessionKey: "main" })).status, tool).toBe(404);
    }
    const nodesAdminRes = await invokeTool({
      headers: gatewayAdminHeaders(),
      tool: "nodes",
      sessionKey: "main",
    });

    expect(nodesAdminRes.status).toBe(404);
  });
});

describe("tools.invoke Gateway RPC", () => {
  it("invokes a tool through the SDK-facing RPC envelope", async () => {
    allowAgentsListForMain();

    const call = await invokeToolsRpc({
      name: "agents_list",
      args: {},
      sessionKey: "main",
      idempotencyKey: "rpc-tool-test",
    });

    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ ok: true, toolName: "agents_list", source: "core" });
    expect(call?.[1]?.output).toEqual({ ok: true, result: [] });
    expect(lastCreateOpenClawToolsContext?.allowGatewaySubagentBinding).toBe(true);
    const hookArg = firstHookCallArg();
    expect(hookArg).toMatchObject({
      approvalMode: "report",
      toolName: "agents_list",
      toolCallId: "rpc-delegated-rpc-tool-test",
      ctx: { agentId: "main", sessionKey: "agent:main:main" },
    });
    const hookCtx = expectDefined(hookArg.ctx, "before-tool-call hook context");
    expect(hookCtx.config).toBe(cfg);
    expect(lastCreateOpenClawToolsContext?.conversationReadOrigin).toBe("delegated");
  });

  it("limits terminal controls and execution denial to the current persisted session generation", async () => {
    setMainAllowedTools({ allow: ["terminal"], gatewayAllow: ["terminal"] });
    cfg = { ...cfg, tools: { exec: { mode: "deny" } } };
    const sessionKey = "agent:main:main";
    sessionEntries.set(sessionKey, { sessionId: "S2" });
    const oldPty = makeFakePty();
    const currentPty = makeFakePty();
    const ptys = [oldPty, currentPty];
    const spawn = vi.fn(async () => ptys.shift() ?? makeFakePty());
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn,
    });
    const oldOwner = agentTerminalOwner(sessionKey, "S1");
    const currentOwner = agentTerminalOwner(sessionKey, "S2");
    const oldSession = await manager.open(baseOpenRequest({ owner: oldOwner }));
    const currentSession = await manager.open(baseOpenRequest({ owner: currentOwner }));
    if (!oldSession.ok || !currentSession.ok) {
      throw new Error("expected operator-opened terminal sessions");
    }
    oldPty.emitData("stale session output\n");
    currentPty.emitData("current session output\n");
    const context = {
      terminalSessions: manager,
      isTerminalEnabled: () => true,
      resolveTerminalLaunchPolicy: () => ({
        ok: true,
        plan: { agentId: "main", cwd: "/tmp", shell: "/bin/sh", args: [] },
      }),
    } as never;

    try {
      const invokeTerminal = (args: Record<string, unknown>) =>
        withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
          invokeToolsRpc({ name: "terminal", args, sessionKey: "main" }, ["operator.admin"]),
        );
      const listed = await invokeTerminal({ action: "list" });
      expect(listed?.[1]?.ok).toBe(true);
      expect(lastCreateOpenClawToolsContext?.sessionId).toBe("S2");
      expect(listed?.[1]?.output).toMatchObject({
        details: { sessions: [expect.objectContaining({ sessionId: currentSession.sessionId })] },
      });
      const read = await invokeTerminal({ action: "read", sessionId: currentSession.sessionId });
      expect(read?.[1]?.output).toMatchObject({
        details: { sessionId: currentSession.sessionId, text: "current session output\n" },
      });
      const stale = await invokeTerminal({ action: "read", sessionId: oldSession.sessionId });
      expect(stale?.[1]).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("Terminal session unavailable") },
      });
      const resized = await invokeTerminal({
        action: "resize",
        sessionId: currentSession.sessionId,
        cols: 120,
        rows: 40,
      });
      expect(resized?.[1]?.output).toMatchObject({ details: { ok: true } });
      expect(currentPty.resizes).toEqual([[120, 40]]);

      spawn.mockClear();
      const opened = await invokeTerminal({ action: "open" });
      expect(opened?.[1]).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("terminal action unavailable") },
      });
      const input = await invokeTerminal({
        action: "input",
        sessionId: currentSession.sessionId,
        data: "unsafe\r",
      });
      expect(input?.[1]).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("Terminal input denied by execution policy") },
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(oldPty.writes).toEqual([]);
      expect(currentPty.writes).toEqual([]);

      sessionEntries.delete(sessionKey);
      const missing = await invokeTerminal({ action: "list" });
      expect(missing?.[1]).toMatchObject({
        ok: false,
        error: { message: "agent session id required" },
      });
      expect(lastCreateOpenClawToolsContext?.sessionId).toBeUndefined();
    } finally {
      manager.disposeAll();
    }
  });

  it("requires an operation-local marker for direct conversation reads", async () => {
    allowAgentsListForMain();
    for (const direct of [true, false]) {
      const caps = direct ? ["tool-events", "inline-widgets"] : undefined;
      await invokeToolsRpc(
        {
          name: "agents_list",
          args: {},
          sessionKey: "main",
          ...(direct ? { conversationReadOrigin: "direct-operator" } : {}),
        },
        ["operator.write"],
        direct
          ? { id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT, mode: GATEWAY_CLIENT_MODES.BACKEND }
          : { id: GATEWAY_CLIENT_NAMES.CLI, mode: GATEWAY_CLIENT_MODES.CLI },
        caps,
      );
      expect(lastCreateOpenClawToolsContext?.conversationReadOrigin).toBe(
        direct ? "direct-operator" : "delegated",
      );
      if (direct) {
        expect(lastCreateOpenClawToolsContext?.clientCaps).toEqual([
          "tool-events",
          "inline-widgets",
        ]);
      }
    }
  });

  it("keeps owner-only tools unavailable to non-owner RPC callers despite gateway.tools.allow", async () => {
    setMainAllowedTools({
      allow: ["cron", "gateway", "nodes"],
      gatewayAllow: ["cron", "gateway", "nodes"],
    });

    for (const tool of ["cron", "gateway", "nodes"]) {
      const call = await invokeToolsRpc({ name: tool, args: {}, sessionKey: "main" });

      expect(call?.[0], tool).toBe(true);
      // Legacy "cron" requests canonicalize before dispatch and report the canonical id.
      expect(call?.[1], tool).toMatchObject({
        ok: false,
        toolName: tool === "cron" ? "automations" : tool,
        error: { code: "not_found" },
      });
    }
    expect(lastCreateOpenClawToolsContext?.senderIsOwner).toBe(false);
  });

  it("keeps operator.admin RPC callers as owner for explicitly allowed owner-only tools", async () => {
    setMainAllowedTools({ allow: ["nodes"], gatewayAllow: ["nodes"] });

    const call = await invokeToolsRpc({ name: "nodes", args: {}, sessionKey: "main" }, [
      "operator.admin",
    ]);

    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ ok: true, toolName: "nodes" });
    expect(call?.[1]?.output).toEqual({ ok: true, result: "nodes" });
    expect(lastCreateOpenClawToolsContext?.senderIsOwner).toBe(true);
  });

  it("returns typed approval-needed refusal when the policy hook blocks", async () => {
    setMainAllowedTools({ allow: ["tools_invoke_test"] });
    hookMocks.runBeforeToolCallHook.mockResolvedValueOnce({
      blocked: true,
      kind: "failure",
      disposition: "blocked",
      deniedReason: "plugin-approval",
      reason: "Plugin approval required",
      params: { mode: "ok" },
    });

    const call = await invokeToolsRpc({
      name: "tools_invoke_test",
      args: { mode: "ok" },
      sessionKey: "main",
      confirm: false,
    });

    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: false,
      toolName: "tools_invoke_test",
      requiresApproval: true,
      error: { code: "requires_approval", message: "Plugin approval required" },
    });
  });

  it("rejects mismatched session and agent scope", async () => {
    cfg = {
      agents: {
        entries: {
          main: { tools: { allow: ["agents_list"] } },
          other: { tools: { allow: ["agents_list"] } },
        },
      },
    };

    const call = await invokeToolsRpc({
      name: "agents_list",
      sessionKey: "agent:main:main",
      agentId: "other",
    });

    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: false,
      toolName: "agents_list",
      error: {
        code: "validation_error",
        message: 'agent "other" does not match session key agent "main"',
      },
    });
  });

  it("accepts a non-canonical spelling of the session agent id", async () => {
    allowAgentsListForMain();

    const call = await invokeToolsRpc({
      name: "agents_list",
      args: {},
      sessionKey: "main",
      agentId: "Main",
    });

    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ ok: true, toolName: "agents_list" });
    expect(call?.[1]?.output).toEqual({ ok: true, result: [] });
  });

  it("rejects malformed params at the RPC boundary", async () => {
    const call = await invokeToolsRpc({ name: "" });

    expect(call?.[0]).toBe(false);
    expect(call?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("invalid tools.invoke params"),
    });
  });
});
