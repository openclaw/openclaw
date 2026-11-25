import { createTestEntrypoint } from "../infra/runtime-entrypoint.test-support.ts";

const entrypoint = createTestEntrypoint(import.meta.url, "daemon");

export const serviceProcessEnvEntrypoints = {
  systemdExec: entrypoint("systemd-exec"),
  systemdLinger: entrypoint("systemd-linger"),
  systemdServiceFiles: entrypoint("systemd-service-files"),
  serviceEnvMerge: entrypoint("service-env-merge"),
} as const;
