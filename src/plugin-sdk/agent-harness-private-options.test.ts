import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from "vitest";
import { createOpenClawCodingTools as createCoreCodingTools } from "../agents/agent-tools.js";
import type { EmbeddedRunAttemptParams as CoreAttempt } from "../agents/embedded-agent-runner/run/types.js";
import * as toolSurfaceCore from "../agents/harness/tool-surface-bridge.js";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptParamsV2,
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptParamsV2,
} from "./agent-harness-runtime.js";
import {
  createAgentHarnessToolSurfaceRuntime,
  type AgentHarnessToolSurfaceRuntime,
  type AgentHarnessToolSurfaceRuntimeParams,
} from "./agent-harness-tool-runtime.js";
import { createOpenClawCodingTools } from "./agent-harness.js";
import type { createAgentHarnessHostCapabilitiesForTest } from "./plugin-test-runtime.js";

type PrivateControls = "disableToolSearch" | "sessionReadScopeKey";
type CodingToolsOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
type HostToolsOptions = Parameters<
  NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]["createToolSurface"]>
>[0];
type HostTestAttempt = Parameters<typeof createAgentHarnessHostCapabilitiesForTest>[0]["attempt"];

describe("agent harness private options", () => {
  it("keeps Side chat controls out of every public attempt and tool-surface input", () => {
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
      sessionReadScopeKey?: string;
    }>();
    expectTypeOf<CodingToolsOptions>().toMatchTypeOf<
      NonNullable<Parameters<typeof createCoreCodingTools>[0]>
    >();
  });

  it("keeps the public factory on the existing shared implementation", () => {
    expect(createOpenClawCodingTools).toBe(createCoreCodingTools);
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
