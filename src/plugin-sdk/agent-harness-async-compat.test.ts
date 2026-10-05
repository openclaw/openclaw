import type {
  createOpenClawCodingTools,
  createOpenClawCodingToolsAsync,
} from "openclaw/plugin-sdk/agent-harness";
import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { expectTypeOf, it } from "vitest";

it("retains synchronous harness factories from v2026.9.8 with awaited replacements", () => {
  type Host = AgentHarnessAttemptParamsV2["hostCapabilities"];
  type SyncHostFactory = NonNullable<Host["createToolSurface"]>;
  type AsyncHostFactory = NonNullable<Host["createToolSurfaceAsync"]>;
  type PublicOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
  type ReleasedHostFactory = (
    options: Omit<PublicOptions, "operationalRunInstance">,
    bindingOptions?: Readonly<{ cwd?: string }>,
  ) => AnyAgentTool[];
  expectTypeOf<SyncHostFactory>().toEqualTypeOf<ReleasedHostFactory>();
  expectTypeOf<Parameters<AsyncHostFactory>>().toEqualTypeOf<Parameters<ReleasedHostFactory>>();
  expectTypeOf<ReturnType<AsyncHostFactory>>().toEqualTypeOf<Promise<AnyAgentTool[]>>();
  expectTypeOf<ReturnType<typeof createOpenClawCodingTools>>().toEqualTypeOf<AnyAgentTool[]>();
  expectTypeOf<Parameters<typeof createOpenClawCodingToolsAsync>>().toEqualTypeOf<
    Parameters<typeof createOpenClawCodingTools>
  >();
  expectTypeOf<ReturnType<typeof createOpenClawCodingToolsAsync>>().toEqualTypeOf<
    Promise<AnyAgentTool[]>
  >();
});
