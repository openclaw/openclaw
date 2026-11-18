// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { EmbeddedPreparedModelRuntimeHost } from "./embedded-prepared-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("EmbeddedPreparedModelRuntimeHost", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    await resetPreparedModelRuntimeHarness(state);
  });

  it.each(["initial", "replacement"])(
    "observes a failed %s publication before readiness consumers arrive",
    async (phase) => {
      const host = new EmbeddedPreparedModelRuntimeHost();
      if (phase === "replacement") {
        host.publish({});
        await host.waitUntilReady();
      }
      const failure = new Error("configured owner discovery failed");
      mocks.configuredAgentIdsError = failure;
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        host.publish({});
        // Cross Node's rejection checkpoint without attaching a readiness consumer.
        await setImmediate();
        expect(unhandled).toEqual([]);
      } finally {
        // Observation must not turn failed readiness into successful admission.
        try {
          await expect(host.waitUntilReady()).rejects.toBe(failure);
        } finally {
          process.off("unhandledRejection", onUnhandled);
        }
      }
    },
  );

  it("reuses its live publication across two actual run admissions", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } };
    const host = new EmbeddedPreparedModelRuntimeHost();
    host.publish(config);
    await host.waitUntilReady();

    const input = {
      agentId: "default",
      config,
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      workspaceDir: "/tmp/unused-workspace",
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.5", agentId: "default" }],
    };
    const first = await acquireAgentRunPreparedModelRuntime(input);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);
    await first[Symbol.asyncDispose]();
    const second = await acquireAgentRunPreparedModelRuntime(input);
    await second[Symbol.asyncDispose]();

    expect(second.snapshot).toBe(first.snapshot);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);
  });
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
