import fs from "node:fs";
import path from "node:path";
import type { DecisionRuntimeV2 } from "openclaw/plugin-sdk/decisions";
import { afterEach, expect, it, vi } from "vitest";
import {
  createPreparedOnnxProvider,
  onnxManifest as manifest,
} from "../extensions/onnx/test-api.js";
import * as harness from "../src/agents/decision-inference.test-support.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createColdPluginFixture } from "../src/plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.onnx-prepared-decisions");

afterEach(() => harness.resetDecisionTestRuntime(traceKey));

it("runs registered ONNX decisions through the prepared catalog and local auth without an API key", async () => {
  const root = roots.make("onnx-prepared-integration-");
  const pluginRoot = path.join(root, "plugin");
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(path.join(root, "bundled"));
  const classify = vi
    .fn<Parameters<typeof createPreparedOnnxProvider>[0]["classify"]>()
    .mockResolvedValue([{ logits: [Math.log(4), 0], inputTokens: 7 }]);
  const trace: {
    provider: ReturnType<typeof createPreparedOnnxProvider>;
    runtime?: DecisionRuntimeV2;
  } = { provider: createPreparedOnnxProvider({ classify }, vi.fn()) };
  Reflect.set(globalThis, traceKey, trace);
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: "onnx",
    providerId: "onnx",
    manifest: { ...manifest, channels: [], channelConfigs: {}, providerAuthChoices: [] },
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `const trace = globalThis[Symbol.for("openclaw.test.onnx-prepared-decisions")];
module.exports = { id: "onnx", register(api) {
api.registerDecisionProvider(trace.provider);
trace.runtime = api.runtime.decisions;
} };`,
  );
  const cfg: OpenClawConfig = {
    agents: {
      defaults: { model: "unrelated/not-configured", workspace: path.join(root, "workspace") },
      entries: { specialist: { decisionModel: "onnx/gliclass-edge-v3.0" } },
    },
    plugins: {
      load: { paths: [pluginRoot] },
      slots: { memory: "none" },
      entries: { onnx: { enabled: true } },
    },
  };
  const env = harness.decisionEnv(root);
  await withEnvAsync(env, async () => {
    await harness.activateDecisionRegistry(cfg, { env });
    const runtime = trace.runtime;
    if (!runtime) {
      throw new Error("ONNX registration omitted the decision SDK");
    }
    const options = () =>
      harness.decisionOptions({
        agentId: "specialist",
        purpose: "onnx-integration",
        rubricVersion: "1",
      });
    const questions = {
      needed: {
        type: "boolean" as const,
        criteria: { true: "Work is needed", false: "No work is needed" },
      },
    };
    const batch = { state: { type: "text" as const, text: "The work is needed" }, questions };
    const expected = {
      status: "ok",
      result: {
        model: "gliclass-edge-v3.0",
        answers: { needed: { type: "boolean", probabilityTrue: 0.8 } },
        usage: { inputTokens: 7 },
      },
    };
    const v2Result = await runtime.evaluateV2(batch, { ...options(), reasoning: "auto" });
    expect(v2Result, JSON.stringify(v2Result)).toMatchObject(expected);
    const v1Result = await runtime.evaluate({ state: "The work is needed", questions }, options());
    expect(v1Result, JSON.stringify(v1Result)).toMatchObject(expected);
  });
});
