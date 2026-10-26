import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { expect, expectTypeOf, it, onTestFinished, vi } from "vitest";
import { createOpenClawCodingTools as createCoreCodingTools } from "../agents/agent-tools.js";
import type { EmbeddedRunAttemptParams as CoreAttempt } from "../agents/embedded-agent-runner/run/types.js";
import * as toolSurfaceCore from "../agents/harness/tool-surface-bridge.js";
import type * as Harness from "./agent-harness-runtime.js";
import {
  createAgentHarnessToolSurfaceRuntime as createSync,
  createAgentHarnessToolSurfaceRuntimeAsync as createAsync,
  type AgentHarnessToolSurfaceRuntime as Surface,
  type AgentHarnessToolSurfaceRuntimeParams as SurfaceParams,
} from "./agent-harness-tool-runtime.js";
import { createOpenClawCodingTools, createOpenClawCodingToolsAsync } from "./agent-harness.js";
import type { createAgentHarnessHostCapabilitiesForTest } from "./plugin-test-runtime.js";

type PrivateControls = "disableToolSearch" | "sessionReadScopeKey";
type Options<F extends (...args: never[]) => unknown> = NonNullable<Parameters<F>[0]>;
type Tools = Options<typeof createOpenClawCodingTools>;
type AsyncTools = Options<typeof createOpenClawCodingToolsAsync>;
type Attempts = [
  Harness.AgentHarnessAttemptParams,
  Harness.AgentHarnessAttemptParamsV2,
  Harness.EmbeddedRunAttemptParams,
  Harness.EmbeddedRunAttemptParamsV2,
];
type KeysIn<T extends unknown[], K extends PropertyKey> = {
  [I in keyof T]: Extract<keyof T[I], K>;
}[number];
const execute = async () => ({ content: [], details: {} });
const factories = { sync: createSync, async: createAsync };
async function surface(mode: "sync" | "async", config: SurfaceParams["config"]) {
  const params = { modelToolsEnabled: true, config, executeTool: execute };
  const runtime = await factories[mode](params);
  onTestFinished(runtime.cleanup);
  return runtime;
}

it("keeps thinking provenance out of public attempt and tool inputs", () => {
  expectTypeOf<KeysIn<Attempts, "thinkingExplicit">>().toEqualTypeOf<never>();
  expectTypeOf<KeysIn<[Tools, AsyncTools], "requesterThinkingExplicit">>().toEqualTypeOf<never>();
});

it("keeps the host-owned blind prompt flag out of public attempts", () => {
  expectTypeOf<KeysIn<Attempts, "blindPrompt">>().toEqualTypeOf<never>();
  expectTypeOf<Pick<CoreAttempt, "blindPrompt">>().toEqualTypeOf<{ blindPrompt?: true }>();
});

it("accepts the optional host run trigger for tool presentation", () => {
  expectTypeOf<Pick<SurfaceParams, "trigger">>().toEqualTypeOf<{
    trigger?: Harness.AgentHarnessAttemptParamsV2["trigger"];
  }>();
});

it("keeps Side chat controls out of every public attempt and tool-surface input", () => {
  type HostTools = Options<NonNullable<Attempts[1]["hostCapabilities"]["createToolSurface"]>>;
  type HostTest = Parameters<typeof createAgentHarnessHostCapabilitiesForTest>[0]["attempt"];
  type Inputs = [...Attempts, SurfaceParams, Tools, HostTools, HostTest];
  expectTypeOf<KeysIn<Inputs, PrivateControls>>().toEqualTypeOf<never>();
  expectTypeOf<
    KeysIn<[SurfaceParams], "forceCodeModeControls" | "preparedToolOverrideAllowlist">
  >().toEqualTypeOf<never>();
  expectTypeOf<Surface>().not.toHaveProperty("plan");
  type CompactOptions = NonNullable<Parameters<Surface["compactTools"]>[1]>;
  expectTypeOf<CompactOptions>().not.toHaveProperty("prepared");
  expectTypeOf<Pick<CoreAttempt, PrivateControls>>().toEqualTypeOf<{
    disableToolSearch?: true;
    sessionReadScopeKey?: string;
  }>();
  type Hooks = "onProgressCardPlanSaved" | "authProfileStoreSource" | "onWebSearchConfiguration";
  expectTypeOf<KeysIn<[Tools], Hooks>>().toEqualTypeOf<never>();
  expectTypeOf<AsyncTools>().not.toHaveProperty("onWebSearchConfiguration");
  expectTypeOf<Tools>().toMatchTypeOf<Options<typeof createCoreCodingTools>>();
});

it("keeps the public factory on the existing shared implementation", () => {
  expect(createOpenClawCodingTools).toBe(createCoreCodingTools);
});

it("preserves explicitly allowed tools in an asynchronously prepared lean surface", async () => {
  const runtime = await surface("async", {
    agents: { defaults: { experimental: { localModelLean: true } } },
    tools: { allow: ["browser"], codeMode: false, toolSearch: false },
  });
  const tools = ["browser", "tts"].map((name) => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute,
  }));
  expect(runtime.compactTools(tools).tools.map((tool) => tool.name)).toEqual(["browser"]);
});

it.each(["sync", "async"] as const)("projects only public %s controls", async (mode) => {
  using create = vi.spyOn(toolSurfaceCore, "createAgentHarnessToolSurfaceRuntimeCore");
  const runtime = await surface(mode, { tools: { toolSearch: true } });
  const internal = expectDefined(create.mock.results[0]?.value, "core surface");
  using compact = vi.spyOn(internal, "compactTools");
  const publicOptions = { hookContext: { agentId: "sdk-public" }, localModelLeanApplied: true };
  const options = { ...publicOptions, prepared: { preserveToolNames: ["browser"] } };
  const result = runtime.compactTools([], options);
  expect(runtime).not.toHaveProperty("plan");
  expect(compact).toHaveBeenCalledExactlyOnceWith([], publicOptions);
  expect(Object.keys(result)).toEqual(["tools", "promptToolPolicy"]);
  expect(result.tools).toBe(compact.mock.results[0]?.value.tools);
  expect(result.promptToolPolicy).toBe(compact.mock.results[0]?.value.promptToolPolicy);
  for (const key of ["cleanup", "toolSearchCatalogRef", "toolSearchCatalogExecutor"] as const) {
    expect(runtime[key]).toBe(internal[key]);
  }
});
