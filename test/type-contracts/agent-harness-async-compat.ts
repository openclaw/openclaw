import type {
  createOpenClawCodingTools,
  createOpenClawCodingToolsAsync,
} from "openclaw/plugin-sdk/agent-harness";
import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { expectTypeOf } from "vitest";

// Retains synchronous harness factories from v2026.9.8 with awaited replacements.
type Host = AgentHarnessAttemptParamsV2["hostCapabilities"];
type SyncHostFactory = NonNullable<Host["createToolSurface"]>;
type AsyncHostFactory = NonNullable<Host["createToolSurfaceAsync"]>;
type PublicOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
type ReleasedHostFactory = (
  options: Omit<PublicOptions, "operationalRunInstance">,
  bindingOptions?: Readonly<{ cwd?: string }>,
) => AnyAgentTool[];
expectTypeOf<SyncHostFactory>().toExtend<ReleasedHostFactory>();
expectTypeOf<ReleasedHostFactory>().toExtend<SyncHostFactory>();
expectTypeOf<Parameters<AsyncHostFactory>>().toEqualTypeOf<Parameters<SyncHostFactory>>();
expectTypeOf<ReturnType<AsyncHostFactory>>().toEqualTypeOf<Promise<AnyAgentTool[]>>();
expectTypeOf<ReturnType<typeof createOpenClawCodingTools>>().toEqualTypeOf<AnyAgentTool[]>();
expectTypeOf<Parameters<typeof createOpenClawCodingToolsAsync>>().toEqualTypeOf<
  Parameters<typeof createOpenClawCodingTools>
>();
expectTypeOf<ReturnType<typeof createOpenClawCodingToolsAsync>>().toEqualTypeOf<
  Promise<AnyAgentTool[]>
>();
