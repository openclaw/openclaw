import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveAgentExecutorController } from "./agent-executor-controller.js";
import type {
  AgentExecutorBinding,
  AgentExecutorContext,
  AgentExecutorController,
} from "./agent-executor-controller.types.js";
import { createCapturedPluginRegistration } from "./captured-registration.js";
import { createPluginRecord } from "./loader-records.js";
import { projectPluginContributions } from "./registry-contributions.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "./registry-lifecycle.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";

describe("plugin executor controllers", () => {
  it("preserves class controller methods and their native receiver", async () => {
    class ClassController implements AgentExecutorController {
      workspaceDirectory = "/executor/workspace";
      #calls: string[] = [];
      async ensure() {
        this.#calls.push("ensure");
      }
      async retire() {
        this.#calls.push("retire");
      }
      calls() {
        return this.#calls;
      }
    }
    const implementation = new ClassController();
    const owner = fixture(implementation);
    await owner.run(async () => {
      const selected = resolveAgentExecutorController("remote-executor");
      await selected.ensure(binding, context());
      await selected.retire(binding, context());
    });
    expect(implementation.calls()).toEqual(["ensure", "retire"]);
  });

  it("selects the exact plugin in each invocation registry and captures contributions", async () => {
    const first = fixture();
    const second = fixture();
    await first.run(async () => {
      const selected = resolveAgentExecutorController("remote-executor");
      expect(selected.workspaceDirectory).toBe("/executor/workspace");
      await selected.ensure(binding, context());
    });
    await second.run(() =>
      resolveAgentExecutorController("remote-executor").retire(binding, context()),
    );
    expect(first.controller.ensure).toHaveBeenCalledOnce();
    expect(second.controller.retire).toHaveBeenCalledOnce();
    expect(first.registry.agentExecutorControllers.get("remote-executor")?.pluginId).toBe(
      "remote-executor",
    );

    const captured = createCapturedPluginRegistration({ id: "remote-executor" });
    captured.api.registerAgentExecutorController(first.controller);
    expect(captured.agentExecutorControllers).toEqual([first.controller]);
  });

  it("requires an invocation registry and an enabled registered owner", () => {
    const owner = fixture();
    expect(() => resolveAgentExecutorController("remote-executor")).toThrow(
      "requires a scoped plugin registry",
    );
    owner.run(() => {
      expect(() => resolveAgentExecutorController("missing")).toThrow(
        'plugin "missing" is missing, disabled, or unavailable',
      );
      owner.record.enabled = false;
      expect(() => resolveAgentExecutorController("remote-executor")).toThrow(
        "missing, disabled, or unavailable",
      );
    });
  });

  it("rejects duplicate registrations without replacing the original controller", () => {
    const owner = fixture();
    const original = owner.registry.agentExecutorControllers.get("remote-executor");
    owner.api.registerAgentExecutorController(controller());
    expect(owner.registry.agentExecutorControllers.get("remote-executor")).toBe(original);
    expect(owner.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "agent executor controller already registered: remote-executor",
      }),
    );
  });

  it.each([
    { workspaceDirectory: "relative", error: "absolute workspaceDirectory" },
    { ensure: undefined, error: "requires ensure and retire methods" },
    { retire: undefined, error: "requires ensure and retire methods" },
  ])("rejects invalid controller contracts: $error", ({ error, ...invalid }) => {
    const owner = fixture({ ...controller(), ...invalid } as AgentExecutorController);
    expect(owner.registry.diagnostics[0]?.message).toContain(error);
    owner.run(() =>
      expect(() => resolveAgentExecutorController("remote-executor")).toThrow("unavailable"),
    );
  });

  it("preserves contributions during projection and removes them on rollback", () => {
    const owner = fixture();
    const next = createEmptyPluginRegistry();
    projectPluginContributions(owner.registry, owner.record, next);
    expect(next.agentExecutorControllers.get("remote-executor")).toBe(
      owner.registry.agentExecutorControllers.get("remote-executor"),
    );
    owner.builder.rollbackPluginGlobalSideEffects(owner.record.id, owner.record);
    expect(owner.registry.agentExecutorControllers.size).toBe(0);
  });

  it("rejects a retained handle in another invocation registry", async () => {
    const first = fixture();
    const second = fixture();
    const selected = first.run(() => resolveAgentExecutorController("remote-executor"));
    await second.run(() =>
      expect(selected.ensure(binding, context())).rejects.toThrow("no longer available"),
    );
  });

  it.each(["retirement", "reactivation", "owner revocation", "registration replacement"])(
    "invalidates retained methods after %s",
    async (change) => {
      const owner = fixture();
      markPluginRegistryActive(owner.registry);
      await owner.run(async () => {
        const selected = resolveAgentExecutorController("remote-executor");
        if (change === "owner revocation") {
          revokePluginRecord(owner.registry, owner.record);
        } else if (change === "registration replacement") {
          owner.registry.agentExecutorControllers.set("remote-executor", {
            pluginId: owner.record.id,
            source: owner.record.source,
            controller: controller(),
          });
        } else {
          markPluginRegistryRetired(owner.registry);
          if (change === "reactivation") {
            markPluginRegistryActive(owner.registry);
          }
        }
        await expect(selected.retire(binding, context())).rejects.toThrow("no longer available");
      });
    },
  );

  it("invalidates an old handle when its instance is adopted into a replacement registry", async () => {
    const owner = fixture();
    markPluginRegistryActive(owner.registry);
    const selected = owner.run(() => resolveAgentExecutorController("remote-executor"));
    const next = createEmptyPluginRegistry();
    next.plugins.push(owner.record);
    projectPluginContributions(owner.registry, owner.record, next);
    markPluginRegistryActive(next);
    markPluginRegistryRetired(owner.registry);
    await owner.run(() =>
      expect(selected.ensure(binding, context())).rejects.toThrow("no longer available"),
    );
    await withPluginRuntimeRegistryScope(next, () =>
      resolveAgentExecutorController("remote-executor").ensure(binding, context()),
    );
    expect(owner.controller.ensure).toHaveBeenCalledOnce();
  });

  it("preserves the caller assertion scope while the controller has its own identity", async () => {
    let retained: AgentExecutorContext | undefined;
    const seen: string[] = [];
    const owner = fixture(
      controller({
        ensure: async (_binding, ctx) => {
          expect(getPluginRuntimeGatewayRequestScope()?.pluginId).toBe("remote-executor");
          await Promise.resolve();
          ctx.assertCurrent();
          retained = ctx;
        },
      }),
    );
    await withPluginRuntimePluginScope(
      { pluginId: "caller-harness" },
      () => {
        const selected = resolveAgentExecutorController("remote-executor");
        return selected.ensure(binding, {
          signal: new AbortController().signal,
          assertCurrent: () =>
            seen.push(getPluginRuntimeGatewayRequestScope()?.pluginId ?? "missing"),
        });
      },
      owner.registry,
    );
    expect(seen).toEqual(["caller-harness", "caller-harness", "caller-harness"]);
    expect(() => retained?.assertCurrent()).toThrow("operation has completed");
  });

  it.each(["caller cancellation", "registry retirement"])(
    "fences awaited work on %s",
    async (change) => {
      const started = createDeferredCore();
      const release = createDeferredCore();
      const abort = new AbortController();
      let received: AgentExecutorContext | undefined;
      const owner = fixture(
        controller({
          ensure: async (_binding, ctx) => {
            received = ctx;
            started.resolve();
            await release.promise;
          },
        }),
      );
      const pending = owner.run(() =>
        resolveAgentExecutorController("remote-executor").ensure(binding, {
          signal: abort.signal,
          assertCurrent() {},
        }),
      );
      const rejected = expect(pending).rejects.toThrow();
      await started.promise;
      if (change === "caller cancellation") {
        abort.abort(new Error("caller cancelled"));
      } else {
        markPluginRegistryRetired(owner.registry);
      }
      expect(received?.signal.aborted).toBe(true);
      expect(() => received?.assertCurrent()).toThrow();
      release.resolve();
      await rejected;
    },
  );
});

const binding: AgentExecutorBinding = {
  sessionKey: "agent:main:example",
  agentId: "main",
  nativeSessionId: "native-session",
  environmentId: "native-environment",
  remoteUrl: "wss://executor.example.invalid",
  workspaceDirectory: "/executor/workspace",
};

function context(): AgentExecutorContext {
  return { signal: new AbortController().signal, assertCurrent() {} };
}

function controller(overrides: Partial<AgentExecutorController> = {}): AgentExecutorController {
  return {
    workspaceDirectory: "/executor/workspace",
    ensure: vi.fn(async () => {}),
    retire: vi.fn(async () => {}),
    ...overrides,
  };
}

function fixture(implementation = controller()) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "remote-executor",
    source: "/plugins/remote-executor/index.js",
    origin: "config",
    enabled: true,
    configSchema: false,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  api.registerAgentExecutorController(implementation);
  return {
    builder,
    registry: builder.registry,
    record,
    api,
    controller: implementation,
    run: <T>(run: () => T) => withPluginRuntimeRegistryScope(builder.registry, run),
  };
}
