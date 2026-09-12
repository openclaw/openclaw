import type { PluginInvocationInstance } from "./plugin-instance.types.js";

export type PluginInstanceInvocation = { instance: PluginInvocationInstance; token: object };

/** Each frame owner preserves its context when invocation admission enters or exits. */
export interface PluginExecutionFrame {
  readonly invocation: PluginInstanceInvocation | undefined;
  withInvocation(invocation: PluginInstanceInvocation): PluginExecutionFrame;
  withInvocation(invocation: undefined): PluginExecutionFrame | undefined;
}
