import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";

export type AsyncDebugProxyCaptureReader = {
  getSessionEvents(sessionId: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  readBlob(blobId: string): Promise<string | null>;
};

/** Capture the read target without opening or creating its database. */
export function createDebugProxyCaptureReaderAsync(params: {
  env: NodeJS.ProcessEnv;
}): AsyncDebugProxyCaptureReader {
  const context = captureOpenClawStateWorkerContext({ env: params.env });
  return {
    async getSessionEvents(sessionId, limit) {
      const result = await executeExistingOpenClawStateRead(
        { env: context.environment, path: context.admission.databasePath },
        { type: "capture.readOnlyEvents", sessionId, limit },
        { context },
      );
      context.admission.assertCurrent();
      if (result && (!result.ok || result.type !== "capture.readOnlyEvents")) {
        throw new Error("Unexpected capture events read result");
      }
      return result?.events ?? [];
    },
    async readBlob(blobId) {
      const result = await executeExistingOpenClawStateRead(
        { env: context.environment, path: context.admission.databasePath },
        { type: "capture.readOnlyBlob", blobId },
        { context },
      );
      context.admission.assertCurrent();
      if (result && (!result.ok || result.type !== "capture.readOnlyBlob")) {
        throw new Error("Unexpected capture blob read result");
      }
      return result?.blob ?? null;
    },
  };
}
