import { expectTypeOf } from "vitest";
import type {
  resolveSandboxContext,
  SandboxContext,
} from "../../src/plugin-sdk/agent-harness-runtime.js";
import type { PluginRuntime } from "../../src/plugins/runtime/types.js";

type Resolve = typeof resolveSandboxContext;
type Prepare = PluginRuntime["sandbox"]["prepareWorkspaceAuthority"];

// Released callers supply no process-owner capability. The host owns runtime admission.
expectTypeOf({}).toMatchTypeOf<Parameters<Resolve>[0]>();
expectTypeOf<ReturnType<Resolve>>().toEqualTypeOf<Promise<SandboxContext | null>>();
expectTypeOf<
  Pick<Parameters<Resolve>[0], "assertCurrent" | "requireCurrentConfig">
>().toEqualTypeOf<{
  assertCurrent?: () => void;
  requireCurrentConfig?: boolean;
}>();
expectTypeOf<{
  config: Parameters<Prepare>[0]["config"];
  sessionKey: string;
  workspaceDir: string;
}>().toMatchTypeOf<Parameters<Prepare>[0]>();
expectTypeOf<ReturnType<Prepare>>().toEqualTypeOf<
  Promise<{
    sandboxed: boolean;
    workspaceAccess: "none" | "ro" | "rw";
    confinementError?: string;
  }>
>();
