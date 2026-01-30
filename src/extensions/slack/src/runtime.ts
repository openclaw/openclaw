import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setSlackRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getSlackRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Slack runtime not initialized");
  }
  return runtime;
}
