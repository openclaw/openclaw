// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "../agents/prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { assertPreparedModelRuntimeAdmissionCanWait } from "../agents/prepared-model-runtime-admission.js";
import {
  acquireAgentRunPreparedModelRuntime,
  beginPreparedModelRuntimePluginDrain,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { pluginInvocationContext } from "../plugins/plugin-instance-scope.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

const startTurn = vi.hoisted(() => vi.fn());
// mock-isolation: Avoid real turn admission and session writes while testing dispatch ownership.
vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn }),
}));

const fixture = usePreparedModelRuntimeHarness({ label: "dispatch-self-hold" });

it.each(["call", "consumer"] as const)(
  "refuses child admission when a reload waits on the caller's %s",
  async (kind) => {
    fixture.mocks.authStorage.getAll.mockReturnValue({});
    fixture.mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const input = fixture.agentInput("default", {});
    const instance = new PluginInstance("reload-owner");
    const scope = new PluginInvocationScope(createTestPluginRegistry().registry, [instance], {
      retained: true,
    });
    const abort = new AbortController();
    let admissionError: unknown;
    const entered = createDeferred();
    const proceed = createDeferred();
    const context = createContext();
    startTurn.mockImplementation(async ({ io }) => {
      entered.resolve();
      await proceed.promise;
      const pending = acquireAgentRunPreparedModelRuntime(input, { abortSignal: abort.signal });
      const timeout = setTimeout(
        () => abort.abort(new Error("admission waited on its own reload")),
        2000,
      );
      try {
        await using lease = await pending;
        expect(lease.snapshot).toBeDefined();
      } catch (error) {
        admissionError = error;
      } finally {
        clearTimeout(timeout);
      }
      io.emitAcceptance([true, { runId: "hold-probe", status: "accepted" }, undefined]);
    });
    const run = () =>
      dispatchGatewayMethodInProcess(
        "agent",
        { message: "probe", idempotencyKey: "hold-probe" },
        { forceSyntheticClient: true, resolveGatewayContext: () => context },
      );
    const pending = kind === "call" ? instance.run(run) : scope.run(run);
    await entered.promise;
    const releaseReplacement = instance.reserveReplacement();
    const drain = beginPreparedModelRuntimePluginDrain();
    try {
      proceed.resolve();
      await pending;
      expect(admissionError).toMatchObject({ admissionBlocked: true });
    } finally {
      proceed.resolve();
      abort.abort();
      drain.release();
      releaseReplacement();
      scope.release();
      await instance.dispose();
    }
  },
);

it("does not retain caller hold facts or callable scope after child acceptance", async () => {
  const instance = new PluginInstance("accepted-child");
  const scope = new PluginInvocationScope(createTestPluginRegistry().registry, [instance], {
    retained: true,
  });
  const proceed = createDeferred();
  const context = createContext();
  let child: Promise<void> | undefined;
  startTurn.mockImplementation(async ({ io }) => {
    child = (async () => {
      await proceed.promise;
      expect(pluginInvocationContext.getStore()).toBeUndefined();
      expect(() => assertPreparedModelRuntimeAdmissionCanWait()).not.toThrow();
    })();
    io.emitAcceptance([true, { runId: "accepted-child", status: "accepted" }, undefined]);
  });
  try {
    await scope.run(() =>
      dispatchGatewayMethodInProcess(
        "agent",
        { message: "probe", idempotencyKey: "accepted-child" },
        { forceSyntheticClient: true, resolveGatewayContext: () => context },
      ),
    );
    const release = instance.reserveReplacement();
    try {
      expect(child).toBeDefined();
      proceed.resolve();
      await child;
    } finally {
      release();
    }
  } finally {
    proceed.resolve();
    scope.release();
    await instance.dispose();
  }
});
