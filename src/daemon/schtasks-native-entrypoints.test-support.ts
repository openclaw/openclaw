import { createTestEntrypoint } from "../infra/runtime-entrypoint.test-support.ts";

const entrypoint = createTestEntrypoint(import.meta.url, "daemon");

// Native fixtures share the invocation's compiled runtime and nested process entries.
export const schtasksNativeEntrypoints = {
  taskSupervisor: entrypoint(
    "../cli/gateway-cli/task-supervisor",
    "cli/gateway-cli/task-supervisor.js",
  ),
  hostedStop: entrypoint("schtasks.hosted-stop.native-test-support"),
  startupFallback: entrypoint("schtasks-runtime"),
} as const;
