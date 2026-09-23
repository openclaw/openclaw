import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { SessionEntryLifecycleReadRequest } from "./session-accessor.sqlite-lifecycle-read.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

export function readSessionEntryLifecycleInWorker(
  options: OpenClawAgentDatabaseOptions,
  request: SessionEntryLifecycleReadRequest,
) {
  return withSessionHistoryWorkerDatabase(
    options,
    async (owner) => {
      const result = await owner.readLifecycle({ request, env: { ...options.env } });
      owner.assertCurrent();
      return result;
    },
    maintenanceLane,
  );
}
