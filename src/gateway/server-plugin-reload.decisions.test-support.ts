import { expect } from "vitest";
import { evaluateDecisionInRegistry } from "../decisions/runtime.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { createPluginReloadRecoveryFixture } from "./server-plugin-reload.recovery.test-support.js";

export async function verifyDecisionSelectionIsolation(
  createRecoveryFixture: (
    options: Parameters<typeof createPluginReloadRecoveryFixture>[1],
  ) => ReturnType<typeof createPluginReloadRecoveryFixture>,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let callbackSignal: AbortSignal | undefined;
  const fixture = await createRecoveryFixture({
    config: {
      agents: {
        defaults: { decisionModel: "selector-probe/default" },
        entries: { watcher: { decisionModel: "selector-probe/watcher" } },
      },
    },
    abortOnCandidateStart: false,
    register(api, owner, record) {
      if (owner !== "first") {
        return;
      }
      record.contracts = { decisionProviders: ["selector-probe"] };
      api.registerDecisionProvider({
        id: "selector-probe",
        contractVersion: 1,
        async evaluate(_batch, { signal, model }) {
          callbackSignal = signal;
          entered.resolve();
          await release.promise;
          signal.throwIfAborted();
          return {
            status: "ok",
            result: {
              model,
              answers: { check: { type: "boolean", probabilityTrue: 1 } },
            },
          };
        },
      });
    },
  });
  const previous = fixture.previousRegistry.plugins.find((record) => record.id === "first")!;
  const pending = evaluateDecisionInRegistry(
    { state: {}, questions: { check: { type: "boolean", instructions: "Synthetic probe" } } },
    {
      purpose: "test.selector",
      agentId: "watcher",
      rubricVersion: "fixture-v1",
      timeoutMs: 5000,
      signal: new AbortController().signal,
    },
    fixture.previousRegistry,
    fixture.getConfig(),
  );
  await entered.promise;
  fixture.runtime.runtimeState.gatewayLifetimeSidecars.publish({
    stop: async () => {},
    preparePluginReload: () => {
      expect(callbackSignal?.aborted).toBe(false);
      return {
        drain: async () => {},
        resume() {},
      };
    },
  });
  const next = structuredClone(fixture.getConfig());
  next.agents!.defaults!.decisionModel = "";
  try {
    await fixture.reload(next, [], ["agents.defaults.decisionModel"]);
    expect(callbackSignal?.aborted).toBe(false);
    expect(fixture.registryOwner.registry.plugins.find((record) => record.id === "first")).toBe(
      previous,
    );
  } finally {
    release.resolve();
  }
  expect(await pending).toMatchObject({ status: "ok", result: { model: "watcher" } });
  expect(getPluginInstance(previous)?.run(() => "current")).toBe("current");
  expect(fixture.firstStop).not.toHaveBeenCalled();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}

export async function verifyDecisionEarlyReloadRecovery(
  createRecoveryFixture: (
    options: Parameters<typeof createPluginReloadRecoveryFixture>[1],
  ) => ReturnType<typeof createPluginReloadRecoveryFixture>,
  boundary: "prepare" | "drain" | "discovery",
) {
  const entered = createDeferredCore();
  let callbackSignal: AbortSignal | undefined;
  let settled = false;
  const failure = new Error(`synthetic ${boundary} failure`);
  const fixture = await createRecoveryFixture({
    config: { agents: { defaults: { decisionModel: "recovery-probe/synthetic" } } },
    abortOnCandidateStart: false,
    register(api, owner, record) {
      if (owner !== "first") {
        return;
      }
      record.contracts = { decisionProviders: ["recovery-probe"] };
      api.registerDecisionProvider({
        id: "recovery-probe",
        contractVersion: 1,
        async evaluate(batch, { signal }) {
          if (batch.state === "hang") {
            callbackSignal = signal;
            entered.resolve();
            try {
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
              signal.throwIfAborted();
            } finally {
              settled = true;
            }
          }
          return {
            status: "ok",
            result: {
              model: "synthetic",
              answers: { check: { type: "boolean", probabilityTrue: 1 } },
            },
          };
        },
      });
    },
  });
  const run = (state: string) =>
    evaluateDecisionInRegistry(
      { state, questions: { check: { type: "boolean" } } },
      {
        purpose: "test.recovery",
        rubricVersion: "fixture-v1",
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      fixture.registryOwner.registry,
      fixture.getConfig(),
    );
  const initial = await run("ready");
  const pending = run("hang");
  await entered.promise;
  let failed = false;
  const failOnce = () => {
    expect(callbackSignal?.aborted).toBe(true);
    if (!failed) {
      failed = true;
      throw failure;
    }
  };
  fixture.runtime.runtimeState.gatewayLifetimeSidecars.publish({
    stop: async () => {},
    preparePluginReload: () => {
      if (boundary === "prepare") {
        failOnce();
      }
      return {
        drain: async () => {
          if (boundary === "drain") {
            failOnce();
          }
        },
        resume() {},
      };
    },
  });
  if (boundary === "discovery") {
    fixture.runtime.runtimeState.discovery = {
      stop: async () => {},
      update: async () => {
        failOnce();
      },
    };
  }
  await expect(fixture.reload()).rejects.toThrow(`synthetic ${boundary} failure`);
  expect(await pending).toMatchObject({ status: "unavailable", reason: "retiring" });
  expect(settled).toBe(true);
  const recovered = await run("ready");
  expect(recovered).toMatchObject({ status: "ok" });
  if (initial.status === "ok" && recovered.status === "ok") {
    expect(recovered.provenance.runtimeGeneration).not.toBe(initial.provenance.runtimeGeneration);
  }
  expect(
    fixture.registryOwner.registry.decisionProviders[0]!.host.inspect(fixture.getConfig()),
  ).toMatchObject({ callable: true, activeRequests: 0 });
  expect(fixture.firstStop).not.toHaveBeenCalled();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}
