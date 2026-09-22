import { describe, expect, expectTypeOf, it } from "vitest";
import { createOpenClawCodingTools as createCoreCodingTools } from "../agents/agent-tools.js";
import type { EmbeddedRunAttemptParams as CoreAttempt } from "../agents/embedded-agent-runner/run/types.js";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptParamsV2,
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptParamsV2,
} from "./agent-harness-runtime.js";
import type { AgentHarnessToolSurfaceRuntimeParams } from "./agent-harness-tool-runtime.js";
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
    expectTypeOf<
      Extract<keyof AgentHarnessAttemptParams, PrivateControls>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof AgentHarnessAttemptParamsV2, PrivateControls>
    >().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof EmbeddedRunAttemptParams, PrivateControls>>().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof EmbeddedRunAttemptParamsV2, PrivateControls>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof AgentHarnessToolSurfaceRuntimeParams, PrivateControls>
    >().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof CodingToolsOptions, PrivateControls>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof HostToolsOptions, PrivateControls>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof HostTestAttempt, PrivateControls>>().toEqualTypeOf<never>();
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
});
