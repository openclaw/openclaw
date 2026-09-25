import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

export async function withSessionDeliveryQueue(
  run: (stateDir: string, queueContext: OpenClawStateWorkerContext) => Promise<void>,
): Promise<void> {
  await withTestDir({ prefix: "openclaw-session-delivery-" }, async (stateDir) => {
    const queueContext = captureOpenClawStateWorkerContext({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    try {
      await run(stateDir, queueContext);
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(queueContext.admission.databasePath);
    }
  });
}
