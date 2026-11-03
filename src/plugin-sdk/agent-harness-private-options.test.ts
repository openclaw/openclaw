import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { expect, expectTypeOf, it, onTestFinished, vi } from "vitest";
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

it("keeps host-owned controls out of public attempt and tool inputs", () => {
  expectTypeOf<KeysIn<Attempts, "thinkingExplicit">>().toEqualTypeOf<never>();
  expectTypeOf<KeysIn<[Tools, AsyncTools], "requesterThinkingExplicit">>().toEqualTypeOf<never>();
  expectTypeOf<KeysIn<Attempts, "blindPrompt">>().toEqualTypeOf<never>();
  expectTypeOf<Pick<SurfaceParams, "trigger">>().toEqualTypeOf<{
    trigger?: Harness.AgentHarnessAttemptParamsV2["trigger"];
  }>();
  type HostTools = Options<NonNullable<Attempts[1]["hostCapabilities"]["createToolSurface"]>>;
  type HostTest = Parameters<typeof createAgentHarnessHostCapabilitiesForTest>[0]["attempt"];
  type Inputs = [...Attempts, SurfaceParams, Tools, HostTools, HostTest];
  expectTypeOf<KeysIn<Inputs, PrivateControls>>().toEqualTypeOf<never>();
  expectTypeOf<KeysIn<[SurfaceParams], "preparedToolOverrideAllowlist">>().toEqualTypeOf<never>();
  expectTypeOf<Surface>().not.toHaveProperty("plan");
  type CompactOptions = NonNullable<Parameters<Surface["compactTools"]>[1]>;
  expectTypeOf<CompactOptions>().not.toHaveProperty("prepared");
  type Hooks = "onProgressCardPlanSaved" | "authProfileStoreSource" | "onWebSearchConfiguration";
  expectTypeOf<KeysIn<[Tools], Hooks>>().toEqualTypeOf<never>();
  expectTypeOf<AsyncTools>().not.toHaveProperty("onWebSearchConfiguration");
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
});

it.each(["ok", "host failure", "both failures"] as const)(
  "keeps private test host close synchronous, memoized, and catchable (%s)",
  async (mode) => {
    const hostOwner = await import("../agents/harness/host-capability.js");
    const { createAgentHarnessHostCapabilitiesForTest: createHost } =
      await import("./plugin-test-runtime.js");
    const { harnessHostAdmissionsForTest } =
      await import("../agents/harness/host-capability.test-support.js");
    const { getAdmittedRunDelegatedAuthority } = await import("../agents/admitted-run-context.js");
    const create = hostOwner.createAgentHarnessHostCapabilities;
    const hostFailure = new Error("Controlled host close failure");
    const admissionFailure = new Error("Controlled admission close failure");
    let closeCalls = 0;
    let reentered: Promise<void> | undefined;
    using factory = vi
      .spyOn(hostOwner, "createAgentHarnessHostCapabilities")
      .mockImplementationOnce((params) => {
        const host = create(params);
        return {
          ...host,
          close: () => {
            closeCalls += 1;
            host.close();
            if (closeCalls === 1) {
              reentered = closeAgain?.();
            }
            if (mode !== "ok") {
              throw hostFailure;
            }
          },
        };
      });
    const host = await createHost({
      attempt: { runId: "private-close-contract" },
      pluginId: "fixture",
    });
    expect(factory).toHaveBeenCalledOnce();
    const admission = harnessHostAdmissionsForTest.get(host.capabilities)!;
    onTestFinished(admission.close);
    if (mode === "both failures") {
      const closeAdmission = admission.close;
      admission.close = () => {
        closeAdmission();
        throw admissionFailure;
      };
    }
    const closeAgain = host.close;
    let closing: Promise<void> | undefined;
    expect(() => {
      closing = host.close();
    }).not.toThrow();
    expect(closing).toBeInstanceOf(Promise);
    expect(host.close()).toBe(closing);
    expect(reentered).toBe(closing);
    expect(closeCalls).toBe(1);
    expect(() => host.capabilities.assertActive()).toThrow("no longer active");
    expect(harnessHostAdmissionsForTest.has(host.capabilities)).toBe(false);
    expect(getAdmittedRunDelegatedAuthority(admission.admittedRunContext)).toBeUndefined();
    if (mode === "both failures") {
      await expect(closing).rejects.toMatchObject({ errors: [hostFailure, admissionFailure] });
    } else if (mode === "host failure") {
      await expect(closing).rejects.toBe(hostFailure);
    } else {
      await expect(closing).resolves.toBeUndefined();
    }
  },
);
