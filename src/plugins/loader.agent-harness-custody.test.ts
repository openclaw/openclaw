import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarnessAttemptParams } from "../agents/harness/types.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { PluginInstanceDrainTimeoutError } from "./plugin-instance-error.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

it("retains a running harness package through unrelated reload and fenced retirement", async () => {
  useNoBundledPlugins();
  const workspaceDir = makePluginLoaderTempDir();
  const event = `harness-custody:${workspaceDir}`;
  const entered = createDeferredCore<string>();
  const read = createDeferredCore<string>();
  const onEntered = (directory: string) => entered.resolve(directory);
  const onRead = (version: string) => read.resolve(version);
  process.once(`${event}:entered`, onEntered);
  process.once(`${event}:read`, onRead);
  const plugin = writePlugin({
    id: "custody-harness",
    registration: `const fs = require("node:fs");
    const path = require("node:path");
    api.registerAgentHarness({
      id: "custody-harness", label: "Custody fixture", supports: () => ({ supported: true }),
      async runAttempt(params) {
        if (params.prompt === "wait") {
          const resume = new Promise(resolve => process.once(${JSON.stringify(`${event}:resume`)}, resolve));
          process.emit(${JSON.stringify(`${event}:entered`)}, __dirname);
          await resume;
        }
        const version = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
        process.emit(${JSON.stringify(`${event}:read`)}, version);
        return {
          terminal: { kind: "ok" }, sessionIdUsed: params.sessionId,
          messagesSnapshot: [], assistantTexts: [version], toolMetas: [], lastAssistant: undefined,
          didSendViaMessagingTool: false, messagingToolSentTexts: [], messagingToolSentMediaUrls: [],
          messagingToolSentTargets: [], cloudCodeAssistFormatError: false,
          replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
          itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 }
        };
      }
    });`,
  });
  const packageFile = path.join(plugin.dir, "package.json");
  const writeVersion = (version: string) =>
    fs.writeFileSync(packageFile, JSON.stringify({ name: "custody-harness", version }));
  writeVersion("1.0.0");
  const unrelated = writePlugin({ id: "unrelated", registration: "" });
  const options = {
    config: {
      plugins: {
        allow: [plugin.id, unrelated.id],
        load: { paths: [plugin.file, unrelated.file] },
        slots: { memory: "none" },
      },
    },
    activate: true,
    cache: false,
    throwOnLoadError: true,
  };
  const authStorage = AuthStorage.inMemory();
  const params: AgentHarnessAttemptParams = {
    prompt: "wait",
    sessionId: "custody-session",
    sessionKey: "agent:main:cron:custody",
    sessionFile: path.join(workspaceDir, "session.jsonl"),
    workspaceDir,
    runId: "custody-run",
    trigger: "cron",
    timeoutMs: 5_000,
    provider: "fixture",
    modelId: "fixture",
    model: {
      id: "fixture",
      name: "Fixture",
      provider: "fixture",
      api: "openai-responses",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 128,
    },
    authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: ModelRegistry.inMemory(authStorage),
    thinkLevel: "off",
  };
  const registries: PluginRegistry[] = [];
  const resolve = (registry: PluginRegistry) =>
    withPluginRuntimeRegistryScope(registry, () => getRegisteredAgentHarness("custody-harness"));
  let running: Promise<unknown> | undefined;
  let settlement: Promise<void> | undefined;
  try {
    const first = loadOpenClawPlugins(options);
    registries.push(first);
    const original = expectDefined(resolve(first), "registered fixture harness").harness;
    running = original.runAttempt(params);
    void running.catch(() => {});
    const directory = await entered.promise;
    expect(directory).not.toBe(plugin.dir);
    const capturedPackage = path.join(directory, "package.json");

    const reloaded = loadOpenClawPlugins({
      ...options,
      previousRegistry: first,
      replacePluginIds: [unrelated.id],
    });
    registries.push(reloaded);
    await disposePluginRegistryInstances(first, reloaded);
    expect(resolve(reloaded)?.harness).toBe(original);
    expect(fs.existsSync(capturedPackage)).toBe(true);

    const record = expectDefined(
      reloaded.plugins.find(({ id }) => id === plugin.id),
      "retained harness record",
    );
    const instance = expectDefined(getPluginInstance(record), "retained harness instance");
    const disposeModule = vi.fn();
    instance.onModuleDispose(disposeModule);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const retirement = instance.dispose();
    await vi.advanceTimersByTimeAsync(5_001);
    const timeout = (await retirement).errors[0];
    expect(timeout).toBeInstanceOf(PluginInstanceDrainTimeoutError);
    if (!(timeout instanceof PluginInstanceDrainTimeoutError)) {
      throw new Error("Expected running harness to exceed the existing retirement deadline");
    }
    settlement = timeout.settled;
    markPluginRegistryRetired(reloaded);
    expect(resolve(reloaded)).toBeUndefined();
    expect(disposeModule).not.toHaveBeenCalled();
    expect(fs.existsSync(capturedPackage)).toBe(true);
    const rejected = expect(running).rejects.toThrow("reloaded or disabled");
    const observedRead = Promise.race([read.promise, running]);
    process.emit(`${event}:resume`);
    await expect(observedRead).resolves.toBe("1.0.0");
    await rejected;
    await settlement;
    expect(disposeModule).toHaveBeenCalledOnce();
    expect(fs.existsSync(capturedPackage)).toBe(false);
    vi.useRealTimers();

    writeVersion("2.0.0");
    const current = loadOpenClawPlugins(options);
    registries.push(current);
    const replacement = expectDefined(resolve(current), "replacement fixture harness").harness;
    expect(replacement).not.toBe(original);
    await expect(replacement.runAttempt({ ...params, prompt: "fresh" })).resolves.toMatchObject({
      terminal: { kind: "ok" },
      assistantTexts: ["2.0.0"],
    });
  } finally {
    process.emit(`${event}:resume`);
    await running?.catch(() => {});
    await settlement;
    vi.useRealTimers();
    for (const registry of registries.toReversed()) {
      await disposePluginRegistryInstances(registry);
    }
    process.off(`${event}:entered`, onEntered);
    process.off(`${event}:read`, onRead);
    resetPluginLoaderTestStateForTest();
  }
});
