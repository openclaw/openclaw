import { createTestEntrypoint } from "./runtime-entrypoint.test-support.ts";

const entrypoint = createTestEntrypoint(import.meta.url, "infra");

export const nativeBoundaryTestEntrypoints = {
  unhandledRejections: entrypoint("unhandled-rejections"),
  pluginHooks: entrypoint("../plugins/hooks", "plugins/hooks.js"),
  emptyPluginRegistry: entrypoint("../plugins/registry-empty", "plugins/registry-empty.js"),
  cliProfile: entrypoint("../cli/profile", "cli/profile.js"),
  handoffProcess: entrypoint("update-managed-service-handoff-process"),
  handoffDatabase: entrypoint("update-managed-service-handoff-database"),
} as const;
