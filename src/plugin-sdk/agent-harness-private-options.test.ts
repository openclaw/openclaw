import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook as wrapToolWithBeforeToolCallHookInternal } from "../agents/agent-tools.before-tool-call.js";
import { createOpenClawCodingTools as createCoreCodingTools } from "../agents/agent-tools.js";
import { getBeforeToolCallHookContext } from "../agents/before-tool-call-metadata.js";
import type { EmbeddedRunAttemptParams as CoreAttempt } from "../agents/embedded-agent-runner/run/types.js";
import * as toolSurfaceCore from "../agents/harness/tool-surface-bridge.js";
import type { SemanticNoProgressObserver } from "../agents/semantic-no-progress.js";
import { omitSemanticNoProgressObserver } from "../agents/tool-outcome-hooks.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptParamsV2,
  DeferredPluginToolApproval,
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptParamsV2,
} from "./agent-harness-runtime.js";
import { runBeforeToolCallHook, wrapToolWithBeforeToolCallHook } from "./agent-harness-runtime.js";
import {
  createAgentHarnessToolSurfaceRuntime,
  type AgentHarnessToolSurfaceRuntime,
  type AgentHarnessToolSurfaceRuntimeParams,
} from "./agent-harness-tool-runtime.js";
import { createOpenClawCodingTools } from "./agent-harness.js";
import type { createAgentHarnessHostCapabilitiesForTest } from "./plugin-test-runtime.js";

type PrivateControls =
  | "disableToolSearch"
  | "semanticNoProgressObserver"
  | "semanticStallReplanState"
  | "sessionReadScopeKey";
type CodingToolsOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
type HostToolsOptions = Parameters<
  NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]["createToolSurface"]>
>[0];
type HostTestAttempt = Parameters<typeof createAgentHarnessHostCapabilitiesForTest>[0]["attempt"];

describe("agent harness private options", () => {
  it("keeps run-owned controls out of every public attempt and tool-surface input", () => {
    type PublicInputs = {
      attempt: AgentHarnessAttemptParams;
      attemptV2: AgentHarnessAttemptParamsV2;
      embedded: EmbeddedRunAttemptParams;
      embeddedV2: EmbeddedRunAttemptParamsV2;
      toolSurface: AgentHarnessToolSurfaceRuntimeParams;
      codingTools: CodingToolsOptions;
      hostTools: HostToolsOptions;
      hostTest: HostTestAttempt;
    };
    expectTypeOf<
      {
        [I in keyof PublicInputs]: Extract<keyof PublicInputs[I], PrivateControls>;
      }[keyof PublicInputs]
    >().toEqualTypeOf<never>();
    expectTypeOf<AgentHarnessToolSurfaceRuntimeParams>().not.toHaveProperty(
      "forceCodeModeControls",
    );
    expectTypeOf<AgentHarnessToolSurfaceRuntime>().not.toHaveProperty("plan");
    expectTypeOf<
      NonNullable<Parameters<AgentHarnessToolSurfaceRuntime["compactTools"]>[1]>
    >().not.toHaveProperty("prepared");
    expectTypeOf<Pick<CoreAttempt, PrivateControls>>().toEqualTypeOf<{
      disableToolSearch?: true;
      semanticNoProgressObserver?: CoreAttempt["semanticNoProgressObserver"];
      semanticStallReplanState?: CoreAttempt["semanticStallReplanState"];
      sessionReadScopeKey?: string;
    }>();
    expectTypeOf<CodingToolsOptions>().toMatchTypeOf<
      NonNullable<Parameters<typeof createCoreCodingTools>[0]>
    >();
  });

  it("keeps the public factory on the existing shared implementation", () => {
    expect(createOpenClawCodingTools).toBe(createCoreCodingTools);
  });

  it("keeps the semantic observer out of public hook contexts while preserving internal ownership", () => {
    type PublicWrapContext = NonNullable<Parameters<typeof wrapToolWithBeforeToolCallHook>[1]>;
    type PublicHookContext = NonNullable<Parameters<typeof runBeforeToolCallHook>[0]["ctx"]>;
    type PublicDeferredContext = NonNullable<DeferredPluginToolApproval["ctx"]>;
    expectTypeOf<PublicWrapContext>().not.toHaveProperty("semanticNoProgressObserver");
    expectTypeOf<PublicHookContext>().not.toHaveProperty("semanticNoProgressObserver");
    expectTypeOf<PublicDeferredContext>().not.toHaveProperty("semanticNoProgressObserver");

    const observer = {} as SemanticNoProgressObserver;
    const tool: AnyAgentTool = {
      name: "public-wrapper-boundary",
      label: "Public wrapper boundary",
      description: "Public wrapper boundary test tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({ content: [], details: {} }),
    };
    const callerContext = {
      agentId: "sdk-public",
      semanticNoProgressObserver: observer,
    } as PublicWrapContext;
    const publicWrapped = wrapToolWithBeforeToolCallHook(tool, callerContext);
    expect(getBeforeToolCallHookContext(publicWrapped)).not.toHaveProperty(
      "semanticNoProgressObserver",
    );

    const internalWrapped = wrapToolWithBeforeToolCallHookInternal(tool, {
      agentId: "core-owner",
      semanticNoProgressObserver: observer,
    });
    expect(getBeforeToolCallHookContext(internalWrapped)).toMatchObject({
      semanticNoProgressObserver: observer,
    });
  });

  it("drops a runtime-injected semantic observer from caller tool options", () => {
    const observer = {} as SemanticNoProgressObserver;
    const callerOptions = { agentId: "sdk-public", semanticNoProgressObserver: observer };
    const safeOptions = omitSemanticNoProgressObserver(callerOptions);
    expect(safeOptions).not.toHaveProperty("semanticNoProgressObserver");
    expect(callerOptions.semanticNoProgressObserver).toBe(observer);
  });

  it("projects the public catalog without leaking private construction controls", () => {
    using create = vi.spyOn(toolSurfaceCore, "createAgentHarnessToolSurfaceRuntimeCore");
    const runtime = createAgentHarnessToolSurfaceRuntime({
      modelToolsEnabled: true,
      config: { tools: { toolSearch: true } },
      executeTool: async () => ({ content: [], details: {} }),
    });
    onTestFinished(runtime.cleanup);
    const internal = expectDefined(create.mock.results[0]?.value, "constructed core tool surface");
    using compact = vi.spyOn(internal, "compactTools");
    const publicOptions = { hookContext: { agentId: "sdk-public" }, localModelLeanApplied: true };
    const options = {
      ...publicOptions,
      prepared: { preserveToolNames: ["browser"] },
    };
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
});
