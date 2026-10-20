// Run context lifecycle contract tests cover plugin run context setup and cleanup.
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { getSessionEntry, upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runPluginHostCleanup } from "../host-hook-cleanup.js";
import {
  clearPluginHostRuntimeState,
  getPluginRunContext,
  dispatchPluginAgentEventSubscriptions,
  registerPluginSessionSchedulerJob,
  setPluginRunContext,
} from "../host-hook-runtime.js";
import {
  listPluginSessionSchedulerJobs,
  PLUGIN_TERMINAL_EVENT_CLEANUP_WAIT_MS,
} from "../host-hook-runtime.test-fixtures.js";
import { runPluginRegisterSyncInRegistry } from "../loader-module-runtime.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

const PLUGIN_HOST_CLEANUP_TIMEOUT_MS = 5_000;

function createRegisteredPlugin(pluginId: string, register: (api: OpenClawPluginApi) => void) {
  const fixture = createPluginRegistryFixture();
  registerTestPlugin({ ...fixture, record: createPluginRecord({ id: pluginId }), register });
  return fixture;
}

function contextReader(pluginId: string, runId: string) {
  return (namespace: string) => getPluginRunContext({ pluginId, get: { runId, namespace } });
}

function emitRunEvent(runId: string, stream: string, data: Record<string, unknown>) {
  emitAgentEvent({ runId, stream, data });
}

async function waitForPluginEventHandlers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function expectNoCleanupFailures(result: Awaited<ReturnType<typeof runPluginHostCleanup>>): void {
  expect(result.failures).toEqual([]);
}

function requireFailureByHookId(
  result: Awaited<ReturnType<typeof runPluginHostCleanup>>,
  hookId: string,
) {
  const failure = result.failures.find((entry) => entry.hookId === hookId);
  if (!failure) {
    throw new Error(`Expected cleanup failure for hook ${hookId}`);
  }
  return failure;
}

describe("plugin run context lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentEventsForTest();
  });

  it("keeps run-context APIs callable after registration closes", () => {
    const selection = { runId: "late-run", namespace: "state" };
    let capturedApi: OpenClawPluginApi | undefined;
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "late-run-context-plugin",
        name: "Late Run Context Plugin",
      }),
      register(api) {
        runPluginRegisterSyncInRegistry(
          (guardedApi) => {
            capturedApi = guardedApi;
          },
          api,
          registry.registry,
          "late-run-context-plugin",
        );
      },
    });
    setActivePluginRegistry(registry.registry);

    capturedApi?.registerGatewayMethod("late-run-context.blocked", () => {});
    expect(Object.keys(registry.registry.gatewayHandlers)).not.toContain(
      "late-run-context.blocked",
    );
    expect(
      capturedApi?.runContext.setRunContext({
        ...selection,
        value: { available: true },
      }),
    ).toBe(true);
    expect(capturedApi?.runContext.getRunContext(selection)).toEqual({ available: true });
    capturedApi?.runContext.clearRunContext(selection);
    expect(capturedApi?.runContext.getRunContext(selection)).toBeUndefined();
  });

  it("blocks stale plugin API run-context access after registry replacement", () => {
    const readContext = contextReader("stale-run-context-plugin", "stale-run");
    let capturedApi: OpenClawPluginApi | undefined;
    const { registry } = createRegisteredPlugin("stale-run-context-plugin", (api) => {
      capturedApi = api;
    });
    setActivePluginRegistry(registry.registry);
    setActivePluginRegistry(createEmptyPluginRegistry());

    expect(
      capturedApi?.runContext?.setRunContext({
        runId: "stale-run",
        namespace: "state",
        value: { stale: true },
      }),
    ).toBe(false);
    expect(readContext("state")).toBeUndefined();

    expect(
      setPluginRunContext({
        pluginId: "stale-run-context-plugin",
        patch: { runId: "stale-run", namespace: "state", value: { live: true } },
      }),
    ).toBe(true);
    expect(capturedApi?.getRunContext({ runId: "stale-run", namespace: "state" })).toBeUndefined();
    expect(
      capturedApi?.runContext.getRunContext({ runId: "stale-run", namespace: "state" }),
    ).toBeUndefined();
    capturedApi?.runContext?.clearRunContext({ runId: "stale-run", namespace: "state" });
    expect(readContext("state")).toEqual({ live: true });
  });

  it("allows run-context mutations after a previous registry is restored active", () => {
    let capturedApi: OpenClawPluginApi | undefined;
    const { registry } = createRegisteredPlugin("restored-run-context-plugin", (api) => {
      capturedApi = api;
    });
    setActivePluginRegistry(registry.registry);
    const snapshot = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");
    rollbackStagedPluginRegistry(snapshot);

    expect(
      capturedApi?.runContext?.setRunContext({
        runId: "restored-run",
        namespace: "state",
        value: { restored: true },
      }),
    ).toBe(true);
    expect(
      capturedApi?.runContext?.getRunContext({
        runId: "restored-run",
        namespace: "state",
      }),
    ).toEqual({ restored: true });
  });

  it("allows run-context initialization during activating plugin registration", () => {
    const readContext = contextReader("registration-run-context-plugin", "run-registration");
    const { config, registry } = createPluginRegistryFixture();
    const record = createPluginRecord({
      id: "registration-run-context-plugin",
      name: "Registration Run Context Plugin",
    });
    const api = registry.createApi(record, { config });

    runPluginRegisterSyncInRegistry(
      () => {
        expect(registry.registry.plugins).not.toContain(record);
        expect(
          api.setRunContext({
            runId: "run-registration",
            namespace: "state",
            value: { initialized: true },
          }),
        ).toBe(true);
        expect(readContext("state")).toEqual({ initialized: true });

        api.clearRunContext({ runId: "run-registration", namespace: "state" });
        expect(readContext("state")).toBeUndefined();
      },
      api,
      registry.registry,
      record.id,
    );
  });

  it("fences retired agent-event callbacks from successor run context", async () => {
    const readContext = contextReader("agent-event-generation", "run-agent-event-generation");
    let retiredHandlerSawContext: unknown;
    const priorHandlerStarted = createDeferredCore();
    const priorHandlerRelease = createDeferredCore();
    const prior = createRegisteredPlugin("agent-event-generation", (api) => {
      api.registerAgentEventSubscription({
        id: "prior",
        streams: ["tool"],
        async handle(event, ctx) {
          if (event.data.name !== "hold") {
            return;
          }
          priorHandlerStarted.resolve();
          await priorHandlerRelease.promise;
          retiredHandlerSawContext = ctx.getRunContext("state");
          ctx.setRunContext("state", { generation: "A" });
          ctx.clearRunContext("preserved");
        },
      });
    });
    const successor = createRegisteredPlugin("agent-event-generation", (api) => {
      api.registerAgentEventSubscription({
        id: "successor",
        streams: ["tool"],
        handle(event, ctx) {
          if (event.data.name !== "successor") {
            return;
          }
          ctx.setRunContext("state", { generation: "B" });
          ctx.setRunContext("preserved", { generation: "B" });
        },
      });
    });

    setActivePluginRegistry(prior.registry.registry);
    emitRunEvent("run-agent-event-generation", "tool", { name: "hold" });
    await priorHandlerStarted.promise;

    setActivePluginRegistry(successor.registry.registry);
    emitRunEvent("run-agent-event-generation", "tool", { name: "successor" });
    await waitForPluginEventHandlers();

    // Restoring the same registry object must not revive callbacks admitted before cutover.
    setActivePluginRegistry(prior.registry.registry);
    priorHandlerRelease.resolve();
    await waitForPluginEventHandlers();

    expect(retiredHandlerSawContext).toBeUndefined();
    expect(readContext("state")).toEqual({ generation: "B" });
    expect(readContext("preserved")).toEqual({ generation: "B" });
  });

  it("does not let delayed non-terminal subscriptions resurrect closed run context", async () => {
    const readContext = contextReader("delayed-subscription", "run-delayed-subscription");
    const toolHandlerRelease = createDeferredCore();
    let delayedToolHandlerSawContext: unknown;
    const { registry } = createRegisteredPlugin("delayed-subscription", (api) => {
      api.registerAgentEventSubscription({
        id: "delayed",
        streams: ["tool"],
        async handle(eventValue, ctx) {
          ctx.setRunContext("before-terminal", { visible: true });
          await toolHandlerRelease.promise;
          delayedToolHandlerSawContext = ctx.getRunContext("before-terminal");
          ctx.setRunContext("late", { resurrected: true });
        },
      });
    });
    setActivePluginRegistry(registry.registry);

    emitRunEvent("run-delayed-subscription", "tool", { name: "tool" });
    await Promise.resolve();

    emitRunEvent("run-delayed-subscription", "lifecycle", { phase: "end" });
    await Promise.resolve();

    expect(readContext("before-terminal")).toEqual({ visible: true });

    toolHandlerRelease.resolve();
    await waitForPluginEventHandlers();

    expect(delayedToolHandlerSawContext).toEqual({ visible: true });
    expect(readContext("late")).toBeUndefined();
  });

  it.each(
    ["end", "error"].flatMap((phase) => [
      { phase, payload: undefined },
      { phase, payload: "metadata" as const },
    ]),
  )(
    "cleans up a filtered terminal $phase event with payload=$payload after pending handlers settle",
    async ({ phase, payload }) => {
      const readContext = contextReader("filtered-terminal", "run-filtered-terminal");
      const pending = createDeferredCore();
      const handle = vi.fn<
        Parameters<OpenClawPluginApi["registerAgentEventSubscription"]>[0]["handle"]
      >(async (_event, ctx) => {
        ctx.setRunContext("seen", { active: true });
        await pending.promise;
        ctx.setRunContext("late", { active: true });
      });
      const { registry } = createRegisteredPlugin("filtered-terminal", (api) => {
        api.agent.events.registerAgentEventSubscription({
          id: "starts",
          streams: ["tool", "lifecycle"],
          phases: ["start"],
          payload,
          handle,
        });
      });
      setActivePluginRegistry(registry.registry);
      emitRunEvent("run-filtered-terminal", "tool", { phase: "start" });
      emitRunEvent("run-filtered-terminal", "lifecycle", { phase });
      expect(handle).toHaveBeenCalledTimes(1);
      expect(readContext("seen")).toEqual({ active: true });
      expect(
        setPluginRunContext({
          pluginId: "filtered-terminal",
          patch: { runId: "run-filtered-terminal", namespace: "closed", value: true },
        }),
      ).toBe(false);
      pending.resolve();
      await waitForPluginEventHandlers();
      for (const namespace of ["seen", "late", "closed"]) {
        expect(readContext(namespace)).toBeUndefined();
      }
    },
  );

  it("preserves run context until async terminal event subscriptions settle", async () => {
    const readContext = contextReader("async-terminal-subscription", "run-async-terminal");
    const terminalHandlerRelease = createDeferredCore();
    let terminalHandlerSawContext: unknown;
    const { registry } = createRegisteredPlugin("async-terminal-subscription", (api) => {
      api.registerAgentEventSubscription({
        id: "records",
        streams: ["tool", "lifecycle"],
        async handle(event, ctx) {
          if (event.stream === "tool") {
            ctx.setRunContext("seen", { runId: event.runId });
            return;
          }
          if (event.data?.phase !== "end") {
            return;
          }
          await terminalHandlerRelease.promise;
          terminalHandlerSawContext = ctx.getRunContext("seen");
        },
      });
    });
    setActivePluginRegistry(registry.registry);

    emitRunEvent("run-async-terminal", "tool", { name: "tool" });
    await Promise.resolve();

    emitRunEvent("run-async-terminal", "lifecycle", { phase: "end" });
    await Promise.resolve();

    expect(readContext("seen")).toEqual({ runId: "run-async-terminal" });

    terminalHandlerRelease.resolve();
    await waitForPluginEventHandlers();

    expect(terminalHandlerSawContext).toEqual({ runId: "run-async-terminal" });
    expect(readContext("seen")).toBeUndefined();
  });

  it("waits for terminal handlers added after the first terminal cleanup waiter starts", async () => {
    const readContext = contextReader(
      "repeated-terminal-live-wait",
      "run-repeated-terminal-live-wait",
    );
    const secondTerminalHandlerRelease = createDeferredCore();
    const firstTerminalHandlerRelease = createDeferredCore();
    let firstTerminalHandlerSawContext: unknown;
    let secondTerminalHandlerSawContext: unknown;
    let terminalEventsSeen = 0;
    const { registry } = createRegisteredPlugin("repeated-terminal-live-wait", (api) => {
      api.registerAgentEventSubscription({
        id: "records",
        streams: ["tool", "lifecycle"],
        async handle(event, ctx) {
          if (event.stream === "tool") {
            ctx.setRunContext("seen", { runId: event.runId });
            return;
          }
          if (event.data?.phase !== "end") {
            return;
          }
          terminalEventsSeen += 1;
          if (terminalEventsSeen === 1) {
            await firstTerminalHandlerRelease.promise;
            firstTerminalHandlerSawContext = ctx.getRunContext("seen");
            return;
          }
          await secondTerminalHandlerRelease.promise;
          secondTerminalHandlerSawContext = ctx.getRunContext("seen");
        },
      });
    });
    setActivePluginRegistry(registry.registry);

    emitRunEvent("run-repeated-terminal-live-wait", "tool", { name: "tool" });
    await waitForPluginEventHandlers();

    emitRunEvent("run-repeated-terminal-live-wait", "lifecycle", { phase: "end" });
    await waitForPluginEventHandlers();

    emitRunEvent("run-repeated-terminal-live-wait", "lifecycle", { phase: "end" });
    await waitForPluginEventHandlers();

    firstTerminalHandlerRelease.resolve();
    await waitForPluginEventHandlers();
    expect(firstTerminalHandlerSawContext).toEqual({ runId: "run-repeated-terminal-live-wait" });
    expect(readContext("seen")).toEqual({ runId: "run-repeated-terminal-live-wait" });

    secondTerminalHandlerRelease.resolve();
    await waitForPluginEventHandlers();
    await waitForPluginEventHandlers();

    expect(secondTerminalHandlerSawContext).toEqual({ runId: "run-repeated-terminal-live-wait" });
    expect(readContext("seen")).toBeUndefined();
  });

  it("clears run context after the terminal subscription grace period", async () => {
    const readContext = contextReader("slow-terminal-subscription", "run-slow-terminal");
    const terminalHandlerRelease = createDeferredCore();
    vi.useFakeTimers();
    let terminalHandlerSawContext: unknown;
    let terminalHandlerWroteContext: unknown;
    const { registry } = createRegisteredPlugin("slow-terminal-subscription", (api) => {
      api.registerAgentEventSubscription({
        id: "slow",
        streams: ["tool", "lifecycle"],
        async handle(event, ctx) {
          if (event.stream === "tool") {
            ctx.setRunContext("seen", { runId: event.runId });
            return;
          }
          if (event.data?.phase === "end") {
            await terminalHandlerRelease.promise;
            terminalHandlerSawContext = ctx.getRunContext("seen");
            ctx.setRunContext("terminal", { completed: true });
            terminalHandlerWroteContext = ctx.getRunContext("terminal");
          }
        },
      });
    });
    setActivePluginRegistry(registry.registry);

    emitRunEvent("run-slow-terminal", "tool", { name: "tool" });
    await Promise.resolve();

    emitRunEvent("run-slow-terminal", "lifecycle", { phase: "end" });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(PLUGIN_TERMINAL_EVENT_CLEANUP_WAIT_MS);
    expect(readContext("seen")).toBeUndefined();

    terminalHandlerRelease.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(terminalHandlerSawContext).toBeUndefined();
    expect(terminalHandlerWroteContext).toBeUndefined();
    expect(readContext("seen")).toBeUndefined();
    expect(readContext("terminal")).toBeUndefined();
  });

  it("keeps the expired terminal marker across repeated terminal events", async () => {
    const readContext = contextReader("repeated-terminal-subscription", "run-repeat-terminal");
    const firstTerminalHandlerRelease = createDeferredCore();
    vi.useFakeTimers();
    let firstTerminalHandlerWroteContext: unknown;
    let secondTerminalHandlerWroteContext: unknown;
    let terminalEventsSeen = 0;
    const { registry } = createRegisteredPlugin("repeated-terminal-subscription", (api) => {
      api.registerAgentEventSubscription({
        id: "repeat-terminal",
        streams: ["lifecycle"],
        async handle(event, ctx) {
          if (event.data?.phase !== "end") {
            return;
          }
          terminalEventsSeen += 1;
          if (terminalEventsSeen === 1) {
            await firstTerminalHandlerRelease.promise;
            ctx.setRunContext("terminal", { from: "first" });
            firstTerminalHandlerWroteContext = ctx.getRunContext("terminal");
            return;
          }
          ctx.setRunContext("terminal", { from: "second" });
          secondTerminalHandlerWroteContext = ctx.getRunContext("terminal");
        },
      });
    });
    setActivePluginRegistry(registry.registry);

    emitRunEvent("run-repeat-terminal", "lifecycle", { phase: "end" });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(PLUGIN_TERMINAL_EVENT_CLEANUP_WAIT_MS);

    emitRunEvent("run-repeat-terminal", "lifecycle", { phase: "end" });
    await vi.advanceTimersByTimeAsync(0);

    expect(secondTerminalHandlerWroteContext).toBeUndefined();
    expect(readContext("terminal")).toBeUndefined();

    firstTerminalHandlerRelease.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(firstTerminalHandlerWroteContext).toBeUndefined();
    expect(readContext("terminal")).toBeUndefined();
  });

  it("preserves scheduler jobs instead of invoking stale cleanup callbacks", async () => {
    const cleanup = vi.fn();
    registerPluginSessionSchedulerJob({
      pluginId: "scheduler-plugin",
      pluginName: "Scheduler Plugin",
      job: {
        id: "job-preserved",
        sessionKey: "agent:main:main",
        kind: "session-turn",
        cleanup,
      },
    });

    expectNoCleanupFailures(
      await runPluginHostCleanup({
        reason: "disable",
        pluginId: "scheduler-plugin",
        preserveSchedulerJobIds: new Set(["job-preserved"]),
      }),
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(listPluginSessionSchedulerJobs("scheduler-plugin")).toHaveLength(1);
  });

  it("preserves plugin run context during restart cleanup", async () => {
    const readContext = contextReader("restart-context-plugin", "run-restart");
    const registry = createEmptyPluginRegistry();
    expect(
      setPluginRunContext({
        pluginId: "restart-context-plugin",
        patch: { runId: "run-restart", namespace: "state", value: { keep: true } },
      }),
    ).toBe(true);

    expectNoCleanupFailures(
      await runPluginHostCleanup({
        registry,
        pluginId: "restart-context-plugin",
        reason: "restart",
      }),
    );
    expect(readContext("state")).toEqual({ keep: true });

    expectNoCleanupFailures(
      await runPluginHostCleanup({
        registry,
        pluginId: "restart-context-plugin",
        reason: "disable",
      }),
    );
    expect(readContext("state")).toBeUndefined();
  });

  it("preserves durable plugin session state during plugin restart cleanup", async () => {
    const { registry } = createRegisteredPlugin("restart-state-fixture", (api) => {
      api.registerSessionExtension({
        namespace: "workflow",
        description: "restart state test",
      });
    });

    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-run-context-restart-state-",
    });
    const stateDir = openClawState.stateDir;
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = {
      session: { store: storePath },
    };
    try {
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await upsertSessionEntry({
            storePath,
            sessionKey: "agent:main:main",
            entry: {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginExtensions: {
                "restart-state-fixture": { workflow: { state: "waiting" } },
              },
              pluginNextTurnInjections: {
                "restart-state-fixture": [
                  {
                    id: "resume",
                    pluginId: "restart-state-fixture",
                    text: "resume",
                    placement: "prepend_context",
                    createdAt: 1,
                  },
                ],
              },
            },
          });

          expectNoCleanupFailures(
            await runPluginHostCleanup({
              cfg: tempConfig,
              registry: registry.registry,
              pluginId: "restart-state-fixture",
              reason: "restart",
            }),
          );

          const stored = getSessionEntry({ storePath, sessionKey: "agent:main:main" });
          expect(stored?.pluginExtensions).toEqual({
            "restart-state-fixture": { workflow: { state: "waiting" } },
          });
          expect(stored?.pluginNextTurnInjections).toEqual({
            "restart-state-fixture": [
              {
                id: "resume",
                pluginId: "restart-state-fixture",
                text: "resume",
                placement: "prepend_context",
                createdAt: 1,
              },
            ],
          });
        },
      });
    } finally {
      await openClawState.cleanup();
    }
  });

  it("rejects hung cleanup hooks with a bounded timeout", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => {
      await new Promise(() => {});
    });
    registerPluginSessionSchedulerJob({
      pluginId: "hung-cleanup-plugin",
      pluginName: "Hung Cleanup Plugin",
      job: {
        id: "job-hung",
        sessionKey: "agent:main:main",
        kind: "session-turn",
        cleanup,
      },
    });

    const resultPromise = runPluginHostCleanup({
      cfg: {},
      reason: "disable",
      pluginId: "hung-cleanup-plugin",
      sessionStoreTargets: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PLUGIN_HOST_CLEANUP_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.pluginId).toBe("hung-cleanup-plugin");
    expect(result.failures[0]?.hookId).toBe("scheduler:job-hung");
  });

  it("bounds session, runtime, and scheduler cleanup callbacks so cleanup keeps moving", async () => {
    vi.useFakeTimers();
    const { config, registry } = createPluginRegistryFixture();
    const cleanupRelease = createDeferredCore();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "hanging-cleanup-fixture",
        name: "Hanging Cleanup Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "state",
          description: "hangs during cleanup",
          cleanup: () => cleanupRelease.promise,
        });
        api.registerRuntimeLifecycle({
          id: "runtime-cleanup",
          cleanup: () => cleanupRelease.promise,
        });
        api.registerSessionSchedulerJob({
          id: "scheduler-cleanup",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: () => cleanupRelease.promise,
        });
      },
    });

    setActivePluginRegistry(registry.registry);
    expect(listPluginSessionSchedulerJobs("hanging-cleanup-fixture")).toHaveLength(1);
    const cleanupPromise = runPluginHostCleanup({
      cfg: config,
      registry: registry.registry,
      pluginId: "hanging-cleanup-fixture",
      reason: "delete",
      sessionStoreTargets: [],
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        await vi.advanceTimersByTimeAsync(PLUGIN_HOST_CLEANUP_TIMEOUT_MS + 1);
      }
      const result = await cleanupPromise;
      expect(result.failures).toHaveLength(3);
      for (const hookId of [
        "session:state",
        "runtime:runtime-cleanup",
        "scheduler:scheduler-cleanup",
      ]) {
        const failure = requireFailureByHookId(result, hookId);
        expect(failure?.pluginId).toBe("hanging-cleanup-fixture");
      }
    } finally {
      cleanupRelease.resolve();
      await cleanupPromise;
    }
  });

  it("blocks setting run context after a run is closed", () => {
    expect(
      setPluginRunContext({
        pluginId: "closed-run-plugin",
        patch: { runId: "run-closed", namespace: "state", value: { before: true } },
      }),
    ).toBe(true);
    dispatchPluginAgentEventSubscriptions({
      registry: createEmptyPluginRegistry(),
      isLive: () => true,
      event: {
        runId: "run-closed",
        seq: 1,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end" },
      },
    });

    expect(
      setPluginRunContext({
        pluginId: "closed-run-plugin",
        patch: { runId: "run-closed", namespace: "state", value: { after: true } },
      }),
    ).toBe(false);
  });
});
