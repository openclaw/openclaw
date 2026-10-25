import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
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
import { truncateToolResultMessage } from "../embedded-agent-runner/tool-result-truncation.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import * as inProcessGateway from "./in-process-gateway.js";
import { createSessionStatusTool } from "./session-status-tool.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import { createSessionsListTool } from "./sessions-list-tool.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";
import { SessionsSendOutputSchema } from "./sessions-send-tool.schema.js";

const requesterKey = "agent:main:dashboard:requester";
const subagentRequesterKey = "agent:main:subagent:requester";
const workerKey = "agent:worker:main";
const workerSessionId = "91ee481c-f60c-42bc-a238-2fb0306e4f55";
const nativeChildKey = "agent:worker:subagent:owned-child";
const acpChildKey = "agent:worker:acp:owned-child";
const otherChildKey = "agent:worker:subagent:other-child";
const replyText = "Result from the dispatched run only";
const runId = "send-policy-run";
const sessions = [
  { key: requesterKey, agentId: "main", sessionId: "requester-session" },
  { key: subagentRequesterKey, agentId: "main", sessionId: "subagent-requester-session" },
  { key: workerKey, agentId: "worker", sessionId: workerSessionId, label: "delegation-worker" },
  { key: "global", agentId: "worker", sessionId: "raw-worker-session", label: "raw-worker" },
  { key: "agent:stranger:main", agentId: "stranger", sessionId: "stranger-session" },
  {
    key: nativeChildKey,
    agentId: "worker",
    sessionId: "native-child-session",
    label: "native-child",
    spawnedBy: requesterKey,
  },
  {
    key: otherChildKey,
    agentId: "worker",
    sessionId: "other-child-session",
    spawnedBy: "agent:other:main",
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
const terminalReply = (text: string) => ({
  runId,
  status: "ok",
  terminalReply: { disposition: "visible", text },
});
const assistantReply = (text: string, id = runId) => ({
  role: "assistant",
  __openclaw: { runId: id },
  content: [{ type: "text", text }],
});

function gatewayResponses(responses: Record<string, unknown>) {
  const transport = callGateway.getMockImplementation()!;
  callGateway.mockImplementation(async (request: Parameters<AgentToolGatewayRequestCaller>[0]) =>
    Object.hasOwn(responses, request.method) ? responses[request.method] : transport(request),
  );
}

function gatewayParams(method = "agent") {
  return callGateway.mock.calls.find(([request]) => request.method === method)?.[0].params;
}

function gatewayMethods() {
  return callGateway.mock.calls.map(([request]) => request.method);
}

function send(
  config: OpenClawConfig,
  target: {
    agentId?: string;
    sessionKey?: string;
    label?: string;
    watch?: boolean;
    message?: string;
  },
  options: { agentSessionKey?: string; sandboxed?: boolean; expectedTargetSessionId?: string } = {},
) {
  setRuntimeConfigSnapshot(config);
  return createSessionsSendTool({
    config,
    agentSessionKey: requesterKey,
    callGateway,
    idempotencyKey: runId,
    ...options,
  }).execute("send-policy", {
    message: "Please handle this task",
    timeoutSeconds: 1,
    ...target,
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
      await appendTranscriptMessage(
        { agentId, sessionKey: key, sessionId },
        {
          message: {
            ...assistantReply(replyText),
            phase: "final_answer",
            stopReason: "stop",
          },
        },
      );
    }
    await upsertAcpSessionMeta({
      cfg: configFor(),
      agentId: "worker",
      sessionKey: acpChildKey,
      mutate: () => ({
        backend: "acpx",
        agent: "worker",
        runtimeSessionName: "synthetic-acp-child",
        mode: "oneshot",
        state: "idle",
        lastActivityAt: 1,
      }),
    });
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
          return terminalReply(replyText);
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
  });

  afterAll(async () => {
    restoreActivePluginRegistrySnapshot(originalRegistry);
    await state.cleanup();
  });

  it("prefers sessionKey over a redundant label without trimming the message", async () => {
    const result = await send(configFor({ send: ["worker"] }), {
      sessionKey: workerKey,
      label: "stale-label",
      message: "    indented body",
    });

    expect(result.details).toMatchObject({ status: "ok", sessionKey: workerKey });
    expect(gatewayParams()).toMatchObject({
      sessionKey: workerKey,
      message: expect.stringMatching(/\n {4}indented body$/u),
    });
    expect(
      callGateway.mock.calls
        .filter(([request]) => request.method === "sessions.resolve")
        .map(([request]) => request.params?.label),
    ).not.toContain("stale-label");
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

  it.each([
    [
      "whitespace-shortened preview",
      `${"a".repeat(4_000)}${" ".repeat(100)}TAIL`,
      `${"a".repeat(4_000)}…`,
    ],
    ["literal ellipsis", "Still thinking…", "Still thinking…"],
    ["tool-budget overflow", `${"a".repeat(20_000)}TAIL`, `${"a".repeat(4_095)}…`],
    ["unavailable full reply", undefined, `${"a".repeat(4_095)}…`],
  ] as const)(
    "returns the accepted run's %s with explicit truncation",
    async (_name, full, preview) => {
      gatewayResponses({
        "agent.wait": terminalReply(preview),
        "chat.history": {
          messages: [
            ...(full === undefined ? [] : [assistantReply(full)]),
            assistantReply("Unrelated answer", "other-run"),
          ],
        },
      });

      const result = await send(configFor({ send: ["worker"] }), { agentId: "worker" });
      expect(Value.Check(SessionsSendOutputSchema, result.details)).toBe(true);
      if (full === undefined) {
        expect(result.details).toMatchObject({
          status: "ok",
          reply: preview,
          replyTruncated: true,
          note: expect.stringContaining("missing section or a file"),
        });
        return;
      }
      expect(result.details).toMatchObject({ status: "ok", reply: full });
      expect(result.details).not.toHaveProperty("replyTruncated");

      const projected = truncateToolResultMessage(
        {
          ...result,
          role: "toolResult",
          toolName: "sessions_send",
          toolCallId: "send-policy",
          isError: false,
          timestamp: 1,
        },
        16_000,
      );
      const text = projected.content.find((block) => block.type === "text")?.text;
      if (full.length > 16_000) {
        expect(text).toMatch(/\d+ more characters truncated/);
        expect(text).toContain("ask the target session for the missing section or a file");
        expect(text).toContain("do not repeat the original task");
      } else {
        expect(projected.content).toEqual(result.content);
      }
    },
  );

  it.each([
    [
      "unlisted key despite all visibility",
      configFor({ send: ["worker"], visibility: "all" }),
      { sessionKey: "agent:stranger:main" },
      "tools.agentToAgent.send",
    ],
    [
      "invisible target without outbound policy",
      configFor({ visibility: "self" }),
      { agentId: "worker" },
      undefined,
    ],
    [
      "global ceiling excluding requester",
      configFor({ send: ["worker"], global: { enabled: true, allow: ["worker"] } }),
      { agentId: "worker" },
      "tools.agentToAgent.allow",
    ],
    [
      "global ceiling excluding target",
      configFor({ send: ["worker"], global: { enabled: true, allow: ["main"] } }),
      { agentId: "worker" },
      "tools.agentToAgent.allow",
    ],
  ] as const)("denies %s before dispatch", async (_name, config, target, error) => {
    const result = await send(config, target);
    expect(result.details).toMatchObject({
      status: "forbidden",
      ...(error ? { error: expect.stringContaining(error) } : {}),
    });
    expectNoDispatch();
  });

  it.each([
    ["send-only", "self", false],
    ["read-visible", "all", false],
    ["parent", "tree", false],
    ["bound parent", "tree", true],
  ] as const)("keeps the %s watch ceiling", async (_name, visibility, bound) => {
    const config = configFor({ send: ["worker"], visibility });
    if (visibility === "tree") {
      gatewayResponses({
        "sessions.describe": {
          session: {
            key: nativeChildKey,
            agentId: "worker",
            sessionId: "native-child-session",
            spawnedBy: requesterKey,
            childOwnerSessionKeys: [requesterKey],
          },
        },
      });
    }
    const watch = vi.spyOn(sessionStateEvents, "registerSessionStateWatch").mockResolvedValue(true);
    const result = await send(
      config,
      visibility === "tree"
        ? { sessionKey: nativeChildKey, message: "Continue this exact child", watch: true }
        : { agentId: "worker", watch: true },
      bound ? { expectedTargetSessionId: "native-child-session" } : {},
    );
    if (visibility === "self") {
      expect(result.details).toMatchObject({ status: "forbidden" });
      expectNoDispatch();
      expect(watch).not.toHaveBeenCalled();
      expect((await send(config, { agentId: "worker" })).details).toMatchObject({
        status: "ok",
        reply: replyText,
      });
      expect(watch).not.toHaveBeenCalled();
    } else {
      expect(result.details).toMatchObject({ status: "ok", reply: replyText, watched: !bound });
      expect(watch).toHaveBeenCalledTimes(bound ? 0 : 1);
    }
  });

  it("reports a raw-target watch refusal without misreporting an accepted send", async () => {
    const result = await send(configFor({ send: ["worker"], visibility: "all" }), {
      label: "raw-worker",
      agentId: "worker",
      watch: true,
    });
    expect(result.details).toMatchObject({
      status: "ok",
      reply: replyText,
      watched: false,
      watchError: expect.stringContaining("agent-qualified"),
    });
    expect(gatewayMethods()).toContain("agent");
    expect(gatewayMethods()).toContain("agent.wait");
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

  it.each([
    ["owned native child", nativeChildKey, "automatic", true],
    ["another parent's native child", otherChildKey, "automatic", false],
    ["ordinary peer", workerKey, "message_tool_only", true],
    ["ACP child", acpChildKey, "message_tool_only", true],
  ] as const)(
    "retains the result path for a fresh input to %s",
    async (_name, sessionKey, mode, allowed) => {
      const result = await send(configFor({ visibility: "all" }), { sessionKey });
      if (!allowed) {
        expect(result.details).toMatchObject({ status: "forbidden" });
        expectNoDispatch();
        return;
      }
      expect(result.details).toMatchObject({ status: "ok", reply: replyText });
      expect(gatewayParams()).toMatchObject({
        sessionKey,
        deliver: false,
        sourceReplyDeliveryMode: mode,
      });
      expect(gatewayParams()).not.toHaveProperty("disableMessageTool", false);
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
      const prompt = gatewayParams()?.message;
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
    expect(gatewayParams()?.message).not.toContain("gateway restart");
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
    const statusGateway = vi
      .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
      .mockImplementation(callGateway);
    try {
      await expect(
        createSessionStatusTool({ config, agentSessionKey: requesterKey }).execute("status", {
          sessionKey: workerKey,
        }),
      ).rejects.toThrow("visibility");
    } finally {
      statusGateway.mockRestore();
    }
    expectNoDispatch();
    expect(gatewayMethods()).not.toContain("sessions.search");
    expect(gatewayMethods()).not.toContain("chat.history");
  });
});
