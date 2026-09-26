import { afterEach, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import * as sdkAlias from "./sdk-alias.js";

afterEach(() => vi.restoreAllMocks());

it("keeps version and injected instance surfaces independent of the broad runtime module", () => {
  const gateway = {} as PluginRuntime["gateway"];
  const hooks = {
    dispatchHookAgentTurn: vi.fn<PluginRuntime["hooks"]["dispatchHookAgentTurn"]>(),
  };
  const nodes = {} as PluginRuntime["nodes"];
  const subagent = {} as PluginRuntime["subagent"];
  const resolveGatewayContext = () => undefined;
  bindGatewayContextResolver(subagent, resolveGatewayContext);
  const resolveRuntimeModule = vi
    .spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics")
    .mockImplementation(() => {
      throw new Error("broad runtime should stay lazy");
    });
  const runtime = createLazyPluginRuntime({
    runtimeOptions: { gateway, hooks, nodes, subagent },
  });
  expect(getGatewayContextResolver(runtime)).toBe(resolveGatewayContext);

  expect(runtime.version).toBe(VERSION);
  expect(Object.getOwnPropertyDescriptor(runtime, "version")?.get?.()).toBe(VERSION);
  const descriptors = Object.getOwnPropertyDescriptors(runtime);
  expect(Object.keys(runtime)).toEqual([
    "version",
    "decisions",
    "gateway",
    "config",
    "agent",
    "subagent",
    "system",
    "media",
    "mediaUnderstanding",
    "tts",
    "channel",
    "events",
    "logging",
    "state",
    "modelAuth",
    "imageGeneration",
    "videoGeneration",
    "musicGeneration",
    "llm",
    "hooks",
    "nodes",
    "sandbox",
    "worktrees",
    "webSearch",
    "tasks",
    "modelConfig",
  ]);
  expect(Reflect.ownKeys(runtime)).toEqual(Reflect.ownKeys(descriptors));
  for (const key of Object.keys(descriptors)) {
    expect(key in runtime).toBe(true);
    expect(descriptors[key]).toMatchObject({ configurable: true, enumerable: true });
  }
  for (const [key, instance] of [
    ["gateway", gateway],
    ["hooks", hooks],
    ["nodes", nodes],
    ["subagent", subagent],
  ] as const) {
    expect(runtime[key]).toBe(instance);
    expect(descriptors[key]?.get?.()).toBe(instance);
    expect(Reflect.get(runtime, key, null)).toBe(instance);
    expect(Reflect.get(runtime, key, undefined)).toBe(instance);
  }
  expect(resolveRuntimeModule).not.toHaveBeenCalled();
  // Object.prototype names are not declared runtime metadata.
  expect(() => Reflect.has(runtime, "toString")).toThrow("broad runtime should stay lazy");
  expect(resolveRuntimeModule).toHaveBeenCalledTimes(1);
});

it("does not infer a Gateway owner by invoking an injected subagent accessor", () => {
  const subagent = {} as PluginRuntime["subagent"];
  bindGatewayContextResolver(subagent, () => undefined);
  const readSubagent = vi.fn(() => subagent);
  const resolveRuntimeModule = vi
    .spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics")
    .mockImplementation(() => {
      throw new Error("broad runtime should stay lazy");
    });
  const runtime = createLazyPluginRuntime({
    runtimeOptions: {
      get subagent() {
        return readSubagent();
      },
    },
  });
  expect(getGatewayContextResolver(runtime)).toBeUndefined();
  expect(readSubagent).not.toHaveBeenCalled();
  expect(resolveRuntimeModule).not.toHaveBeenCalled();
});
