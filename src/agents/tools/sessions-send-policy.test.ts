import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionToolsVisibility } from "../../plugin-sdk/session-visibility.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import * as sessionStateEvents from "../../sessions/session-state-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionStatusTool } from "./session-status-tool.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import { createSessionsListTool } from "./sessions-list-tool.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

const requesterKey = "agent:main:dashboard:requester";
const subagentRequesterKey = "agent:main:subagent:requester";
const workerKey = "agent:worker:main";
const workerSessionId = "91ee481c-f60c-42bc-a238-2fb0306e4f55";
const nativeChildKey = "agent:worker:subagent:owned-child";
const acpChildKey = "agent:worker:acp:owned-child";
const replyText = "Result from the dispatched run only";
const runId = "send-policy-run";
const sessions = [
  { key: requesterKey, agentId: "main", sessionId: "requester-session" },
  { key: subagentRequesterKey, agentId: "main", sessionId: "subagent-requester-session" },
  { key: workerKey, agentId: "worker", sessionId: workerSessionId, label: "delegation-worker" },
  { key: "agent:stranger:main", agentId: "stranger", sessionId: "stranger-session" },
  {
    key: nativeChildKey,
    agentId: "worker",
    sessionId: "native-child-session",
    label: "native-child",
    spawnedBy: requesterKey,
  },
  {
    key: acpChildKey,
    agentId: "worker",
    sessionId: "acp-child-session",
    label: "acp-child",
    spawnedBy: requesterKey,
  },
];

function configFor(
  options: {
    send?: string[];
    visibility?: SessionToolsVisibility;
    global?: NonNullable<OpenClawConfig["tools"]>["agentToAgent"];
  } = {},
): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { sandbox: { sessionToolsVisibility: "spawned" } },
      entries: {
        main: options.send === undefined ? {} : { tools: { agentToAgent: { send: options.send } } },
        // This is an outbound edge, not the worker's permission to receive.
        worker: { tools: { agentToAgent: { send: [] } } },
        stranger: {},
      },
    },
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      sessions: { visibility: options.visibility ?? "self" },
      agentToAgent: options.global ?? { enabled: true, allow: ["main", "worker", "stranger"] },
    },
  };
}

const callGateway = vi.fn();

function gatewayMethods() {
  return callGateway.mock.calls.map(([request]) => request.method);
}

function send(
  config: OpenClawConfig,
  target: { agentId?: string; sessionKey?: string; label?: string; watch?: boolean },
  options: { agentSessionKey?: string; sandboxed?: boolean } = {},
) {
  setRuntimeConfigSnapshot(config);
  return createSessionsSendTool({
    config,
    agentSessionKey: requesterKey,
    callGateway,
    idempotencyKey: runId,
    ...options,
  }).execute("send-policy", {
    ...target,
    message: "Please handle this task",
    timeoutSeconds: 1,
  });
}

function expectNoDispatch() {
  expect(gatewayMethods()).not.toContain("agent");
  expect(gatewayMethods()).not.toContain("agent.wait");
}

describe("sessions_send directed policy at the tool boundary", () => {
  let state: OpenClawTestState;
  let originalRegistry: ReturnType<typeof captureActivePluginRegistrySnapshot>;

  beforeAll(async () => {
    originalRegistry = captureActivePluginRegistrySnapshot();
    state = await createOpenClawTestState({ scenario: "minimal" });
    setRuntimeConfigSnapshot(configFor());
    setActivePluginRegistry(createSessionConversationTestRegistry());
    for (const { key, agentId, sessionId, ...entry } of sessions) {
      await replaceSessionEntry(
        { agentId, sessionKey: key },
        { sessionId, updatedAt: 1, ...entry },
      );
    }
  });

  beforeEach(() => {
    // Model only the Gateway transport: resolution returns inventory facts, never policy decisions.
    callGateway.mockReset();
    callGateway.mockImplementation(
      async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
        const params = isRecord(request.params) ? request.params : {};
        if (request.method === "sessions.resolve") {
          const row = sessions.find(
            (session) =>
              (params.key === session.key ||
                params.sessionId === session.sessionId ||
                (params.label !== undefined && params.label === session.label)) &&
              (!params.agentId || params.agentId === session.agentId) &&
              (!params.spawnedBy || params.spawnedBy === session.spawnedBy),
          );
          if (row) {
            return { key: row.key, agentId: row.agentId };
          }
          if (params.allowMissing) {
            return {};
          }
          throw new Error("No session found");
        }
        if (request.method === "sessions.list") {
          return {
            sessions: sessions
              .filter((session) => !params.spawnedBy || params.spawnedBy === session.spawnedBy)
              .map(({ key, agentId, sessionId, label, spawnedBy }) => ({
                key,
                agentId,
                sessionId,
                label,
                spawnedBy,
                classification: "main",
              })),
          };
        }
        if (request.method === "agent") {
          return { runId, status: "accepted" };
        }
        if (request.method === "agent.wait") {
          expect(params.runId).toBe(runId);
          return {
            runId,
            status: "ok",
            terminalReply: { disposition: "visible", text: replyText },
          };
        }
        throw new Error("Unexpected Gateway method: " + request.method);
      },
    );
  });

  it.each([
    ["agent ID", { agentId: "worker" }, configFor({ send: [] }), true],
    [
      "global disable",
      { sessionKey: workerKey },
      configFor({ send: ["worker"], global: { enabled: false } }),
      true,
    ],
    [
      "unrelated reload",
      { sessionKey: workerKey },
      { ...configFor({ send: ["worker"] }), gateway: { port: 19870 } },
      false,
    ],
  ] as const)("rechecks current policy after resolving %s", async (_name, target, next, denied) => {
    const resolving = createDeferredCore();
    const resume = createDeferredCore();
    const resolve = callGateway.getMockImplementation()!;
    callGateway.mockImplementation(
      async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
        if (request.method === "sessions.resolve") {
          resolving.resolve();
          await resume.promise;
        }
        return await resolve(request);
      },
    );
    const pending = send(configFor({ send: ["worker"] }), target);
    try {
      await resolving.promise;
      setRuntimeConfigSnapshot(next);
      resume.resolve();
      expect((await pending).details).toMatchObject({ status: denied ? "forbidden" : "ok" });
      if (denied) {
        expectNoDispatch();
      } else {
        expect(gatewayMethods()).toContain("agent");
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([pending]);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    expect(gatewayMethods()).not.toContain("chat.history");
  });

  afterAll(async () => {
    restoreActivePluginRegistrySnapshot(originalRegistry);
    await state.cleanup();
  });

  it("sends by session ID under self visibility and returns only that run's reply", async () => {
    const result = await send(configFor({ send: ["worker"], visibility: "self" }), {
      sessionKey: workerSessionId,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      sessionKey: workerKey,
      runId,
      reply: replyText,
    });
    const dispatches = callGateway.mock.calls.filter(([request]) => request.method === "agent");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.[0].params).toMatchObject({
      agentId: "worker",
      sessionKey: workerKey,
      inputProvenance: { sourceSessionKey: requesterKey, sourceTool: "sessions_send" },
    });
    expect(gatewayMethods().filter((method) => method === "agent.wait")).toHaveLength(1);
  });

  it("denies an unlisted key even with all visibility before dispatch", async () => {
    const result = await send(configFor({ send: ["worker"], visibility: "all" }), {
      sessionKey: "agent:stranger:main",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("tools.agentToAgent.send"),
    });
    expectNoDispatch();
  });

  it("denies invisible sends when outbound policy is omitted", async () => {
    const result = await send(configFor({ visibility: "self" }), { agentId: "worker" });
    expect(result.details).toMatchObject({ status: "forbidden" });
    expectNoDispatch();
  });

  it.each([
    {
      name: "requester excluded",
      global: { enabled: true, allow: ["worker"] },
      error: "tools.agentToAgent.allow",
    },
    {
      name: "target excluded",
      global: { enabled: true, allow: ["main"] },
      error: "tools.agentToAgent.allow",
    },
  ])("keeps the global $name ceiling", async ({ global, error }) => {
    const result = await send(configFor({ send: ["worker"], global }), { agentId: "worker" });
    expect(result.details).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining(error),
    });
    expectNoDispatch();
  });

  it("denies send-only watch before delivery but permits the plain run-scoped reply", async () => {
    const watch = vi.spyOn(sessionStateEvents, "registerSessionStateWatch").mockResolvedValue(true);
    const config = configFor({ send: ["worker"] });
    const watched = await send(config, { agentId: "worker", watch: true });
    expect(watched.details).toMatchObject({ status: "forbidden" });
    expectNoDispatch();
    expect(watch).not.toHaveBeenCalled();

    const plain = await send(config, { agentId: "worker" });
    expect(plain.details).toMatchObject({ status: "ok", reply: replyText });
    expect(watch).not.toHaveBeenCalled();
  });

  it("still registers a requested watch when the target has read visibility", async () => {
    const watch = vi.spyOn(sessionStateEvents, "registerSessionStateWatch").mockResolvedValue(true);
    const result = await send(configFor({ send: ["worker"], visibility: "all" }), {
      agentId: "worker",
      watch: true,
    });
    expect(result.details).toMatchObject({ status: "ok", reply: replyText, watched: true });
    expect(watch).toHaveBeenCalledOnce();
  });

  it.each([requesterKey, subagentRequesterKey])(
    "keeps sandbox spawned-only for requester %s",
    async (agentSessionKey) => {
      const config = configFor({ send: ["worker"], visibility: "all" });
      const denied = await send(
        config,
        { sessionKey: workerKey },
        { agentSessionKey, sandboxed: true },
      );
      expect(denied.details).toMatchObject({ status: "forbidden" });
      expectNoDispatch();

      // The identical target and outbound edge work without the sandbox ceiling.
      const allowed = await send(config, { sessionKey: workerKey }, { agentSessionKey });
      expect(allowed.details).toMatchObject({ status: "ok", reply: replyText });
    },
  );

  it("adds restart context when continuing an interrupted child", async () => {
    const target = { agentId: "worker", sessionKey: nativeChildKey };
    const entry = {
      sessionId: "native-child-session",
      updatedAt: 1,
      spawnedBy: requesterKey,
    };
    await replaceSessionEntry(target, { ...entry, status: "interrupted" });
    try {
      const result = await send(configFor({ send: [], visibility: "tree" }), {
        sessionKey: nativeChildKey,
      });
      expect(result.details).toMatchObject({ status: "ok", reply: replyText });
      const prompt = callGateway.mock.calls.find(([request]) => request.method === "agent")?.[0]
        .params.message;
      expect(prompt).toContain("Please handle this task");
      expect(prompt).toContain("interrupted by a gateway restart");
      expect(prompt).toContain("marked interrupted, missing, or aborted");
      expect(prompt).toContain("unknown outcome");
      expect(prompt).toContain("not proof of tool failure");
    } finally {
      await replaceSessionEntry(target, entry);
    }
  });

  it("retains owned-child access through its qualified label", async () => {
    const result = await send(configFor({ send: [], visibility: "tree" }), {
      label: "native-child",
      agentId: "worker",
    });
    expect(result.details).toMatchObject({
      status: "ok",
      sessionKey: nativeChildKey,
      reply: replyText,
    });
    const prompt = callGateway.mock.calls.find(([request]) => request.method === "agent")?.[0]
      .params.message;
    expect(prompt).not.toContain("gateway restart");
  });

  it("does not turn a send grant into list, history, search, or status access", async () => {
    const config = configFor({ send: ["worker"] });
    setRuntimeConfigSnapshot(config);
    const options = { config, agentSessionKey: requesterKey, callGateway };
    const listed = await createSessionsListTool(options).execute("list", {});
    expect(listed.details).toMatchObject({ count: 1, sessions: [{ key: requesterKey }] });

    const history = await createSessionsHistoryTool(options).execute("history", {
      sessionKey: workerKey,
    });
    expect(history.details).toMatchObject({ status: "forbidden" });
    const search = await createSessionsSearchTool(options).execute("search", {
      sessionKey: workerKey,
      query: "private",
    });
    expect(search.details).toMatchObject({ status: "forbidden" });
    await expect(
      createSessionStatusTool(options).execute("status", { sessionKey: workerKey }),
    ).rejects.toThrow("visibility");
    expectNoDispatch();
    expect(gatewayMethods()).not.toContain("sessions.search");
  });
});
