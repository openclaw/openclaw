import fs from "node:fs/promises";
import path from "node:path";
import { registerTestPlugin } from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentHarnessBeforeAgentFinalizeHook } from "../../agents/harness/lifecycle-hook-helpers.js";
import { updateSessionStore } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronServiceContract } from "../../cron/service-contract.js";
import type { CronJob, CronJobCreate } from "../../cron/types.js";
import { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../../gateway/operator-scopes.js";
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
import { drainPluginNextTurnInjections, patchPluginSessionExtension } from "../host-hook-state.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRegistry } from "../registry.js";
import { setActivePluginRegistry } from "../runtime.js";
import type { PluginRuntime } from "../runtime/types.js";
import { createPluginRecord } from "../status.test-helpers.js";
import { runTrustedToolPolicies } from "../trusted-tool-policy.js";
import type { PluginSessionSchedulerJobHandle } from "../types.js";
import {
  registerApprovalWorkflowFixture,
  registerArtifactReplyFixture,
  registerBackgroundMonitorFixture,
  registerPolicyGateFixture,
  registerRetryControlFixture,
} from "./advanced-workflow-fixtures.js";

const workflowMocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  cronAdd: vi.fn(),
  cronListPage: vi.fn(),
  cronRemove: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: workflowMocks.getChannelPlugin,
}));

vi.mock("../../infra/outbound/message.js", () => ({
  sendMessage: workflowMocks.sendMessage,
}));

function createPluginRegistryFixture(
  config = {} as OpenClawConfig,
  params: { hostServices?: Parameters<typeof createPluginRegistry>[0]["hostServices"] } = {},
) {
  return {
    config,
    registry: createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {
        config: {
          current: () => config,
        },
      } as unknown as PluginRuntime,
      ...(params.hostServices ? { hostServices: params.hostServices } : {}),
    }),
  };
}

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

function createMockCronService(): CronServiceContract {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    status: vi.fn(async () => ({
      enabled: true,
      storePath: "/tmp/openclaw-test-cron.json",
      jobs: 0,
      nextWakeAtMs: null,
    })),
    list: vi.fn(async () => []),
    listPage: workflowMocks.cronListPage,
    add: workflowMocks.cronAdd,
    update: vi.fn(async (id, patch) => makeCronJob({ id, ...patch })),
    remove: workflowMocks.cronRemove,
    run: vi.fn(async () => ({ ok: true, ran: false, reason: "not-due" })),
    enqueueRun: vi.fn(async () => ({ ok: true, ran: false, reason: "not-due" })),
    getJob: vi.fn(() => undefined),
    getDefaultAgentId: vi.fn(() => undefined),
    wake: vi.fn(() => ({ ok: true })),
  } as CronServiceContract;
}

function makeCronJob(input: Partial<CronJob> & { id: string }): CronJob {
  return {
    name: input.name ?? input.id,
    enabled: true,
    schedule: { kind: "at", at: "2026-05-01T00:00:00.000Z" },
    sessionTarget: input.sessionTarget ?? "session:agent:main:main",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "wake" },
    delivery: { mode: "announce", channel: "last" },
    state: {},
    createdAtMs: 0,
    updatedAtMs: 0,
    ...input,
  };
}

function getCronAddBody() {
  const addCall = workflowMocks.cronAdd.mock.calls[0];
  expect(addCall).toBeDefined();
  return addCall?.[0] as CronJobCreate;
}

describe("advanced workflow plugin contract fixtures", () => {
  beforeEach(() => {
    workflowMocks.getChannelPlugin.mockReset();
    workflowMocks.cronAdd.mockReset();
    workflowMocks.cronListPage.mockReset();
    workflowMocks.cronRemove.mockReset();
    workflowMocks.sendMessage.mockReset();
    workflowMocks.cronAdd.mockResolvedValue(makeCronJob({ id: "workflow-cron-job" }));
    workflowMocks.cronListPage.mockResolvedValue({
      jobs: [],
      total: 0,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    });
    workflowMocks.cronRemove.mockResolvedValue({ ok: true, removed: true });
    workflowMocks.sendMessage.mockImplementation(
      async (params: { channel?: string; to: string; mediaUrls?: string[] }) => ({
        channel: params.channel ?? "telegram",
        to: params.to,
        via: "direct" as const,
        mediaUrl: null,
        mediaUrls: params.mediaUrls,
        result: { channel: params.channel ?? "telegram", messageId: "workflow-artifact-1" },
      }),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentEventsForTest();
  });

  it("runs a generic approval workflow through Control UI action dispatch and resume injection", async () => {
    const seenEvents: unknown[] = [];

    await withSessionStore(async ({ storePath }) => {
      const { config, registry } = createPluginRegistryFixture({ session: { store: storePath } });
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({
          id: "approval-workflow-fixture",
          name: "Approval Workflow Fixture",
          origin: "bundled",
        }),
        register: registerApprovalWorkflowFixture,
      });
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({
          id: "approval-observer-fixture",
          name: "Approval Observer Fixture",
          origin: "bundled",
        }),
        register(api) {
          api.agent.events.registerAgentEventSubscription({
            id: "approval-observer",
            streams: ["plugin.approval"],
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
          pluginNextTurnInjections: {
            "approval-workflow-fixture": [
              {
                id: "low-priority",
                pluginId: "approval-workflow-fixture",
                text: "low priority context",
                placement: "append_context",
                createdAt: 1,
              },
            ],
          },
        };
        return undefined;
      });
      await expect(
        patchPluginSessionExtension({
          cfg: config,
          pluginId: "approval-workflow-fixture",
          sessionKey: "agent:main:main",
          namespace: "approval",
          value: { status: "pending", title: "Deploy production" },
        }),
      ).resolves.toMatchObject({ ok: true });

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
              requiredScopes: [APPROVALS_SCOPE],
            }),
            expect.objectContaining({
              id: "approval-input-guard",
              requiredScopes: [APPROVALS_SCOPE],
            }),
            expect.objectContaining({
              id: "workflow-sidebar",
              requiredScopes: [APPROVALS_SCOPE],
            }),
          ]),
        },
      });
      const descriptorList = (
        descriptors.payload as { descriptors: Array<Record<string, unknown>> }
      ).descriptors.filter((descriptor) => descriptor.pluginId === "approval-workflow-fixture");
      expect(descriptorList).toHaveLength(3);
      for (const descriptor of descriptorList) {
        expect(descriptor).not.toHaveProperty("renderer");
        expect(descriptor).not.toHaveProperty("stateNamespace");
        expect(descriptor).not.toHaveProperty("actionIds");
      }

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

      const drainedInjections = await drainPluginNextTurnInjections({
        cfg: config,
        sessionKey: "agent:main:main",
        now: Date.now(),
      });
      expect(drainedInjections).toHaveLength(2);
      expect(drainedInjections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "approval:approved",
            text: expect.stringContaining("Operator decision received"),
          }),
          expect.objectContaining({
            id: "low-priority",
          }),
        ]),
      );

      await expect(
        patchPluginSessionExtension({
          cfg: config,
          pluginId: "approval-workflow-fixture",
          sessionKey: "agent:main:main",
          namespace: "approval",
          value: { status: "approved", title: "Deploy production" },
        }),
      ).resolves.toMatchObject({ ok: true });
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
      const { config, registry } = createPluginRegistryFixture({ session: { store: storePath } });
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
        };
        return undefined;
      });
      await expect(
        patchPluginSessionExtension({
          cfg: config,
          pluginId: "policy-gate-fixture",
          sessionKey: "agent:main:main",
          namespace: "policy",
          value: { locked: true, reason: "budget exhausted" },
        }),
      ).resolves.toMatchObject({ ok: true });

      const policy = await runTrustedToolPolicies(
        { toolName: "mutating_tool", params: {} },
        { toolName: "mutating_tool", sessionKey: "agent:main:main" },
        { config },
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

  it("reads trusted policy state from the caller config session store", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-policy-config-fixture-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    try {
      const { config, registry } = createPluginRegistryFixture({ session: { store: storePath } });
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({
          id: "policy-gate-fixture",
          name: "Policy Gate Fixture",
          origin: "bundled",
        }),
        register(api) {
          registerPolicyGateFixture(api, []);
        },
      });
      setActivePluginRegistry(registry.registry);

      await updateSessionStore(storePath, (store) => {
        store["agent:main:policy-config-regression"] = {
          sessionId: "session-policy-config",
          updatedAt: Date.now(),
        };
        return undefined;
      });
      await expect(
        patchPluginSessionExtension({
          cfg: config,
          pluginId: "policy-gate-fixture",
          sessionKey: "agent:main:policy-config-regression",
          namespace: "policy",
          value: { locked: true, reason: "custom store policy" },
        }),
      ).resolves.toMatchObject({ ok: true });

      await expect(
        runTrustedToolPolicies(
          { toolName: "mutating_tool", params: {} },
          {
            toolName: "mutating_tool",
            sessionKey: "agent:main:policy-config-regression",
          },
          { config },
        ),
      ).resolves.toEqual({
        block: true,
        blockReason: "custom store policy",
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("schedules and cleans a background monitor wake-up while preserving heartbeat context", async () => {
    const scheduled: Promise<PluginSessionSchedulerJobHandle | undefined>[] = [];

    await withSessionStore(async ({ storePath }) => {
      const cron = createMockCronService();
      const { config, registry } = createPluginRegistryFixture(
        { session: { store: storePath } },
        { hostServices: { cron } },
      );
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
        };
        return undefined;
      });
      await expect(
        patchPluginSessionExtension({
          cfg: config,
          pluginId: "background-monitor-fixture",
          sessionKey: "agent:main:main",
          namespace: "monitor",
          value: { status: "waiting" },
        }),
      ).resolves.toMatchObject({ ok: true });

      await expect(
        callPluginGatewayMethod({
          method: "plugins.sessionAction",
          body: {
            pluginId: "background-monitor-fixture",
            actionId: "schedule-monitor-check",
            sessionKey: "agent:main:main",
          },
          scopes: [WRITE_SCOPE],
        }),
      ).resolves.toMatchObject({
        ok: true,
        payload: {
          ok: true,
          result: {
            id: "workflow-cron-job",
            pluginId: "background-monitor-fixture",
            sessionKey: "agent:main:main",
            kind: "session-turn",
          },
        },
      });
      await expect(scheduled[0]).resolves.toEqual({
        id: "workflow-cron-job",
        pluginId: "background-monitor-fixture",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      });
      expect(workflowMocks.cronAdd).toHaveBeenCalledTimes(1);
      expect(getCronAddBody()).toMatchObject({
        name: "plugin:background-monitor-fixture:tag:monitor:agent:main:main:background-monitor-status-check",
        sessionTarget: "session:agent:main:main",
        payload: {
          kind: "agentTurn",
          message: "Background monitor wake-up",
        },
        deleteAfterRun: true,
        wakeMode: "now",
        delivery: { mode: "announce", channel: "last" },
      });

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
          cfg: config,
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
      expect(workflowMocks.cronRemove).toHaveBeenCalledWith("workflow-cron-job");
    });
  });

  it("sends a generated artifact through the host-mediated session attachment seam", async () => {
    await withSessionStore(async ({ stateDir, storePath }) => {
      const artifactPath = path.join(stateDir, "workflow-artifact.txt");
      await fs.writeFile(artifactPath, "fixture artifact\n", "utf8");

      const { config, registry } = createPluginRegistryFixture({ session: { store: storePath } });
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
          scopes: [READ_SCOPE],
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: expect.stringContaining(WRITE_SCOPE),
        },
      });
      await expect(
        callPluginGatewayMethod({
          method: "plugins.sessionAction",
          body: {
            pluginId: "artifact-reply-fixture",
            actionId: "send-artifact",
            sessionKey: "agent:main:main",
          },
          scopes: [WRITE_SCOPE],
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
