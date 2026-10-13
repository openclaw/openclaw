// Plugin agent event contracts cover attribution and registry lifecycle authority.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRegistry } from "../registry.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "../runtime.js";
import { createPluginRecord } from "../status.test-fixtures.js";
import type { OpenClawPluginApi } from "../types.js";

function requireObservedEvent(
  observed: unknown[],
  index: number,
): { runId?: unknown; sessionKey?: unknown; stream?: unknown; data?: Record<string, unknown> } {
  const event = observed[index] as
    | { runId?: unknown; sessionKey?: unknown; stream?: unknown; data?: Record<string, unknown> }
    | undefined;
  if (!event) {
    throw new Error(`expected observed event #${index + 1}`);
  }
  return event;
}

describe("plugin agent events", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetAgentEventsForTest();
  });

  it("emits plugin-attributed agent events through the plugin API", () => {
    const observed: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => observed.push(event));
    const { config, registry } = createPluginRegistryFixture();
    let bundledApi: OpenClawPluginApi | undefined;
    let workspaceApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "event-plugin",
        name: "Event Plugin",
        origin: "bundled",
      }),
      register(api) {
        bundledApi = api;
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "workspace-event-plugin",
        name: "Workspace Event Plugin",
        origin: "workspace",
      }),
      register(api) {
        workspaceApi = api;
      },
    });
    setActivePluginRegistry(registry.registry);

    try {
      expect(
        bundledApi?.agent?.events.emitAgentEvent({
          runId: "run-emit",
          sessionKey: " agent:main:main ",
          stream: "approval",
          data: { state: "queued" },
        }),
      ).toEqual({ emitted: true, stream: "approval" });
      expect(
        bundledApi?.agent?.events.emitAgentEvent({
          runId: "run-emit",
          stream: "lifecycle",
          data: { phase: "start" },
        }),
      ).toEqual({
        emitted: false,
        reason: "lifecycle start requires a finite startedAt timestamp",
      });
      expect(
        bundledApi?.agent?.events.emitAgentEvent({
          runId: "run-emit",
          stream: "lifecycle",
          data: { phase: "start", startedAt: 1_234 },
        }),
      ).toEqual({ emitted: true, stream: "lifecycle" });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "lifecycle",
          data: { phase: "end" },
        }),
      ).toEqual({ emitted: false, reason: "stream lifecycle is reserved for bundled plugins" });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "assistant",
          data: { text: "spoofed assistant output" },
        }),
      ).toEqual({ emitted: false, reason: "stream assistant is reserved for bundled plugins" });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "other-plugin.workflow",
          data: { state: "queued" },
        }),
      ).toEqual({
        emitted: false,
        reason: "stream other-plugin.workflow must be scoped to plugin workspace-event-plugin",
      });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "workspace-event-plugin.workflow",
          data: { state: "queued" },
        }),
      ).toEqual({ emitted: true, stream: "workspace-event-plugin.workflow" });
      expect(
        bundledApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "approval",
          data: 1n as never,
        }),
      ).toEqual({ emitted: false, reason: "event data must be JSON-compatible" });
    } finally {
      unsubscribe();
    }

    expect(observed).toHaveLength(3);
    const bundledEvent = requireObservedEvent(observed, 0);
    expect(bundledEvent.runId).toBe("run-emit");
    expect(bundledEvent.sessionKey).toBe("agent:main:main");
    expect(bundledEvent.stream).toBe("approval");
    expect(bundledEvent.data).toEqual({
      state: "queued",
      pluginId: "event-plugin",
      pluginName: "Event Plugin",
    });
    const lifecycleEvent = requireObservedEvent(observed, 1);
    expect(lifecycleEvent.stream).toBe("lifecycle");
    expect(lifecycleEvent.data).toEqual({
      phase: "start",
      startedAt: 1_234,
      pluginId: "event-plugin",
      pluginName: "Event Plugin",
    });
    const workspaceEvent = requireObservedEvent(observed, 2);
    expect(workspaceEvent.runId).toBe("run-emit");
    expect(workspaceEvent.sessionKey).toBeUndefined();
    expect(workspaceEvent.stream).toBe("workspace-event-plugin.workflow");
    expect(workspaceEvent.data).toEqual({
      state: "queued",
      pluginId: "workspace-event-plugin",
      pluginName: "Workspace Event Plugin",
    });
  });

  it("blocks agent events from stale and non-activating plugin API closures", () => {
    const observed: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => observed.push(event));
    const { config, registry } = createPluginRegistryFixture();
    let capturedApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "stale-event-plugin",
        name: "Stale Event Plugin",
        origin: "bundled",
      }),
      register(api) {
        capturedApi = api;
      },
    });
    setActivePluginRegistry(registry.registry);
    setActivePluginRegistry(createEmptyPluginRegistry());

    try {
      expect(
        capturedApi?.emitAgentEvent({
          runId: "stale-run",
          stream: "approval",
          data: { stale: true },
        }),
      ).toEqual({ emitted: false, reason: "plugin is not loaded" });

      const neverActiveRegistry = createPluginRegistry({
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {},
        },
        runtime: {} as never,
      });
      let neverActiveApi: OpenClawPluginApi | undefined;
      registerTestPlugin({
        registry: neverActiveRegistry,
        config,
        record: createPluginRecord({
          id: "never-active-event-plugin",
          name: "Never Active Event Plugin",
          origin: "bundled",
        }),
        register(api) {
          neverActiveApi = api;
        },
      });
      expect(
        neverActiveApi?.emitAgentEvent({
          runId: "never-active-run",
          stream: "approval",
          data: { inactive: true },
        }),
      ).toEqual({ emitted: false, reason: "plugin is not loaded" });

      const inactiveRegistry = createPluginRegistry({
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {},
        },
        runtime: {} as never,
        activateGlobalSideEffects: false,
      });
      let inactiveApi: OpenClawPluginApi | undefined;
      registerTestPlugin({
        registry: inactiveRegistry,
        config,
        record: createPluginRecord({
          id: "inactive-event-plugin",
          name: "Inactive Event Plugin",
          origin: "bundled",
        }),
        register(api) {
          inactiveApi = api;
        },
      });
      expect(
        inactiveApi?.emitAgentEvent({
          runId: "inactive-run",
          stream: "approval",
          data: { inactive: true },
        }),
      ).toEqual({ emitted: false, reason: "global side effects disabled" });
    } finally {
      unsubscribe();
    }

    expect(observed).toEqual([]);
  });

  it("keeps agent event delivery after a staged registry rollback", () => {
    const observed: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => observed.push(event));
    const { config, registry } = createPluginRegistryFixture();
    let capturedApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "reactivated-event-plugin",
        name: "Reactivated Event Plugin",
        origin: "bundled",
      }),
      register(api) {
        capturedApi = api;
      },
    });

    setActivePluginRegistry(registry.registry);
    const snapshot = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");
    rollbackStagedPluginRegistry(snapshot);

    try {
      expect(
        capturedApi?.emitAgentEvent({
          runId: "reactivated-run",
          stream: "approval",
          data: { active: true },
        }),
      ).toEqual({ emitted: true, stream: "approval" });
    } finally {
      unsubscribe();
    }

    expect(observed).toHaveLength(1);
    const reactivatedEvent = requireObservedEvent(observed, 0);
    expect(reactivatedEvent.runId).toBe("reactivated-run");
    expect(reactivatedEvent.sessionKey).toBeUndefined();
    expect(reactivatedEvent.stream).toBe("approval");
    expect(reactivatedEvent.data).toEqual({
      active: true,
      pluginId: "reactivated-event-plugin",
      pluginName: "Reactivated Event Plugin",
    });
  });
});
