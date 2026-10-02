import assert from "node:assert/strict";
import os from "node:os";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installAcceptedSubagentGatewayMock } from "../../test-helpers/subagent-gateway.js";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

type LoadOptions = Parameters<typeof loadSubagentSpawnModuleForTest>[0];
type BindingService = ReturnType<NonNullable<LoadOptions["getSessionBindingService"]>>;
const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const registerSubagentRunMock = vi.fn();
const requireRecord = createRequireRecord("record", "expected-non-array-record");
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let pluginRuntime: typeof import("../../../plugins/runtime.js");
let pluginFixtures: typeof import("../../../test-utils/channel-plugins.js");
let config: Record<string, unknown>;
let bindingService: BindingService;
let routable = true;
let resolveTarget: NonNullable<LoadOptions["resolveConversationDeliveryTarget"]>;
const caller = {
  agentSessionKey: "agent:main:main",
  agentChannel: "matrix",
  agentTo: "room:parent",
};
function agentParams() {
  return requireRecord(
    callGatewayMock.mock.calls.find(([call]) => call.method === "agent")?.[0].params,
  );
}
function registered() {
  return requireRecord(registerSubagentRunMock.mock.calls[0]?.[0]);
}
function makeBindingService(
  bind: BindingService["bind"],
  listBySession: BindingService["listBySession"] = () => [],
): BindingService {
  return {
    getCapabilities: () => ({ adapterAvailable: true, bindSupported: true, placements: ["child"] }),
    bind,
    listBySession,
  };
}

describe("spawnSubagentDirect thread binding", () => {
  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      updateSessionStoreMock,
      registerSubagentRunMock,
      getRuntimeConfig: () => config,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      getSessionBindingService: () => bindingService,
      resolveConversationDeliveryTarget: (params) => resolveTarget(params),
    }));
    pluginRuntime = await import("../../../plugins/runtime.js");
    pluginFixtures = await import("../../../test-utils/channel-plugins.js");
  });
  beforeEach(() => {
    routable = true;
    callGatewayMock.mockReset();
    registerSubagentRunMock.mockReset();
    updateSessionStoreMock.mockReset();
    installAcceptedSubagentGatewayMock(callGatewayMock);
    installSessionStoreCaptureMock(updateSessionStoreMock);
    config = createSubagentSpawnTestConfig(os.tmpdir(), {
      agents: { list: [{ id: "main", workspace: "/tmp/workspace-main" }] },
      session: { threadBindings: { defaultSpawnContext: "isolated" } },
    });
    bindingService = makeBindingService(async (request) => ({
      targetSessionKey: request.targetSessionKey,
      targetKind: request.targetKind,
      status: "active",
      conversation: request.conversation,
    }));
    resolveTarget = ({ conversationId }) => ({
      to: conversationId ? `channel:${String(conversationId)}` : undefined,
    });
    pluginRuntime.setActivePluginRegistry(
      pluginFixtures.createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...pluginFixtures.createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
            messaging: {
              resolveDeliveryTarget: ({
                conversationId,
                parentConversationId,
              }: {
                conversationId: string;
                parentConversationId?: string;
              }) => {
                if (!routable) {
                  return {};
                }
                const parent = parentConversationId?.trim();
                const child = conversationId.trim();
                return parent && parent !== child
                  ? { to: `room:${parent}`, threadId: child }
                  : { to: `room:${child}` };
              },
            },
          },
        },
      ]),
    );
  });

  it.each([
    { mode: "run", thread: false, route: true, announce: false, cleanup: "delete" },
    { mode: "run", thread: true, route: true, announce: true, cleanup: "keep" },
    { mode: "session", thread: true, route: false, announce: true, cleanup: "keep" },
  ] as const)(
    "aligns $mode thread=$thread route=$route guidance and delivery",
    async ({ mode, thread, route, announce, cleanup }) => {
      routable = route;
      const result = await spawnSubagentDirect(
        { task: "Return findings", mode, thread, expectsCompletionMessage: announce, cleanup },
        caller,
      );
      expect(result.status).toBe("accepted");
      expect(agentParams().deliver).toBe(false);
      expect(result.expectsCompletionMessage).toBe(announce);
      expect(registered().expectsCompletionMessage).toBe(announce);
      const { extraSystemPrompt, message } = agentParams();
      assert(typeof extraSystemPrompt === "string", "child system prompt must be text");
      assert(typeof message === "string", "child task must be text");
      const guidance = `${extraSystemPrompt}\n${message}`;
      const contract = announce ? /completion event/i : /no completion notification/i;
      expect(guidance).toMatch(contract);
      expect(result.note).toMatch(contract);
      if (cleanup === "delete") {
        expect(registered()).toMatchObject({ cleanup: "delete" });
        expect(guidance).not.toContain("remains in the child session");
        expect(result.note).not.toContain("remains in the child session");
        expect(guidance).not.toMatch(/final auto-reported|Results auto-announce/);
        expect(result.note).not.toMatch(/Auto-announce is push-based/);
      }
    },
  );

  it.each([false, true])(
    "routes bound delivery separately from requester origin (generic=%s)",
    async (generic) => {
      const conversation = generic
        ? { channel: "collabchat", accountId: "work", conversationId: "collab_dm_1" }
        : {
            channel: "matrix",
            accountId: "bot-alpha",
            conversationId: "$thread-root",
            parentConversationId: "!room:example.org",
          };
      const bind = vi.fn<NonNullable<BindingService["bind"]>>(async (request) => ({
        targetSessionKey: request.targetSessionKey,
        targetKind: request.targetKind,
        status: "active",
        conversation,
      }));
      bindingService = makeBindingService(bind, () =>
        generic ? [{ status: "active", conversation }] : [],
      );
      if (generic) {
        resolveTarget = () => ({ to: "channel:collab_dm_1" });
      } else {
        config = createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["bot-alpha"] } },
            list: [
              { id: "main", workspace: "/tmp/workspace-main" },
              { id: "bot-alpha", workspace: "/tmp/workspace-bot-alpha" },
            ],
          },
          bindings: [
            {
              type: "route",
              agentId: "bot-alpha",
              match: {
                channel: "matrix",
                peer: { kind: "channel", id: "!room:example.org" },
                accountId: "bot-alpha",
              },
            },
          ],
        });
      }
      const result = await spawnSubagentDirect(
        {
          task: "reply with a marker",
          agentId: generic ? undefined : "bot-alpha",
          thread: true,
          mode: "session",
          context: "isolated",
        },
        {
          ...caller,
          agentAccountId: "bot-beta",
          agentTo: "room:!room:example.org",
        },
      );
      expect(result.status).toBe("accepted");
      expect(bind).toHaveBeenCalledOnce();
      if (!generic) {
        expect(bind.mock.calls[0]?.[0].conversation).toMatchObject({
          channel: "matrix",
          accountId: "bot-alpha",
          conversationId: "!room:example.org",
        });
      }
      expect(agentParams()).toMatchObject({
        channel: conversation.channel,
        accountId: conversation.accountId,
        to: generic ? "channel:collab_dm_1" : "room:!room:example.org",
        deliver: true,
        ...(generic ? {} : { threadId: "$thread-root" }),
      });
      expect(registered()).toMatchObject({
        requesterOrigin: { channel: "matrix", accountId: "bot-beta", to: "room:!room:example.org" },
        expectsCompletionMessage: false,
        spawnMode: "session",
      });
      expect(result.note).toMatch(/directly to the bound thread/i);
      expect(agentParams().extraSystemPrompt).toMatch(/directly to the bound thread/i);
    },
  );

  it("preserves lifecycle cleanup after thread registration fails", async () => {
    registerSubagentRunMock.mockRejectedValue(new Error("registry unavailable"));
    const result = await spawnSubagentDirect(
      { task: "fail after binding", thread: true, mode: "session", context: "isolated" },
      caller,
    );
    expect(result).toMatchObject({
      status: "error",
      error: "Failed to register subagent run: registry unavailable",
      runId: "run-1",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
    });
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        scopes: ["operator.admin"],
        params: expect.objectContaining({
          key: result.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: true,
        }),
      }),
    );
  });
});
