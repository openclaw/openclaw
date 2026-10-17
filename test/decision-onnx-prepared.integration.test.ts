import fs from "node:fs";
import path from "node:path";
import type { DecisionRuntimeV2 } from "openclaw/plugin-sdk/decisions";
import { afterEach, expect, it, vi } from "vitest";
import {
  createPreparedOnnxProvider,
  onnxManifest as manifest,
} from "../extensions/onnx/test-api.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../src/agents/prepared-model-runtime.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { loadAndActivateRootPluginRegistry } from "../src/plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../src/plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../src/plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../src/plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.onnx-prepared-decisions");

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, traceKey);
});

it("runs registered ONNX decisions through the prepared catalog and local auth without an API key", async () => {
  const root = roots.make("onnx-prepared-integration-");
  const pluginRoot = path.join(root, "plugin");
  const emptyBundled = path.join(root, "bundled");
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(emptyBundled);
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
    [
      'const trace = globalThis[Symbol.for("openclaw.test.onnx-prepared-decisions")];',
      'module.exports = { id: "onnx", register(api) {',
      "api.registerDecisionProvider(trace.provider);",
      "trace.runtime = api.runtime.decisions;",
      "} };",
    ].join("\n"),
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
  const env = {
    ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
  };
  await withEnvAsync(env, async () => {
    setRuntimeConfigSnapshot(cfg);
    const registry = await loadAndActivateRootPluginRegistry({
      config: cfg,
      env,
      workspaceDir: path.join(root, "workspace"),
    });
    expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
    expect(registry.providers.map((entry) => entry.provider.id)).toContain("onnx");
    const runtime = trace.runtime;
    if (!runtime) {
      throw new Error("ONNX registration omitted the decision SDK");
    }
    const options = () => ({
      agentId: "specialist",
      purpose: "onnx-integration",
      rubricVersion: "1",
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    const questions = {
      needed: {
        type: "boolean" as const,
        criteria: { true: "Work is needed", false: "No work is needed" },
      },
    };
    const expected = {
      status: "ok",
      result: {
        model: "gliclass-edge-v3.0",
        answers: { needed: { type: "boolean", probabilityTrue: 0.8 } },
        usage: { inputTokens: 7 },
      },
    };
    expect(
      await runtime.evaluateV2(
        { state: { type: "text", text: "The work is needed" }, questions },
        { ...options(), reasoning: "auto" },
      ),
    ).toMatchObject(expected);
    expect(
      await runtime.evaluate({ state: "The work is needed", questions }, options()),
    ).toMatchObject(expected);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[0]?.[0]).toBe("gliclass-edge-v3.0");
    expect(classify.mock.calls[0]?.[3]).toBeTypeOf("function");
    expect(
      await runtime.evaluateV2(
        { state: { type: "text", text: "The work is needed" }, questions },
        { ...options(), reasoning: "on" },
      ),
    ).toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(classify).toHaveBeenCalledTimes(2);
  });
});
