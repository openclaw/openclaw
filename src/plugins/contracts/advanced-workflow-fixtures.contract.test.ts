import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentHarnessBeforeAgentFinalizeHook } from "../../agents/harness/lifecycle-hook-helpers.js";
import { updateSessionStore } from "../../config/sessions.js";
import { APPROVALS_SCOPE, READ_SCOPE } from "../../gateway/operator-scopes.js";
import { pluginHostHookHandlers } from "../../gateway/server-methods/plugin-host-hooks.js";
import type { GatewayClient, RespondFn } from "../../gateway/server-methods/types.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { createHookRunner } from "../hooks.js";
import { runPluginHostCleanup } from "../host-hook-cleanup.js";
import {
  cleanupPluginSessionSchedulerJobs,
  clearPluginHostRuntimeState,
  getPluginRunContext,
  listPluginSessionSchedulerJobs,
} from "../host-hook-runtime.js";
import { drainPluginNextTurnInjections } from "../host-hook-state.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import { runTrustedToolPolicies } from "../trusted-tool-policy.js";
import type { OpenClawPluginApi } from "../types.js";
import {
  registerApprovalWorkflowFixture,
  registerArtifactReplyFixture,
  registerBackgroundMonitorFixture,
  registerPolicyGateFixture,
  registerRetryControlFixture,
} from "./advanced-workflow-fixtures.js";

const workflowMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(async (...args: unknown[]) => {
    const method = typeof args[0] === "string" ? args[0] : "";
    if (method === "cron.add") {
      return { payload: { jobId: "workflow-cron-job" } };
    }
    return { ok: true };
  }),
  sendMessage: vi.fn(async (params: { channel?: string; to: string; mediaUrls?: string[] }) => ({
    channel: params.channel ?? "telegram",
    to: params.to,
    via: "gateway" as const,
    mediaUrl: params.mediaUrls?.[0] ?? null,
    mediaUrls: params.mediaUrls,
  })),
}));

vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: workflowMocks.callGatewayTool,
}));

vi.mock("../../infra/outbound/message.js", () => ({
  sendMessage: workflowMocks.sendMessage,
}));

type GatewayCallResult = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

async function waitForPluginEventHandlers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function callPluginGatewayMethod(params: {
  method: "plugins.uiDescriptors" | "plugins.sessionAction";
  body?: Record<string, unknown>;
  scopes?: string[];
}): Promise<GatewayCallResult> {
  let response: GatewayCallResult | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    response = { ok, payload, error };
  };
  await pluginHostHookHandlers[params.method]({
    req: { id: "test", type: "req", method: params.method, params: params.body ?? {} },
    params: params.body ?? {},
    client: {
      connId: "test-client",
      connect: { scopes: params.scopes ?? [] },
    } as GatewayClient,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  });
  return response ?? { ok: false, error: new Error("handler did not respond") };
}

async function withSessionStore(
  run: (params: { stateDir: string; storePath: string }) => Promise<void>,
): Promise<void> {
  const stateDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-workflow-fixture-"),
  );
  const storePath = path.join(stateDir, "sessions.json");
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  try {
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await withTempConfig({
      cfg: {
        session: { store: storePath },
      },
      run: async () => await run({ stateDir, storePath }),
    });
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("advanced workflow plugin contract fixtures", () => {
  beforeEach(() => {
    workflowMocks.callGatewayTool.mockClear();
    workflowMocks.sendMessage.mockClear();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentEventsForTest();
  });

  it("runs a generic approval workflow through Control UI action dispatch and priority resume injection", async () => {
    const seenEvents: unknown[] = [];

    await withSessionStore(async ({ storePath }) => {
      const { config, registry } = createPluginRegistryFixture();
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({
          id: "approval-workflow-fixture",
          name: "Approval Workflow Fixture",
          origin: "workspace",
        }),
        register: registerApprovalWorkflowFixture,
      });
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({
          id: "approval-observer-fixture",
          name: "Approval Observer Fixture",
          origin: "workspace",
        }),
        register(api) {
          api.registerAgentEventSubscription({
            id: "approval-observer",
            streams: ["approval"],
            handle(event) {
              seenEvents.push(event.data);
            },
          });
        },
      });
      setActivePluginRegistry(registry.registry);

      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-1",
          updatedAt: Date.now(),
          pluginExtensions: {
            "approval-workflow-fixture": {
              approval: { status: "pending", title: "Deploy production" },
            },
          },
          pluginNextTurnInjections: {
            "approval-workflow-fixture": [
              {
                id: "low-priority",
                pluginId: "approval-workflow-fixture",
                text: "low priority context",
                placement: "append_context",
                priority: 1,
                createdAt: 1,
              },
            ],
          },
        };
        return undefined;
      });

      const descriptors = await callPluginGatewayMethod({
        method: "plugins.uiDescriptors",
      });
      expect(descriptors).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          descriptors: expect.arrayContaining([
            expect.objectContaining({
              id: "approval-card",
              pluginId: "approval-workflow-fixture",
              renderer: "approval-card",
              actionIds: ["resolve-approval"],
              stateNamespace: "approval",
            }),
            expect.objectContaining({
              id: "approval-input-guard",
              renderer: "input-guard",
            }),
            expect.objectContaining({
              id: "workflow-sidebar",
              renderer: "sidebar-panel",
            }),
          ]),
        },
      });

      const missingScope = await callPluginGatewayMethod({
        method: "plugins.sessionAction",
        body: {
          pluginId: "approval-workflow-fixture",
          actionId: "resolve-approval",
          sessionKey: "agent:main:main",
          payload: { decision: "approved" },
        },
        scopes: [READ_SCOPE],
      });
      expect(missingScope).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: expect.stringContaining(APPROVALS_SCOPE),
        },
      });

      await expect(
        createHookRunner(registry.registry).runInboundClaim(
          {
            content: "continue please",
            channel: "telegram",
            sessionKey: "agent:main:main",
            isGroup: false,
          },
          { channelId: "telegram" },
        ),
      ).resolves.toEqual({
        handled: true,
        reply: { text: "An approval is pending. Use the approval card to continue." },
      });

      const success = await callPluginGatewayMethod({
        method: "plugins.sessionAction",
        body: {
          pluginId: "approval-workflow-fixture",
          actionId: "resolve-approval",
          sessionKey: "agent:main:main",
          payload: { decision: "approved" },
        },
        scopes: [APPROVALS_SCOPE],
      });
      expect(success).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          result: { decision: "approved" },
          continueAgent: true,
          reply: { text: "Approval approved" },
        },
      });

      await waitForPluginEventHandlers();
      expect(seenEvents).toEqual([
        expect.objectContaining({
          phase: "resolved",
          decision: "approved",
          pluginId: "approval-workflow-fixture",
        }),
      ]);

      await expect(
        drainPluginNextTurnInjections({
          sessionKey: "agent:main:main",
          now: Date.now(),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "approval:approved",
          priority: 100,
          text: expect.stringContaining("Operator decision received"),
        }),
        expect.objectContaining({
          id: "low-priority",
          priority: 1,
        }),
      ]);

      await updateSessionStore(storePath, (store) => {
        const extension = store["agent:main:main"]?.pluginExtensions?.["approval-workflow-fixture"];
        if (extension) {
          extension.approval = { status: "approved", title: "Deploy production" };
        }
        return undefined;
      });
      await expect(
        createHookRunner(registry.registry).runInboundClaim(
          {
            content: "continue please",
            channel: "telegram",
            sessionKey: "agent:main:main",
            isGroup: false,
          },
          { channelId: "telegram" },
        ),
      ).resolves.toBeUndefined();

      const typedError = await callPluginGatewayMethod({
        method: "plugins.sessionAction",
        body: {
          pluginId: "approval-workflow-fixture",
          actionId: "missing-action",
        },
        scopes: [APPROVALS_SCOPE],
      });
      expect(typedError).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "unknown plugin session action: approval-workflow-fixture/missing-action",
        },
      });
    });
  });

  it("blocks a mutating tool from trusted policy state before normal hooks run", async () => {
    await withSessionStore(async ({ storePath }) => {
      const normalHookCalls: string[] = [];
      const { config, registry } = createPluginRegistryFixture();
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({
          id: "policy-gate-fixture",
          name: "Policy Gate Fixture",
          origin: "bundled",
        }),
        register(api) {
          registerPolicyGateFixture(api, normalHookCalls);
        },
      });
      setActivePluginRegistry(registry.registry);

      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-1",
          updatedAt: Date.now(),
          pluginExtensions: {
            "policy-gate-fixture": {
              policy: { locked: true, reason: "budget exhausted" },
            },
          },
        };
        return undefined;
      });

      const policy = await runTrustedToolPolicies(
        { toolName: "mutating_tool", params: {} },
        { toolName: "mutating_tool", sessionKey: "agent:main:main" },
      );
      expect(policy).toEqual({
        block: true,
        blockReason: "budget exhausted",
      });

      if (!policy?.block) {
        await createHookRunner(registry.registry).runBeforeToolCall(
          { toolName: "mutating_tool", params: {} },
          { toolName: "mutating_tool", sessionKey: "agent:main:main" },
        );
      }
      expect(normalHookCalls).toEqual([]);
    });
  });

  it("schedules and cleans a background monitor wake-up while preserving heartbeat context", async () => {
    const scheduled: ReturnType<OpenClawPluginApi["scheduleSessionTurn"]>[] = [];

    await withSessionStore(async ({ storePath }) => {
      const { config, registry } = createPluginRegistryFixture();
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({
          id: "background-monitor-fixture",
          name: "Background Monitor Fixture",
          origin: "bundled",
        }),
        register(api) {
          registerBackgroundMonitorFixture(api, scheduled);
        },
      });
      setActivePluginRegistry(registry.registry);

      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-1",
          updatedAt: Date.now(),
          pluginExtensions: {
            "background-monitor-fixture": {
              monitor: { status: "waiting" },
            },
          },
        };
        return undefined;
      });

      await expect(scheduled[0]).resolves.toEqual({
        id: "workflow-cron-job",
        pluginId: "background-monitor-fixture",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      });
      expect(workflowMocks.callGatewayTool).toHaveBeenCalledWith(
        "cron.add",
        {},
        expect.objectContaining({
          name: "background-monitor-status-check",
          sessionTarget: "session:agent:main:main",
          payload: {
            kind: "agentTurn",
            message: "Background monitor wake-up",
          },
        }),
        expect.objectContaining({ scopes: expect.arrayContaining(["operator.admin"]) }),
      );
      const cronAddParams = workflowMocks.callGatewayTool.mock.calls.find(
        ([method]) => method === "cron.add",
      )?.[2] as Record<string, unknown> | undefined;
      expect(cronAddParams).not.toHaveProperty("delivery");

      await expect(
        createHookRunner(registry.registry).runHeartbeatPromptContribution(
          { sessionKey: "agent:main:main" },
          { sessionKey: "agent:main:main", runId: "monitor-run" },
        ),
      ).resolves.toEqual({
        appendContext: "Background monitor status: waiting for the next check.",
      });

      emitAgentEvent({
        runId: "monitor-run",
        stream: "tool",
        data: { name: "status_check" },
      });
      await waitForPluginEventHandlers();
      expect(
        getPluginRunContext({
          pluginId: "background-monitor-fixture",
          get: { runId: "monitor-run", namespace: "last-status" },
        }),
      ).toEqual({
        runId: "monitor-run",
        stream: "tool",
      });

      await expect(
        runPluginHostCleanup({
          registry: registry.registry,
          pluginId: "background-monitor-fixture",
          reason: "disable",
        }),
      ).resolves.toMatchObject({ failures: [] });
      await expect(
        cleanupPluginSessionSchedulerJobs({
          pluginId: "background-monitor-fixture",
          reason: "disable",
        }),
      ).resolves.toEqual([]);
      expect(listPluginSessionSchedulerJobs("background-monitor-fixture")).toEqual([]);
      expect(workflowMocks.callGatewayTool).toHaveBeenCalledWith(
        "cron.remove",
        {},
        { id: "workflow-cron-job" },
        expect.objectContaining({ scopes: expect.arrayContaining(["operator.admin"]) }),
      );
    });
  });

  it("sends a generated artifact through the host-mediated session attachment seam", async () => {
    await withSessionStore(async ({ stateDir, storePath }) => {
      const artifactPath = path.join(stateDir, "workflow-artifact.txt");
      await fs.writeFile(artifactPath, "fixture artifact\n", "utf8");

      const { config, registry } = createPluginRegistryFixture();
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({
          id: "artifact-reply-fixture",
          name: "Artifact Reply Fixture",
          origin: "bundled",
        }),
        register(api) {
          registerArtifactReplyFixture(api, artifactPath);
        },
      });
      setActivePluginRegistry(registry.registry);

      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-1",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "telegram",
            to: "chat-1",
            accountId: "bot-1",
            threadId: "thread-1",
          },
        };
        return undefined;
      });

      await expect(
        callPluginGatewayMethod({
          method: "plugins.sessionAction",
          body: {
            pluginId: "artifact-reply-fixture",
            actionId: "send-artifact",
            sessionKey: "agent:main:main",
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        payload: {
          ok: true,
          result: {
            deliveredTo: "chat-1",
            count: 1,
          },
          reply: { text: "Artifact sent." },
        },
      });
      expect(workflowMocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "chat-1",
          channel: "telegram",
          accountId: "bot-1",
          threadId: "thread-1",
          requesterSessionKey: "agent:main:main",
          mediaUrls: [artifactPath],
          content: "Generated workflow artifact",
        }),
      );
    });
  });

  it("requests one bounded finalize retry and then stops retrying for the same run", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "retry-control-fixture",
        name: "Retry Control Fixture",
        origin: "bundled",
      }),
      register: registerRetryControlFixture,
    });
    const hookRunner = createHookRunner(registry.registry);
    const event = {
      runId: "retry-run",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      turnId: "turn-1",
      provider: "codex",
      model: "gpt-5.4",
      cwd: "/workspace",
      transcriptPath: "/tmp/session.jsonl",
      stopHookActive: false,
      lastAssistantMessage: "ready to finalize",
    };
    const ctx = {
      runId: "retry-run",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({ event, ctx, hookRunner }),
    ).resolves.toEqual({
      action: "revise",
      reason: "Run one focused follow-up pass before finalizing.",
    });
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({ event, ctx, hookRunner }),
    ).resolves.toEqual({
      action: "continue",
    });
  });
});
