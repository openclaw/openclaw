import { createBrokerExecaAdmissionFailure } from "./execa-protocol.js";
import { serializeBrokerError, type BrokerResponse, type SpawnBrokerError } from "./protocol.js";
import type { BrokerBootstrap } from "./resource-protocol.js";

// An update can replace the installed chunks after readiness. Retain every command
// this mode can serve while its originating package still exists.
export async function captureBrokerCommandHandlers(bootstrap: BrokerBootstrap) {
  if (bootstrap.nativeResource?.attachmentsOnly) {
    return undefined;
  }
  const canReadFiles = !bootstrap.nativeResource;
  const [{ startBrokerExeca }, file, page] = await Promise.all([
    import("./execa-worker.js"),
    canReadFiles ? import("@openclaw/fs-safe/advanced") : undefined,
    canReadFiles ? import("../../agents/sessions/tools/read-file-page.js") : undefined,
  ]);
  return {
    startBrokerExeca,
    readers:
      file && page
        ? { readRegularFile: file.readRegularFile, captureReadFilePage: page.captureReadFilePage }
        : undefined,
  };
}

export async function reportBrokerCommandRefusal(
  id: number,
  error: SpawnBrokerError,
  report: (message: BrokerResponse) => Promise<void>,
): Promise<void> {
  // The ordered failed-admission result proves no native work was started.
  // No command metadata exists because this guard precedes spawn preparation.
  await report({
    type: "execa-result",
    id,
    result: createBrokerExecaAdmissionFailure(error),
  });
  await report({
    type: "error",
    id,
    error: serializeBrokerError(error),
    resultUnavailable: true,
  });
}
