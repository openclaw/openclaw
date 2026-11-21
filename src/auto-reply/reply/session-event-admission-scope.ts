import { runWithAgentWorkspaceReadiness } from "../../agents/workspace-readiness.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context-store.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { createLazyRuntimeNamedExport } from "../../shared/lazy-runtime.js";

// Enter auth/plugin preparation only in admitted async work.
const loadGenerationReadmission = createLazyRuntimeNamedExport(
  () => import("./queue/drain-admission-scope.js"),
  "runOutsideAdmittedGenerationScopes",
);

export function runInSessionEventAdmissionScope<T>(
  run: () => Promise<T>,
  onAdmissionStarted: () => void,
): Promise<T> {
  return runWithoutOwnedSessionTranscriptWrites(() =>
    runWithGatewayDetachedWorkContinuation(async () => {
      onAdmissionStarted();
      const runOutsideAdmittedGenerationScopes = await loadGenerationReadmission();
      // A wake admits a new turn; the producer's workspace preparation belongs to its old run.
      return runOutsideAdmittedGenerationScopes(() =>
        runWithAgentWorkspaceReadiness(undefined, run),
      );
    }, "session:event"),
  );
}
