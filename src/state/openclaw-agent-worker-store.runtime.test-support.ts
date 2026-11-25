import { createTestEntrypoint } from "../infra/runtime-entrypoint.test-support.ts";

const entrypoint = createTestEntrypoint(import.meta.url, "state");

export const agentWorkerStoreFixtureEntrypoint = entrypoint(
  "openclaw-agent-worker-store.test-support",
);
